import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ClassGrade, Gender, Prisma, StudentStatus } from '@prisma/client';
import { AuthTokenPayload } from '../../common/auth/token.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import { CreateStudentDto } from './dto/create-student.dto';
import { ListStudentsQueryDto } from './dto/list-students-query.dto';
import { UpdateStudentDto } from './dto/update-student.dto';

/** Zero-padded school-scoped studentId, e.g. AJO-000001 */
async function generateStudentId(
  prisma: PrismaService,
  schoolId: string,
): Promise<string> {
  const count = await prisma.student.count({ where: { schoolId } });
  return `AJO-${String(count + 1).padStart(6, '0')}`;
}

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
    const studentId = await generateStudentId(this.prisma, schoolId);

    const student = await this.prisma.student.create({
      data: {
        studentId,
        schoolId,
        firstName: dto.firstName,
        lastName: dto.lastName,
        dateOfBirth: new Date(dto.dateOfBirth),
        gender: dto.gender as Gender,
        classGrade: dto.classGrade as ClassGrade,
        address: dto.address,
        guardianName: dto.guardianName,
        guardianPhone: dto.guardianPhone,
        status: StudentStatus.ACTIVE,
      },
    });

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
    const { search, classGrade, status, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;

    const where: Prisma.StudentWhereInput = {
      schoolId,
      ...(classGrade && { classGrade }),
      ...(status && { status }),
      ...(search && {
        OR: [
          { firstName: { contains: search, mode: 'insensitive' } },
          { lastName: { contains: search, mode: 'insensitive' } },
          { studentId: { contains: search, mode: 'insensitive' } },
        ],
      }),
    };

    const [data, total] = await Promise.all([
      this.prisma.student.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
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
    });
    if (!student) throw new NotFoundException('Student not found');
    return student;
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
        ...(dto.gender !== undefined && { gender: dto.gender as Gender }),
        ...(dto.classGrade !== undefined && {
          classGrade: dto.classGrade as ClassGrade,
        }),
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
