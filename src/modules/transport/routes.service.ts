import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BusStatus, Prisma, RouteStatus, StudentStatus } from '@prisma/client';
import { AuthTokenPayload } from '../../common/auth/token.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import { DRIVER_SUMMARY } from './buses.service';
import { ListRoutesQueryDto } from './dto/list-query.dto';
import {
  AssignStudentsDto,
  CreateRouteDto,
  StopDto,
  UpdateRouteDto,
} from './dto/route.dto';

type Tx = Prisma.TransactionClient;
const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

const BUS_SUMMARY = {
  id: true,
  code: true,
  plateNumber: true,
  capacity: true,
  status: true,
  driver: { select: DRIVER_SUMMARY },
} as const;

export const STUDENT_SUMMARY = {
  id: true,
  studentId: true,
  firstName: true,
  lastName: true,
  classGrade: true,
  status: true,
} as const;

@Injectable()
export class RoutesService {
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

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  async findAll(actor: AuthTokenPayload, query: ListRoutesQueryDto) {
    const schoolId = this.requireSchool(actor);
    const terms = (query.search ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 5);
    const routes = await this.prisma.route.findMany({
      where: {
        schoolId,
        ...(query.status && { status: query.status }),
        ...(terms.length && {
          AND: terms.map((t) => ({
            OR: [
              { name: { contains: t, mode: 'insensitive' as const } },
              {
                stops: {
                  some: { name: { contains: t, mode: 'insensitive' as const } },
                },
              },
              { bus: { code: { contains: t, mode: 'insensitive' as const } } },
            ],
          })),
        }),
      },
      include: {
        bus: { select: BUS_SUMMARY },
        stops: { select: { name: true }, orderBy: { sequence: 'asc' } },
        _count: { select: { studentAssignments: true } },
      },
      orderBy: { name: 'asc' },
    });
    return routes.map(({ stops, _count, ...r }) => ({
      ...r,
      stopCount: stops.length,
      firstStop: stops[0]?.name ?? null,
      lastStop: stops.length > 1 ? stops[stops.length - 1].name : null,
      studentCount: _count.studentAssignments,
    }));
  }

  async findOne(actor: AuthTokenPayload, id: string) {
    const schoolId = this.requireSchool(actor);
    const route = await this.prisma.route.findFirst({
      where: { id, schoolId },
      include: {
        bus: { select: BUS_SUMMARY },
        stops: {
          orderBy: { sequence: 'asc' },
          include: { _count: { select: { pickupAssignments: true } } },
        },
        studentAssignments: {
          include: {
            student: { select: STUDENT_SUMMARY },
            pickupStop: { select: { id: true, name: true, sequence: true } },
          },
        },
      },
    });
    if (!route) throw new NotFoundException('Route not found');

    const { stops, studentAssignments, ...rest } = route;
    const students = studentAssignments
      .map((a) => ({
        ...a.student,
        assignmentId: a.id,
        assignedAt: a.assignedAt,
        pickupStop: a.pickupStop,
      }))
      .sort(
        (a, b) =>
          (a.pickupStop?.sequence ?? 999) - (b.pickupStop?.sequence ?? 999) ||
          a.lastName.localeCompare(b.lastName),
      );
    return {
      ...rest,
      stops: stops.map(({ _count, ...s }) => ({
        ...s,
        studentCount: _count.pickupAssignments,
      })),
      students,
      studentCount: students.length,
      seatsLeft: rest.bus ? rest.bus.capacity - students.length : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Create / update
  // ---------------------------------------------------------------------------

  async create(actor: AuthTokenPayload, dto: CreateRouteDto) {
    const schoolId = this.requireSchool(actor);
    const route = await this.prisma.$transaction(async (tx) => {
      await this.assertNameFree(tx, schoolId, dto.name);
      if (dto.busId) await this.assertBusUsable(tx, schoolId, dto.busId);
      const created = await tx.route.create({
        data: {
          schoolId,
          name: dto.name,
          description: dto.description || null,
          busId: dto.busId ?? null,
          morningDeparture: dto.morningDeparture ?? null,
          afternoonDeparture: dto.afternoonDeparture ?? null,
        },
      });
      if (dto.stops?.length) {
        await tx.routeStop.createMany({
          data: dto.stops.map((s, i) => ({
            ...this.stopData(s),
            routeId: created.id,
            schoolId,
            sequence: i + 1,
          })),
        });
      }
      return created;
    }, TRANSACTION_OPTIONS);

    await this.audit.log({
      actorId: actor.sub,
      schoolId,
      action: AuditAction.RouteCreated,
      targetType: 'Route',
      targetId: route.id,
      metadata: {
        name: route.name,
        busId: route.busId,
        stops: dto.stops?.length ?? 0,
      },
    });
    return this.findOne(actor, route.id);
  }

  async update(actor: AuthTokenPayload, id: string, dto: UpdateRouteDto) {
    const schoolId = this.requireSchool(actor);
    const existing = await this.prisma.route.findFirst({
      where: { id, schoolId },
      include: { _count: { select: { studentAssignments: true } } },
    });
    if (!existing) throw new NotFoundException('Route not found');
    if (dto.stops) {
      throw new BadRequestException('Update stops with PUT /routes/:id/stops');
    }

    const students = existing._count.studentAssignments;
    if (
      dto.status === RouteStatus.INACTIVE &&
      existing.status !== RouteStatus.INACTIVE &&
      students
    ) {
      throw new ConflictException(
        `${students} student${students === 1 ? ' is' : 's are'} on this route. Move or remove them before deactivating it.`,
      );
    }

    const busChanged = dto.busId !== undefined && dto.busId !== existing.busId;
    const data: Prisma.RouteUncheckedUpdateInput = {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.description !== undefined && {
        description: dto.description || null,
      }),
      ...(dto.morningDeparture !== undefined && {
        morningDeparture: dto.morningDeparture,
      }),
      ...(dto.afternoonDeparture !== undefined && {
        afternoonDeparture: dto.afternoonDeparture,
      }),
      ...(dto.status !== undefined && { status: dto.status }),
      ...(busChanged && { busId: dto.busId }),
    };
    const fields = Object.keys(data);
    if (!fields.length) return this.findOne(actor, id);

    await this.prisma.$transaction(async (tx) => {
      if (
        dto.name !== undefined &&
        dto.name.toLowerCase() !== existing.name.toLowerCase()
      ) {
        await this.assertNameFree(tx, schoolId, dto.name, id);
      }
      if (busChanged && dto.busId) {
        const bus = await this.assertBusUsable(tx, schoolId, dto.busId);
        if (students > bus.capacity) {
          throw new ConflictException(
            `${bus.code} has ${bus.capacity} seats but this route has ${students} students`,
          );
        }
      }
      await tx.route.update({ where: { id }, data });
      // Students ride whichever bus serves their route.
      if (busChanged) {
        await tx.studentTransportAssignment.updateMany({
          where: { routeId: id },
          data: { busId: dto.busId ?? null },
        });
      }
    }, TRANSACTION_OPTIONS);

    await this.audit.log({
      actorId: actor.sub,
      schoolId,
      action: AuditAction.RouteUpdated,
      targetType: 'Route',
      targetId: id,
      metadata: {
        name: existing.name,
        fields,
        ...(busChanged && { fromBusId: existing.busId, toBusId: dto.busId }),
      },
    });
    return this.findOne(actor, id);
  }

  /**
   * Replaces the ordered stop list. Stops sent with an `id` are kept (with
   * their students); stops left out are removed, unless students are picked
   * up there.
   */
  async replaceStops(actor: AuthTokenPayload, id: string, stops: StopDto[]) {
    const schoolId = this.requireSchool(actor);
    const route = await this.prisma.route.findFirst({
      where: { id, schoolId },
      include: {
        stops: { include: { _count: { select: { pickupAssignments: true } } } },
      },
    });
    if (!route) throw new NotFoundException('Route not found');

    const existingIds = new Set(route.stops.map((s) => s.id));
    const keptIds = stops.map((s) => s.id).filter((x): x is string => !!x);
    const unknown = keptIds.filter((x) => !existingIds.has(x));
    if (unknown.length)
      throw new BadRequestException('Some stops do not belong to this route');
    if (new Set(keptIds).size !== keptIds.length) {
      throw new BadRequestException('A stop appears more than once');
    }

    const removed = route.stops.filter((s) => !keptIds.includes(s.id));
    const blocked = removed.filter((s) => s._count.pickupAssignments > 0);
    if (blocked.length) {
      throw new ConflictException(
        `Students are picked up at ${blocked.map((s) => s.name).join(', ')}. Move them to another stop before removing it.`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      if (removed.length) {
        await tx.routeStop.deleteMany({
          where: { id: { in: removed.map((s) => s.id) } },
        });
      }
      for (const [i, s] of stops.entries()) {
        const data = { ...this.stopData(s), sequence: i + 1 };
        if (s.id) await tx.routeStop.update({ where: { id: s.id }, data });
        else
          await tx.routeStop.create({
            data: { ...data, routeId: id, schoolId },
          });
      }
    }, TRANSACTION_OPTIONS);

    await this.audit.log({
      actorId: actor.sub,
      schoolId,
      action: AuditAction.RouteStopsUpdated,
      targetType: 'Route',
      targetId: id,
      metadata: {
        name: route.name,
        stops: stops.length,
        added: stops.filter((s) => !s.id).length,
        removed: removed.length,
      },
    });
    return this.findOne(actor, id);
  }

  // ---------------------------------------------------------------------------
  // Student assignment
  // ---------------------------------------------------------------------------

  /** Puts students on this route (moving them off any other route). */
  async assignStudents(
    actor: AuthTokenPayload,
    id: string,
    dto: AssignStudentsDto,
  ) {
    const schoolId = this.requireSchool(actor);
    const studentIds = dto.assignments.map((a) => a.studentId);
    if (new Set(studentIds).size !== studentIds.length) {
      throw new BadRequestException('A student appears more than once');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // Serialise assignments to this route so two admins can't overfill a bus.
      await tx.$queryRaw`SELECT id FROM routes WHERE id = ${id} FOR UPDATE`;
      const route = await tx.route.findFirst({
        where: { id, schoolId },
        include: {
          bus: { select: { code: true, capacity: true } },
          stops: { select: { id: true } },
          studentAssignments: { select: { studentId: true } },
        },
      });
      if (!route) throw new NotFoundException('Route not found');
      if (route.status !== RouteStatus.ACTIVE) {
        throw new BadRequestException(
          'Reactivate this route before adding students',
        );
      }

      const stopIds = new Set(route.stops.map((s) => s.id));
      if (
        dto.assignments.some(
          (a) => a.pickupStopId && !stopIds.has(a.pickupStopId),
        )
      ) {
        throw new BadRequestException(
          'Pickup stop must be a stop on this route',
        );
      }

      const students = await tx.student.findMany({
        where: { id: { in: studentIds }, schoolId },
        select: { id: true, firstName: true, lastName: true, status: true },
      });
      if (students.length !== studentIds.length) {
        throw new BadRequestException(
          'Some students were not found in your school',
        );
      }
      const inactive = students.filter(
        (s) => s.status !== StudentStatus.ACTIVE,
      );
      if (inactive.length) {
        throw new BadRequestException(
          `Only active students can be assigned: ${inactive.map((s) => `${s.firstName} ${s.lastName}`).join(', ')}`,
        );
      }

      const already = new Set(route.studentAssignments.map((a) => a.studentId));
      const newcomers = studentIds.filter((s) => !already.has(s)).length;
      const total = already.size + newcomers;
      if (route.bus && total > route.bus.capacity) {
        throw new ConflictException(
          `${route.bus.code} has ${route.bus.capacity} seats and ${route.bus.capacity - already.size} left; you tried to add ${newcomers}.`,
        );
      }

      for (const a of dto.assignments) {
        const data = {
          schoolId,
          routeId: id,
          busId: route.busId,
          pickupStopId: a.pickupStopId ?? null,
        };
        await tx.studentTransportAssignment.upsert({
          where: { studentId: a.studentId },
          create: { ...data, studentId: a.studentId },
          update: { ...data, assignedAt: new Date() },
        });
      }
      return { route, newcomers };
    }, TRANSACTION_OPTIONS);

    await this.audit.log({
      actorId: actor.sub,
      schoolId,
      action: AuditAction.StudentsAssignedToRoute,
      targetType: 'Route',
      targetId: id,
      metadata: {
        name: result.route.name,
        students: studentIds.length,
        added: result.newcomers,
      },
    });
    return this.findOne(actor, id);
  }

  async unassignStudent(
    actor: AuthTokenPayload,
    id: string,
    studentId: string,
  ) {
    const schoolId = this.requireSchool(actor);
    const assignment = await this.prisma.studentTransportAssignment.findFirst({
      where: { routeId: id, studentId, schoolId },
      include: {
        student: { select: { studentId: true } },
        route: { select: { name: true } },
      },
    });
    if (!assignment)
      throw new NotFoundException('That student is not on this route');
    await this.prisma.studentTransportAssignment.delete({
      where: { id: assignment.id },
    });

    await this.audit.log({
      actorId: actor.sub,
      schoolId,
      action: AuditAction.StudentUnassignedFromRoute,
      targetType: 'Student',
      targetId: studentId,
      metadata: {
        studentId: assignment.student.studentId,
        route: assignment.route?.name,
      },
    });
    return this.findOne(actor, id);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private stopData(s: StopDto) {
    return {
      name: s.name,
      landmark: s.landmark || null,
      address: s.address || null,
      latitude: s.latitude ?? null,
      longitude: s.longitude ?? null,
      pickupTime: s.pickupTime || null,
      dropoffTime: s.dropoffTime || null,
    };
  }

  private async assertNameFree(
    tx: Tx,
    schoolId: string,
    name: string,
    excludeId?: string,
  ) {
    const clash = await tx.route.findFirst({
      where: {
        schoolId,
        name: { equals: name, mode: 'insensitive' },
        ...(excludeId && { id: { not: excludeId } }),
      },
      select: { id: true },
    });
    if (clash)
      throw new ConflictException(`A route named "${name}" already exists`);
  }

  private async assertBusUsable(tx: Tx, schoolId: string, busId: string) {
    const bus = await tx.bus.findFirst({
      where: { id: busId, schoolId },
      select: { code: true, capacity: true, status: true },
    });
    if (!bus) throw new BadRequestException('Bus not found in your school');
    if (bus.status === BusStatus.RETIRED) {
      throw new BadRequestException(
        `${bus.code} is retired and can't serve a route`,
      );
    }
    return bus;
  }
}
