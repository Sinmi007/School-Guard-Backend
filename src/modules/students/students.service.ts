import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, StudentStatus } from '@prisma/client';
import { AuthTokenPayload } from '../../common/auth/token.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import { CreateStudentDto } from './dto/create-student.dto';
import { ListStudentsQueryDto } from './dto/list-students-query.dto';
import { UpdateStudentDto } from './dto/update-student.dto';
import { allocateStudentIds } from './student-id.allocator';

@Injectable()
export class StudentsService {
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
  // CRUD
  // ---------------------------------------------------------------------------

  async create(user: AuthTokenPayload, dto: CreateStudentDto) {
    const schoolId = this.requireSchool(user);

    const student = await this.prisma.$transaction(async (tx) => {
      const [studentId] = await allocateStudentIds(
        tx,
        schoolId,
        1,
        async (id) =>
          (await tx.student.count({ where: { schoolId, studentId: id } })) > 0,
      );
      return tx.student.create({
        data: {
          studentId,
          schoolId,
          firstName: dto.firstName,
          lastName: dto.lastName,
          dateOfBirth: new Date(dto.dateOfBirth),
          gender: dto.gender,
          classGrade: dto.classGrade,
          address: dto.address,
          guardianName: dto.guardianName,
          guardianPhone: dto.guardianPhone,
          status: StudentStatus.ACTIVE,
        },
      });
    });
    const { studentId } = student;

    await this.audit.log({
      actorId: user.sub,
      schoolId,
      action: AuditAction.StudentCreated,
      targetType: 'Student',
      targetId: student.id,
      metadata: { studentId },
    });

    return student;
  }

  async findAll(user: AuthTokenPayload, query: ListStudentsQueryDto) {
    const schoolId = this.requireSchool(user);
    const {
      search,
      classGrade,
      status,
      transport,
      page = 1,
      limit = 20,
    } = query;
    const skip = (page - 1) * limit;

    // Every word must match some field, so "ada obi" finds Ada Obi.
    const terms = (search ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 5);

    const where: Prisma.StudentWhereInput = {
      schoolId,
      ...(classGrade && { classGrade }),
      ...(status && { status }),
      ...(transport === 'ASSIGNED' && { transportAssignment: { isNot: null } }),
      ...(transport === 'UNASSIGNED' && { transportAssignment: { is: null } }),
      ...(terms.length && {
        AND: terms.map((t) => ({
          OR: [
            { firstName: { contains: t, mode: 'insensitive' as const } },
            { lastName: { contains: t, mode: 'insensitive' as const } },
            { studentId: { contains: t, mode: 'insensitive' as const } },
          ],
        })),
      }),
    };

    const [data, total] = await Promise.all([
      this.prisma.student.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { transportAssignment: true },
      }),
      this.prisma.student.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(user: AuthTokenPayload, id: string) {
    const schoolId = this.requireSchool(user);
    const student = await this.prisma.student.findFirst({
      where: { id, schoolId },
      include: { transportAssignment: true },
    });
    if (!student) throw new NotFoundException('Student not found');
    return student;
  }

  /** Roster counts for dashboard tiles. */
  async summary(user: AuthTokenPayload) {
    const schoolId = this.requireSchool(user);
    const [byStatus, activeWithoutTransport] = await Promise.all([
      this.prisma.student.groupBy({
        by: ['status'],
        where: { schoolId },
        _count: { _all: true },
      }),
      this.prisma.student.count({
        where: {
          schoolId,
          status: StudentStatus.ACTIVE,
          transportAssignment: { is: null },
        },
      }),
    ]);

    const counts = Object.fromEntries(
      Object.values(StudentStatus).map((s) => [s, 0]),
    ) as Record<StudentStatus, number>;
    for (const row of byStatus) counts[row.status] = row._count._all;

    return {
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      byStatus: counts,
      activeWithoutTransport,
    };
  }

  async update(user: AuthTokenPayload, id: string, dto: UpdateStudentDto) {
    const schoolId = this.requireSchool(user);

    const existing = await this.prisma.student.findFirst({
      where: { id, schoolId },
      select: { id: true, status: true },
    });
    if (!existing) throw new NotFoundException('Student not found');

    const statusChanged =
      dto.status !== undefined && dto.status !== existing.status;

    const updated = await this.prisma.student.update({
      where: { id },
      data: {
        ...(dto.firstName !== undefined && { firstName: dto.firstName }),
        ...(dto.lastName !== undefined && { lastName: dto.lastName }),
        ...(dto.dateOfBirth !== undefined && {
          dateOfBirth: new Date(dto.dateOfBirth),
        }),
        ...(dto.gender !== undefined && { gender: dto.gender }),
        ...(dto.classGrade !== undefined && { classGrade: dto.classGrade }),
        ...(dto.address !== undefined && { address: dto.address }),
        ...(dto.guardianName !== undefined && {
          guardianName: dto.guardianName,
        }),
        ...(dto.guardianPhone !== undefined && {
          guardianPhone: dto.guardianPhone,
        }),
        ...(dto.status !== undefined && { status: dto.status }),
      },
    });

    if (statusChanged) {
      await this.audit.log({
        actorId: user.sub,
        schoolId,
        action: AuditAction.StudentStatusChanged,
        targetType: 'Student',
        targetId: id,
        metadata: { from: existing.status, to: dto.status },
      });
    } else {
      await this.audit.log({
        actorId: user.sub,
        schoolId,
        action: AuditAction.StudentUpdated,
        targetType: 'Student',
        targetId: id,
      });
    }

    return updated;
  }

  /**
   * Soft-delete: transitions status to TRANSFERRED_OUT.
   * No student record is ever hard-deleted.
   */
  async softDelete(user: AuthTokenPayload, id: string) {
    const schoolId = this.requireSchool(user);

    const student = await this.prisma.student.findFirst({
      where: { id, schoolId },
      select: { id: true, status: true },
    });

    if (!student) throw new NotFoundException('Student not found');

    if (student.status === StudentStatus.TRANSFERRED_OUT) {
      throw new BadRequestException('Student is already transferred out');
    }

    const updated = await this.prisma.student.update({
      where: { id },
      data: { status: StudentStatus.TRANSFERRED_OUT },
    });

    await this.audit.log({
      actorId: user.sub,
      schoolId,
      action: AuditAction.StudentStatusChanged,
      targetType: 'Student',
      targetId: id,
      metadata: { from: student.status, to: StudentStatus.TRANSFERRED_OUT },
    });

    return updated;
  }
}
