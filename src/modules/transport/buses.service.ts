import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BusStatus, DriverStatus, Prisma } from '@prisma/client';
import { AuthTokenPayload } from '../../common/auth/token.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import { CreateBusDto } from './dto/create-bus.dto';
import { ListBusesQueryDto } from './dto/list-query.dto';
import { UpdateBusDto } from './dto/update-bus.dto';

type Tx = Prisma.TransactionClient;
const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

export const DRIVER_SUMMARY = {
  id: true,
  driverId: true,
  firstName: true,
  lastName: true,
  phone: true,
  status: true,
} as const;

const BUS_INCLUDE = {
  driver: { select: DRIVER_SUMMARY },
  routes: {
    select: {
      id: true,
      name: true,
      status: true,
      _count: { select: { studentAssignments: true } },
    },
    orderBy: { name: 'asc' },
  },
} satisfies Prisma.BusInclude;

type BusWithRelations = Prisma.BusGetPayload<{ include: typeof BUS_INCLUDE }>;

/** Drivers who may be put on a bus. */
const ASSIGNABLE_DRIVER = [DriverStatus.ACTIVE, DriverStatus.INVITED];

@Injectable()
export class BusesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private requireSchool(user: AuthTokenPayload): string {
    if (!user.schoolId) {
      throw new ForbiddenException('No school associated with this account');
    }
    return user.schoolId;
  }

  async findAll(actor: AuthTokenPayload, query: ListBusesQueryDto) {
    const schoolId = this.requireSchool(actor);
    const terms = (query.search ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 5);
    const where: Prisma.BusWhereInput = {
      schoolId,
      ...(query.status && { status: query.status }),
      ...(terms.length && {
        AND: terms.map((t) => ({
          OR: [
            { code: { contains: t, mode: 'insensitive' as const } },
            { plateNumber: { contains: t, mode: 'insensitive' as const } },
            { make: { contains: t, mode: 'insensitive' as const } },
            { vehicleModel: { contains: t, mode: 'insensitive' as const } },
            {
              driver: {
                firstName: { contains: t, mode: 'insensitive' as const },
              },
            },
            {
              driver: {
                lastName: { contains: t, mode: 'insensitive' as const },
              },
            },
          ],
        })),
      }),
    };
    const buses = await this.prisma.bus.findMany({
      where,
      include: BUS_INCLUDE,
      orderBy: { code: 'asc' },
    });
    return buses.map((b) => this.toView(b));
  }

  async findOne(actor: AuthTokenPayload, id: string) {
    const schoolId = this.requireSchool(actor);
    const bus = await this.prisma.bus.findFirst({
      where: { id, schoolId },
      include: BUS_INCLUDE,
    });
    if (!bus) throw new NotFoundException('Bus not found');
    return this.toView(bus);
  }

  async create(actor: AuthTokenPayload, dto: CreateBusDto) {
    const schoolId = this.requireSchool(actor);
    const bus = await this.prisma.$transaction(async (tx) => {
      await this.assertUnique(tx, schoolId, dto);
      if (dto.driverId)
        await this.assertDriverAssignable(tx, schoolId, dto.driverId);
      return tx.bus.create({
        data: {
          schoolId,
          code: dto.code,
          plateNumber: dto.plateNumber,
          capacity: dto.capacity,
          ...this.optionalFields(dto),
          driverId: dto.driverId ?? null,
        },
      });
    }, TRANSACTION_OPTIONS);

    await this.audit.log({
      actorId: actor.sub,
      schoolId,
      action: AuditAction.BusCreated,
      targetType: 'Bus',
      targetId: bus.id,
      metadata: {
        code: bus.code,
        plateNumber: bus.plateNumber,
        driverId: bus.driverId,
      },
    });
    return this.findOne(actor, bus.id);
  }

  async update(actor: AuthTokenPayload, id: string, dto: UpdateBusDto) {
    const schoolId = this.requireSchool(actor);
    const existing = await this.prisma.bus.findFirst({
      where: { id, schoolId },
      include: { routes: { select: { id: true, name: true } } },
    });
    if (!existing) throw new NotFoundException('Bus not found');

    const retiring =
      dto.status === BusStatus.RETIRED && existing.status !== BusStatus.RETIRED;
    if (retiring && existing.routes.length) {
      throw new ConflictException(
        `Move ${existing.routes.map((r) => r.name).join(', ')} to another bus before retiring ${existing.code}`,
      );
    }
    const willBeRetired = (dto.status ?? existing.status) === BusStatus.RETIRED;
    if (willBeRetired && dto.driverId) {
      throw new BadRequestException(
        "A retired bus can't have a driver. Reactivate it first.",
      );
    }

    const data: Prisma.BusUncheckedUpdateInput = {
      ...this.optionalFields(dto),
      ...(dto.code !== undefined && { code: dto.code }),
      ...(dto.plateNumber !== undefined && { plateNumber: dto.plateNumber }),
      ...(dto.capacity !== undefined && { capacity: dto.capacity }),
      ...(dto.status !== undefined && { status: dto.status }),
      ...(dto.driverId !== undefined && { driverId: dto.driverId }),
      // A retired bus keeps no driver.
      ...(retiring && { driverId: null }),
    };
    const fields = Object.keys(data);
    if (!fields.length) return this.findOne(actor, id);

    await this.prisma.$transaction(async (tx) => {
      await this.assertUnique(
        tx,
        schoolId,
        {
          code: dto.code !== existing.code ? dto.code : undefined,
          plateNumber:
            dto.plateNumber !== existing.plateNumber
              ? dto.plateNumber
              : undefined,
        },
        id,
      );
      if (dto.driverId && dto.driverId !== existing.driverId) {
        await this.assertDriverAssignable(tx, schoolId, dto.driverId, id);
      }
      if (dto.capacity !== undefined && dto.capacity < existing.capacity) {
        await this.assertCapacityFits(tx, id, dto.capacity);
      }
      await tx.bus.update({ where: { id }, data });
    }, TRANSACTION_OPTIONS);

    const driverChanged =
      'driverId' in data && data.driverId !== existing.driverId;
    await this.audit.log({
      actorId: actor.sub,
      schoolId,
      action: driverChanged
        ? AuditAction.BusDriverChanged
        : AuditAction.BusUpdated,
      targetType: 'Bus',
      targetId: id,
      metadata: {
        code: existing.code,
        fields,
        ...(driverChanged && {
          fromDriverId: existing.driverId,
          toDriverId: data.driverId,
        }),
        ...(dto.status &&
          dto.status !== existing.status && {
            from: existing.status,
            to: dto.status,
          }),
      },
    });
    return this.findOne(actor, id);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private optionalFields(dto: Partial<CreateBusDto>) {
    const opt = <T>(v: T | null | undefined) => (v === '' ? null : v);
    return {
      ...(dto.make !== undefined && { make: opt(dto.make) }),
      ...(dto.vehicleModel !== undefined && {
        vehicleModel: opt(dto.vehicleModel),
      }),
      ...(dto.year !== undefined && { year: dto.year }),
      ...(dto.color !== undefined && { color: opt(dto.color) }),
      ...(dto.notes !== undefined && { notes: opt(dto.notes) }),
    };
  }

  private async assertUnique(
    tx: Tx,
    schoolId: string,
    fields: { code?: string; plateNumber?: string },
    excludeId?: string,
  ) {
    const not = excludeId ? { id: { not: excludeId } } : {};
    if (fields.code) {
      const clash = await tx.bus.findFirst({
        where: { schoolId, code: fields.code, ...not },
        select: { id: true },
      });
      if (clash)
        throw new ConflictException(
          `Another bus already uses the code ${fields.code}`,
        );
    }
    if (fields.plateNumber) {
      const clash = await tx.bus.findFirst({
        where: { schoolId, plateNumber: fields.plateNumber, ...not },
        select: { code: true },
      });
      if (clash) {
        throw new ConflictException(
          `${clash.code} already has plate number ${fields.plateNumber}`,
        );
      }
    }
  }

  private async assertDriverAssignable(
    tx: Tx,
    schoolId: string,
    driverId: string,
    busId?: string,
  ) {
    const driver = await tx.driver.findFirst({
      where: { id: driverId, schoolId },
      select: {
        firstName: true,
        lastName: true,
        status: true,
        bus: { select: { id: true, code: true } },
      },
    });
    if (!driver)
      throw new BadRequestException('Driver not found in your school');
    const name = `${driver.firstName} ${driver.lastName}`;
    if (
      !ASSIGNABLE_DRIVER.includes(
        driver.status as (typeof ASSIGNABLE_DRIVER)[number],
      )
    ) {
      throw new BadRequestException(
        `${name} is ${driver.status.toLowerCase()} and can't be assigned a bus`,
      );
    }
    if (driver.bus && driver.bus.id !== busId) {
      throw new ConflictException(
        `${name} already drives ${driver.bus.code}. Remove them from that bus first.`,
      );
    }
  }

  /** Every route on this bus must still fit after shrinking capacity. */
  private async assertCapacityFits(tx: Tx, busId: string, capacity: number) {
    const routes = await tx.route.findMany({
      where: { busId },
      select: { name: true, _count: { select: { studentAssignments: true } } },
    });
    const over = routes.filter((r) => r._count.studentAssignments > capacity);
    if (over.length) {
      throw new ConflictException(
        `${over.map((r) => `${r.name} has ${r._count.studentAssignments} students`).join('; ')}. Reduce them before lowering capacity to ${capacity}.`,
      );
    }
  }

  private toView(bus: BusWithRelations) {
    const { routes, ...rest } = bus;
    return {
      ...rest,
      routes: routes.map(({ _count, ...r }) => ({
        ...r,
        studentCount: _count.studentAssignments,
      })),
      /** Fullest route on this bus — what capacity is checked against. */
      maxRouteLoad: routes.reduce(
        (m, r) => Math.max(m, r._count.studentAssignments),
        0,
      ),
    };
  }
}
