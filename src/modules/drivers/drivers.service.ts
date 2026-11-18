import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DriverStatus,
  InvitationStatus,
  MembershipStatus,
  Prisma,
  RouteStatus,
  UserRole,
} from '@prisma/client';
import type { Driver, DriverInvitation } from '@prisma/client';
import { AuthTokenPayload } from '../../common/auth/token.service';
import { HashingService } from '../../common/hashing/hashing.service';
import { InvitationTokenService } from '../../common/invitations/invitation-token.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AcceptDriverInvitationDto } from './dto/accept-driver-invitation.dto';
import { ChangeDriverStatusDto } from './dto/change-driver-status.dto';
import { CreateDriverDto } from './dto/create-driver.dto';
import { parseDateOnly } from './dto/date-only.validator';
import { ListDriversQueryDto } from './dto/list-drivers-query.dto';
import { UpdateDriverDto } from './dto/update-driver.dto';

type Tx = Prisma.TransactionClient;

const BUS_REF = { id: true, code: true, plateNumber: true } as const;

const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

export const DRIVER_ID_PREFIX = 'DRV-';
/** Licences expiring within this many days are flagged "expiring soon". */
export const LICENSE_WARNING_DAYS = 30;

export function formatDriverId(n: number): string {
  return `${DRIVER_ID_PREFIX}${String(n).padStart(6, '0')}`;
}

/** Start of today (UTC) — licence expiry is a date, not a timestamp. */
function today(): Date {
  const d = new Date();
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

export type LicenseState = 'EXPIRED' | 'EXPIRING_SOON' | 'VALID';

export function licenseState(expiry: Date, now = today()): LicenseState {
  if (expiry < now) return 'EXPIRED';
  if (expiry <= addDays(now, LICENSE_WARNING_DAYS)) return 'EXPIRING_SOON';
  return 'VALID';
}

/**
 * Allowed manual status changes. INVITED → ACTIVE only happens by the driver
 * accepting their invitation; INVITED → INACTIVE cancels the invitation.
 */
const TRANSITIONS: Record<DriverStatus, DriverStatus[]> = {
  INVITED: [DriverStatus.INACTIVE],
  ACTIVE: [DriverStatus.SUSPENDED, DriverStatus.INACTIVE],
  SUSPENDED: [DriverStatus.ACTIVE, DriverStatus.INACTIVE],
  INACTIVE: [DriverStatus.ACTIVE],
};

/** Membership status that mirrors each driver status (once an account exists). */
const MEMBERSHIP_FOR: Record<DriverStatus, MembershipStatus> = {
  INVITED: MembershipStatus.DEACTIVATED,
  ACTIVE: MembershipStatus.ACTIVE,
  SUSPENDED: MembershipStatus.SUSPENDED,
  INACTIVE: MembershipStatus.DEACTIVATED,
};

@Injectable()
export class DriversService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hashing: HashingService,
    private readonly tokens: InvitationTokenService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  private requireSchool(user: AuthTokenPayload): string {
    if (!user.schoolId) {
      throw new ForbiddenException('No school associated with this account');
    }
    return user.schoolId;
  }

  private invitationTtlMs(): number {
    const hours = Number(
      this.config.get<string>('INVITATION_TTL_HOURS', '168') ?? 168,
    );
    return (Number.isFinite(hours) ? hours : 168) * 60 * 60 * 1000;
  }

  // ---------------------------------------------------------------------------
  // Create + invite
  // ---------------------------------------------------------------------------

  async create(actor: AuthTokenPayload, dto: CreateDriverDto) {
    const schoolId = this.requireSchool(actor);
    const email = dto.email.toLowerCase();

    // The invitation creates a login with this email, so it must be free.
    const existingUser = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existingUser) {
      throw new ConflictException(
        'This email already belongs to an Àjò account. Use a different email for the driver.',
      );
    }

    const { token, hash } = this.tokens.generate();

    const driver = await this.prisma.$transaction(async (tx) => {
      await this.assertUnique(tx, schoolId, {
        email,
        licenseNumber: dto.licenseNumber,
      });
      const driverId = await this.allocateDriverId(tx, schoolId);
      const created = await tx.driver.create({
        data: {
          driverId,
          schoolId,
          email,
          ...this.profileData(dto),
          firstName: dto.firstName,
          lastName: dto.lastName,
          phone: dto.phone,
          licenseNumber: dto.licenseNumber,
          licenseExpiry: parseDateOnly(dto.licenseExpiry)!,
          status: DriverStatus.INVITED,
          createdById: actor.sub,
        },
      });
      await tx.driverInvitation.create({
        data: {
          schoolId,
          driverId: created.id,
          email,
          tokenHash: hash,
          expiresAt: new Date(Date.now() + this.invitationTtlMs()),
          invitedById: actor.sub,
        },
      });
      return created;
    }, TRANSACTION_OPTIONS);

    await this.audit.log({
      actorId: actor.sub,
      schoolId,
      action: AuditAction.DriverCreated,
      targetType: 'Driver',
      targetId: driver.id,
      metadata: { driverId: driver.driverId, email },
    });

    await this.sendInvite(driver, schoolId, token);
    return this.findOne(actor, driver.id);
  }

  /**
   * Revokes any pending invitation and emails a fresh link. Also re-opens a
   * cancelled invitation (INACTIVE, never accepted) by moving it back to INVITED.
   */
  async resendInvitation(actor: AuthTokenPayload, id: string) {
    const schoolId = this.requireSchool(actor);
    const driver = await this.getOwned(schoolId, id);
    const reopening = driver.status === DriverStatus.INACTIVE && !driver.userId;
    if (driver.status !== DriverStatus.INVITED && !reopening) {
      throw new BadRequestException(
        'Only drivers who have not set up their account can be re-invited',
      );
    }
    if (reopening) {
      // The address may have been taken by another account in the meantime.
      const taken = await this.prisma.user.findUnique({
        where: { email: driver.email },
        select: { id: true },
      });
      if (taken) {
        throw new ConflictException(
          "This driver's email now belongs to another account. Edit the driver's email first.",
        );
      }
    }

    const { token, hash } = this.tokens.generate();
    await this.prisma.$transaction(async (tx) => {
      if (reopening) {
        await tx.driver.update({
          where: { id: driver.id },
          data: { status: DriverStatus.INVITED },
        });
      }
      await tx.driverInvitation.updateMany({
        where: { driverId: driver.id, status: InvitationStatus.PENDING },
        data: { status: InvitationStatus.REVOKED },
      });
      await tx.driverInvitation.create({
        data: {
          schoolId,
          driverId: driver.id,
          email: driver.email,
          tokenHash: hash,
          expiresAt: new Date(Date.now() + this.invitationTtlMs()),
          invitedById: actor.sub,
        },
      });
    }, TRANSACTION_OPTIONS);

    await this.audit.log({
      actorId: actor.sub,
      schoolId,
      action: AuditAction.DriverInvitationResent,
      targetType: 'Driver',
      targetId: driver.id,
      metadata: { driverId: driver.driverId, email: driver.email },
    });

    await this.sendInvite(driver, schoolId, token);
    return this.findOne(actor, driver.id);
  }

  private async sendInvite(driver: Driver, schoolId: string, token: string) {
    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
      select: { id: true, name: true },
    });
    if (school) {
      await this.notifications.notifyDriverInvited(
        { firstName: driver.firstName, email: driver.email },
        school,
        token,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  async findAll(actor: AuthTokenPayload, query: ListDriversQueryDto) {
    const schoolId = this.requireSchool(actor);
    const { search, status, license, page = 1, limit = 20 } = query;
    const now = today();
    const soon = addDays(now, LICENSE_WARNING_DAYS);

    const terms = (search ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 5);

    const where: Prisma.DriverWhereInput = {
      schoolId,
      ...(status && { status }),
      ...(license === 'EXPIRED' && { licenseExpiry: { lt: now } }),
      ...(license === 'EXPIRING_SOON' && {
        licenseExpiry: { gte: now, lte: soon },
      }),
      ...(license === 'VALID' && { licenseExpiry: { gt: soon } }),
      ...(terms.length && {
        AND: terms.map((t) => ({
          OR: [
            { firstName: { contains: t, mode: 'insensitive' as const } },
            { lastName: { contains: t, mode: 'insensitive' as const } },
            { driverId: { contains: t, mode: 'insensitive' as const } },
            { email: { contains: t, mode: 'insensitive' as const } },
            { phone: { contains: t } },
            { licenseNumber: { contains: t, mode: 'insensitive' as const } },
          ],
        })),
      }),
    };

    const [rows, total] = await Promise.all([
      this.prisma.driver.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { bus: { select: BUS_REF } },
      }),
      this.prisma.driver.count({ where }),
    ]);

    return {
      data: rows.map((d) => this.toView(d)),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(actor: AuthTokenPayload, id: string) {
    const schoolId = this.requireSchool(actor);
    const driver = await this.prisma.driver.findFirst({
      where: { id, schoolId },
      include: {
        invitations: { orderBy: { createdAt: 'desc' }, take: 1 },
        createdBy: { select: { firstName: true, lastName: true } },
        bus: { select: BUS_REF },
      },
    });
    if (!driver) throw new NotFoundException('Driver not found');

    const { invitations, createdBy, ...rest } = driver;
    const latest = invitations[0];
    return {
      ...this.toView(rest),
      createdByName: createdBy
        ? `${createdBy.firstName} ${createdBy.lastName}`
        : null,
      invitation: latest ? this.toSafeInvitation(latest) : null,
    };
  }

  /** Counts for the drivers page header and the school dashboard. */
  async summary(actor: AuthTokenPayload) {
    const schoolId = this.requireSchool(actor);
    return this.summaryFor(schoolId);
  }

  async summaryFor(schoolId: string) {
    const now = today();
    const soon = addDays(now, LICENSE_WARNING_DAYS);
    // Licence warnings only matter for drivers who can still drive.
    const working = {
      schoolId,
      status: { in: [DriverStatus.ACTIVE, DriverStatus.INVITED] },
    };
    const [byStatus, licenseExpired, licenseExpiringSoon] = await Promise.all([
      this.prisma.driver.groupBy({
        by: ['status'],
        where: { schoolId },
        _count: { _all: true },
      }),
      this.prisma.driver.count({
        where: { ...working, licenseExpiry: { lt: now } },
      }),
      this.prisma.driver.count({
        where: { ...working, licenseExpiry: { gte: now, lte: soon } },
      }),
    ]);

    const counts = Object.fromEntries(
      Object.values(DriverStatus).map((s) => [s, 0]),
    ) as Record<DriverStatus, number>;
    for (const row of byStatus) counts[row.status] = row._count._all;

    return {
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      byStatus: counts,
      licenseExpired,
      licenseExpiringSoon,
    };
  }

  // ---------------------------------------------------------------------------
  // Update
  // ---------------------------------------------------------------------------

  async update(actor: AuthTokenPayload, id: string, dto: UpdateDriverDto) {
    const schoolId = this.requireSchool(actor);
    const existing = await this.getOwned(schoolId, id);

    const email = dto.email?.toLowerCase();
    const emailChanged = email !== undefined && email !== existing.email;
    if (emailChanged && existing.userId) {
      throw new BadRequestException(
        "A driver's email can't be changed after they have set up their account",
      );
    }
    if (emailChanged) {
      const taken = await this.prisma.user.findUnique({
        where: { email },
        select: { id: true },
      });
      if (taken) {
        throw new ConflictException(
          'This email already belongs to an Àjò account',
        );
      }
    }

    const data: Prisma.DriverUpdateInput = {
      ...this.profileData(dto),
      ...(dto.firstName !== undefined && { firstName: dto.firstName }),
      ...(dto.lastName !== undefined && { lastName: dto.lastName }),
      ...(dto.phone !== undefined && { phone: dto.phone }),
      ...(dto.licenseNumber !== undefined && {
        licenseNumber: dto.licenseNumber,
      }),
      ...(dto.licenseExpiry !== undefined && {
        licenseExpiry: parseDateOnly(dto.licenseExpiry)!,
      }),
      ...(emailChanged && { email }),
    };
    const fields = Object.keys(data);
    if (!fields.length) return this.findOne(actor, id);

    await this.prisma.$transaction(async (tx) => {
      await this.assertUnique(
        tx,
        schoolId,
        {
          email: emailChanged ? email : undefined,
          licenseNumber:
            dto.licenseNumber !== undefined &&
            dto.licenseNumber !== existing.licenseNumber
              ? dto.licenseNumber
              : undefined,
        },
        id,
      );
      await tx.driver.update({ where: { id }, data });
      // Keep the pending invitation pointed at the new address.
      if (emailChanged) {
        await tx.driverInvitation.updateMany({
          where: { driverId: id, status: InvitationStatus.PENDING },
          data: { email },
        });
      }
    }, TRANSACTION_OPTIONS);

    await this.audit.log({
      actorId: actor.sub,
      schoolId,
      action: AuditAction.DriverUpdated,
      targetType: 'Driver',
      targetId: id,
      metadata: { driverId: existing.driverId, fields },
    });

    return this.findOne(actor, id);
  }

  async changeStatus(
    actor: AuthTokenPayload,
    id: string,
    dto: ChangeDriverStatusDto,
  ) {
    const schoolId = this.requireSchool(actor);
    const driver = await this.getOwned(schoolId, id);
    const from = driver.status;
    const to = dto.status;

    if (from === to) return this.findOne(actor, id);
    if (!TRANSITIONS[from].includes(to)) {
      throw new BadRequestException(
        from === DriverStatus.INVITED
          ? 'This driver has not accepted their invitation yet. They become active when they set up their account.'
          : `A ${from.toLowerCase()} driver can't be set to ${to.toLowerCase()}`,
      );
    }
    // Reactivating someone who never accepted would leave them with no login.
    if (to === DriverStatus.ACTIVE && !driver.userId) {
      throw new BadRequestException(
        'This driver never set up their account. Send them a new invitation instead.',
      );
    }

    const removedFromBus = await this.prisma.$transaction(async (tx) => {
      await tx.driver.update({ where: { id }, data: { status: to } });
      // A driver who has left no longer drives a bus (M5).
      let bus: { id: string; code: string } | null = null;
      if (to === DriverStatus.INACTIVE) {
        bus = await tx.bus.findUnique({
          where: { driverId: id },
          select: { id: true, code: true },
        });
        if (bus)
          await tx.bus.update({
            where: { id: bus.id },
            data: { driverId: null },
          });
      }
      if (from === DriverStatus.INVITED) {
        // Cancelling: the outstanding link must stop working.
        await tx.driverInvitation.updateMany({
          where: { driverId: id, status: InvitationStatus.PENDING },
          data: { status: InvitationStatus.REVOKED },
        });
      }
      if (driver.userId) {
        // The RolesGuard checks membership status on every request, so this
        // locks a suspended/inactive driver out immediately.
        await tx.schoolMembership.updateMany({
          where: { userId: driver.userId, schoolId, role: UserRole.DRIVER },
          data: { status: MEMBERSHIP_FOR[to] },
        });
      }
      return bus;
    }, TRANSACTION_OPTIONS);

    if (removedFromBus) {
      await this.audit.log({
        actorId: actor.sub,
        schoolId,
        action: AuditAction.DriverRemovedFromBus,
        targetType: 'Bus',
        targetId: removedFromBus.id,
        metadata: {
          driverId: driver.driverId,
          bus: removedFromBus.code,
          reason: 'driver deactivated',
        },
      });
    }

    await this.audit.log({
      actorId: actor.sub,
      schoolId,
      action: AuditAction.DriverStatusChanged,
      targetType: 'Driver',
      targetId: id,
      metadata: {
        driverId: driver.driverId,
        from,
        to,
        ...(dto.reason && { reason: dto.reason }),
      },
    });

    return this.findOne(actor, id);
  }

  // ---------------------------------------------------------------------------
  // Public invitation flow
  // ---------------------------------------------------------------------------

  private async findPendingInvitation(token: string) {
    const invitation = await this.prisma.driverInvitation.findUnique({
      where: { tokenHash: this.tokens.hash(token) },
      include: {
        school: { select: { id: true, name: true } },
        driver: true,
      },
    });
    if (!invitation || invitation.status !== InvitationStatus.PENDING) {
      throw new NotFoundException('Invitation not found or already used');
    }
    if (this.tokens.isExpired(invitation.expiresAt)) {
      throw new GoneException(
        'This invitation has expired. Ask your school to send a new one.',
      );
    }
    return invitation;
  }

  /** Context for the accept screen. Never exposes the token hash. */
  async getInvitation(token: string) {
    const inv = await this.findPendingInvitation(token);
    return {
      email: inv.email,
      firstName: inv.driver.firstName,
      lastName: inv.driver.lastName,
      driverId: inv.driver.driverId,
      schoolName: inv.school.name,
      expiresAt: inv.expiresAt,
    };
  }

  async acceptInvitation(dto: AcceptDriverInvitationDto) {
    let inv: Awaited<ReturnType<DriversService['findPendingInvitation']>>;
    try {
      inv = await this.findPendingInvitation(dto.token);
    } catch (e) {
      if (e instanceof GoneException) {
        await this.prisma.driverInvitation.updateMany({
          where: {
            tokenHash: this.tokens.hash(dto.token),
            status: InvitationStatus.PENDING,
          },
          data: { status: InvitationStatus.EXPIRED },
        });
      }
      throw e;
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { email: inv.email },
      select: { id: true },
    });
    if (existingUser) {
      throw new ConflictException(
        'An account with this email already exists. Ask your school to use a different email.',
      );
    }

    const password = await this.hashing.hash(dto.password);
    const { driver } = inv;

    const user = await this.prisma.$transaction(async (tx) => {
      // Single-use: only one concurrent accept can claim the invitation.
      const claimed = await tx.driverInvitation.updateMany({
        where: { id: inv.id, status: InvitationStatus.PENDING },
        data: { status: InvitationStatus.ACCEPTED, acceptedAt: new Date() },
      });
      if (claimed.count !== 1) {
        throw new ConflictException('Invitation was already used');
      }

      const created = await tx.user.create({
        data: {
          email: inv.email,
          password,
          firstName: driver.firstName,
          lastName: driver.lastName,
          phone: driver.phone,
        },
      });
      await tx.schoolMembership.create({
        data: {
          userId: created.id,
          schoolId: inv.schoolId,
          role: UserRole.DRIVER,
          status: MembershipStatus.ACTIVE,
        },
      });
      await tx.driver.update({
        where: { id: driver.id },
        data: {
          userId: created.id,
          status: DriverStatus.ACTIVE,
          activatedAt: new Date(),
        },
      });
      return created;
    }, TRANSACTION_OPTIONS);

    await this.audit.log({
      actorId: user.id,
      schoolId: inv.schoolId,
      action: AuditAction.DriverAccepted,
      targetType: 'Driver',
      targetId: driver.id,
      metadata: { driverId: driver.driverId },
    });

    if (inv.invitedById) {
      await this.notifications.notifyDriverAccepted(
        inv.invitedById,
        inv.school,
        `${driver.firstName} ${driver.lastName}`,
      );
    }

    return {
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: UserRole.DRIVER,
      schoolName: inv.school.name,
    };
  }

  // ---------------------------------------------------------------------------
  // Driver Portal
  // ---------------------------------------------------------------------------

  /**
   * The signed-in driver's profile plus their bus, its active routes, stops
   * in order, and the students picked up at each stop.
   */
  async me(actor: AuthTokenPayload) {
    const driver = await this.prisma.driver.findUnique({
      where: { userId: actor.sub },
      include: {
        school: { select: { name: true } },
        bus: {
          select: {
            ...BUS_REF,
            capacity: true,
            make: true,
            vehicleModel: true,
            color: true,
            status: true,
            routes: {
              where: { status: RouteStatus.ACTIVE },
              orderBy: { name: 'asc' },
              select: {
                id: true,
                name: true,
                morningDeparture: true,
                afternoonDeparture: true,
                stops: { orderBy: { sequence: 'asc' } },
                studentAssignments: {
                  select: {
                    pickupStopId: true,
                    student: {
                      select: {
                        id: true,
                        studentId: true,
                        firstName: true,
                        lastName: true,
                        classGrade: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!driver || driver.schoolId !== actor.schoolId) {
      throw new NotFoundException('Driver profile not found');
    }
    const { school, bus, ...rest } = driver;
    const byName = (a: { lastName: string }, b: { lastName: string }) =>
      a.lastName.localeCompare(b.lastName);
    return {
      ...this.toView(rest),
      schoolName: school.name,
      bus: bus && {
        ...bus,
        routes: bus.routes.map(({ stops, studentAssignments, ...r }) => ({
          ...r,
          studentCount: studentAssignments.length,
          stops: stops.map((st) => ({
            id: st.id,
            sequence: st.sequence,
            name: st.name,
            landmark: st.landmark,
            pickupTime: st.pickupTime,
            dropoffTime: st.dropoffTime,
            students: studentAssignments
              .filter((a) => a.pickupStopId === st.id)
              .map((a) => a.student)
              .sort(byName),
          })),
          // On the route but no pickup stop chosen yet.
          unplacedStudents: studentAssignments
            .filter((a) => !a.pickupStopId)
            .map((a) => a.student)
            .sort(byName),
        })),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async getOwned(schoolId: string, id: string): Promise<Driver> {
    const driver = await this.prisma.driver.findFirst({
      where: { id, schoolId },
    });
    if (!driver) throw new NotFoundException('Driver not found');
    return driver;
  }

  /** Optional profile fields shared by create and update. */
  private profileData(dto: UpdateDriverDto) {
    return {
      ...(dto.dateOfBirth !== undefined && {
        dateOfBirth: parseDateOnly(dto.dateOfBirth),
      }),
      ...(dto.gender !== undefined && { gender: dto.gender }),
      ...(dto.address !== undefined && { address: dto.address || null }),
      ...(dto.licenseClass !== undefined && {
        licenseClass: dto.licenseClass || null,
      }),
      ...(dto.licenseIssuingState !== undefined && {
        licenseIssuingState: dto.licenseIssuingState || null,
      }),
      ...(dto.yearsOfExperience !== undefined && {
        yearsOfExperience: dto.yearsOfExperience,
      }),
      ...(dto.emergencyContactName !== undefined && {
        emergencyContactName: dto.emergencyContactName || null,
      }),
      ...(dto.emergencyContactPhone !== undefined && {
        emergencyContactPhone: dto.emergencyContactPhone || null,
      }),
    };
  }

  /** Friendly 409s instead of a raw unique-constraint error. */
  private async assertUnique(
    tx: Tx,
    schoolId: string,
    fields: { email?: string; licenseNumber?: string },
    excludeId?: string,
  ) {
    const not = excludeId ? { id: { not: excludeId } } : {};
    if (fields.email) {
      const clash = await tx.driver.findFirst({
        where: { schoolId, email: fields.email, ...not },
        select: { driverId: true },
      });
      if (clash) {
        throw new ConflictException(
          `${clash.driverId} already uses this email`,
        );
      }
    }
    if (fields.licenseNumber) {
      const clash = await tx.driver.findFirst({
        where: { schoolId, licenseNumber: fields.licenseNumber, ...not },
        select: { driverId: true },
      });
      if (clash) {
        throw new ConflictException(
          `${clash.driverId} already has this licence number`,
        );
      }
    }
  }

  /** Same atomic per-school counter scheme as studentIds. */
  private async allocateDriverId(tx: Tx, schoolId: string): Promise<string> {
    for (let guard = 0; guard < 20; guard++) {
      const { driverIdSeq } = await tx.school.update({
        where: { id: schoolId },
        data: { driverIdSeq: { increment: 1 } },
        select: { driverIdSeq: true },
      });
      const id = formatDriverId(driverIdSeq);
      const taken = await tx.driver.count({
        where: { schoolId, driverId: id },
      });
      if (!taken) return id;
    }
    throw new Error('Could not allocate a unique driver ID');
  }

  private toView(driver: Driver) {
    return {
      ...driver,
      dateOfBirth: driver.dateOfBirth?.toISOString().slice(0, 10) ?? null,
      licenseExpiry: driver.licenseExpiry.toISOString().slice(0, 10),
      licenseState: licenseState(driver.licenseExpiry),
      hasAccount: !!driver.userId,
    };
  }

  private toSafeInvitation(inv: DriverInvitation) {
    const { id, email, status, expiresAt, createdAt, acceptedAt } = inv;
    const expired =
      status === InvitationStatus.PENDING && this.tokens.isExpired(expiresAt);
    return {
      id,
      email,
      status: expired ? InvitationStatus.EXPIRED : status,
      expiresAt,
      createdAt,
      acceptedAt,
    };
  }
}
