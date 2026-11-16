import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ImportStatus, Prisma, StudentStatus } from '@prisma/client';
import { createHash } from 'crypto';
import { AuthTokenPayload } from '../../common/auth/token.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import { ConfirmImportDto } from './dto/confirm-import.dto';
import {
  detectFileKind,
  parseStudentFile,
  RawRow,
} from './student-file.parser';
import { allocateStudentIds } from './student-id.allocator';
import { duplicateKey, mapRow, validateRow } from './student-row.mapper';

@Injectable()
export class StudentImportService {
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

  /**
   * Step 1 — Upload: validate the file, parse and validate every row, persist
   * the per-row results, and return the preview. Nothing is inserted into
   * `students` until the admin confirms (step 2).
   *
   * Runs inside the request (not fire-and-forget) so a server restart or
   * Render spin-down can never leave an import stuck in PROCESSING.
   */
  async upload(user: AuthTokenPayload, fileName: string, buffer: Buffer) {
    const schoolId = this.requireSchool(user);
    const kind = detectFileKind(fileName, buffer);

    const job = await this.prisma.studentImport.create({
      data: {
        schoolId,
        actorId: user.sub,
        fileName: fileName.slice(0, 255),
        storageKey: `sha256:${createHash('sha256').update(buffer).digest('hex')}`,
        status: ImportStatus.PROCESSING,
      },
    });
    await this.audit.log({
      actorId: user.sub,
      schoolId,
      action: AuditAction.StudentImportStarted,
      targetType: 'StudentImport',
      targetId: job.id,
      metadata: { fileName, format: kind },
    });

    let rawRows: RawRow[];
    try {
      rawRows = await parseStudentFile(kind, buffer);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await this.markFailed(user, schoolId, job.id, reason);
      throw new BadRequestException({ message: reason, importId: job.id });
    }

    // One query for all existing students instead of one per row.
    const existing = await this.prisma.student.findMany({
      where: { schoolId },
      select: {
        studentId: true,
        firstName: true,
        lastName: true,
        dateOfBirth: true,
        classGrade: true,
      },
    });
    const existingIds = new Set(existing.map((s) => s.studentId));
    const existingByKey = new Map(
      existing.map((s) => [duplicateKey(s), s.studentId]),
    );

    const seenIds = new Map<string, number>(); // suppliedStudentId → first rowIndex
    const seenKeys = new Map<string, number>(); // duplicateKey → first rowIndex
    const rows: Prisma.StudentImportRowCreateManyInput[] = [];
    let validCount = 0;
    let errorCount = 0;
    let duplicateCount = 0;

    for (let i = 0; i < rawRows.length; i++) {
      const mapped = mapRow(rawRows[i]);
      const { dto, errors } = await validateRow(mapped);

      const sid = mapped.suppliedStudentId;
      if (sid) {
        if (seenIds.has(sid)) {
          errors.push(
            `studentId ${sid} also appears in row ${seenIds.get(sid)}`,
          );
        } else {
          seenIds.set(sid, i);
          if (existingIds.has(sid)) {
            errors.push(`studentId ${sid} already exists in this school`);
          }
        }
      }

      // Probable duplicate (same name + DOB + class): a warning, not an error,
      // since it may be a legitimate case (e.g. twins with the same name).
      let duplicateOf: string | null = null;
      if (errors.length === 0) {
        const key = duplicateKey(dto);
        if (existingByKey.has(key)) duplicateOf = existingByKey.get(key)!;
        else if (seenKeys.has(key)) duplicateOf = `row ${seenKeys.get(key)}`;
        else seenKeys.set(key, i);
      }

      const isValid = errors.length === 0;
      if (isValid) validCount++;
      else errorCount++;
      if (duplicateOf) duplicateCount++;

      rows.push({
        importId: job.id,
        rowIndex: i,
        rawData: rawRows[i],
        errorMessages: errors,
        isValid,
        isDuplicate: duplicateOf !== null,
        duplicateOf,
      });
    }

    await this.prisma.studentImportRow.createMany({ data: rows });
    await this.prisma.studentImport.update({
      where: { id: job.id },
      data: {
        status: ImportStatus.COMPLETED,
        totalRows: rawRows.length,
        successCount: validCount,
        errorCount,
        duplicateCount,
        completedAt: new Date(),
      },
    });

    return {
      importId: job.id,
      status: ImportStatus.COMPLETED,
      totalRows: rawRows.length,
      validCount,
      errorCount,
      duplicateCount,
      // Problem rows inline so the client can render the preview straight
      // away; the full row list is available via GET /students/imports/:id.
      errorRows: rows
        .filter((r) => !r.isValid)
        .map((r) => ({ rowIndex: r.rowIndex, errors: r.errorMessages })),
      duplicateRows: rows
        .filter((r) => r.isDuplicate)
        .map((r) => ({ rowIndex: r.rowIndex, duplicateOf: r.duplicateOf })),
    };
  }

  /**
   * Step 2 — Confirm: commit the valid rows (minus any the admin excluded).
   * All-or-nothing, and can only succeed once per import.
   */
  async confirm(
    user: AuthTokenPayload,
    importId: string,
    dto: ConfirmImportDto,
  ) {
    const schoolId = this.requireSchool(user);
    const exclude = new Set(dto.excludeRowIndexes ?? []);

    const job = await this.prisma.studentImport.findFirst({
      where: { id: importId, schoolId },
      select: { status: true },
    });
    if (!job) throw new NotFoundException('Import not found');
    if (job.status !== ImportStatus.COMPLETED) {
      throw new ConflictException(
        job.status === ImportStatus.CONFIRMED
          ? 'This import has already been confirmed'
          : `Import cannot be confirmed (status: ${job.status})`,
      );
    }

    const result = await this.prisma.$transaction(
      async (tx) => {
        // Claim the import. The row lock makes a concurrent second confirm
        // wait here, then match 0 rows → 409, so rows are never inserted twice.
        const claimed = await tx.studentImport.updateMany({
          where: { id: importId, schoolId, status: ImportStatus.COMPLETED },
          data: { status: ImportStatus.CONFIRMED, confirmedAt: new Date() },
        });
        if (claimed.count === 0) {
          throw new ConflictException('This import has already been confirmed');
        }

        const validRows = await tx.studentImportRow.findMany({
          where: { importId, isValid: true },
          orderBy: { rowIndex: 'asc' },
        });
        const rows = validRows.filter((r) => !exclude.has(r.rowIndex));

        const prepared = await Promise.all(
          rows.map(async (row) => {
            const mapped = mapRow(row.rawData as Record<string, unknown>);
            const { dto: student, errors } = await validateRow(mapped);
            if (errors.length) {
              // Validated at upload; fail loudly rather than silently skip.
              throw new BadRequestException(
                `Row ${row.rowIndex} is no longer valid`,
              );
            }
            return { row, student, suppliedId: mapped.suppliedStudentId };
          }),
        );

        // Supplied IDs may have been taken since the preview was generated.
        const supplied = prepared.flatMap((p) =>
          p.suppliedId ? [p.suppliedId] : [],
        );
        if (supplied.length) {
          const clash = await tx.student.findMany({
            where: { schoolId, studentId: { in: supplied } },
            select: { studentId: true },
          });
          if (clash.length) {
            throw new ConflictException({
              message:
                'Some studentIds in this file were added to the school after the preview. Re-upload the file.',
              studentIds: clash.map((c) => c.studentId),
            });
          }
        }

        const suppliedSet = new Set(supplied);
        const generated = await allocateStudentIds(
          tx,
          schoolId,
          prepared.filter((p) => !p.suppliedId).length,
          async (id) =>
            suppliedSet.has(id) ||
            (await tx.student.count({ where: { schoolId, studentId: id } })) >
              0,
        );

        let g = 0;
        const assignments = prepared.map((p) => ({
          ...p,
          studentId: p.suppliedId ?? generated[g++],
        }));

        await tx.student.createMany({
          data: assignments.map(({ student, studentId }) => ({
            studentId,
            schoolId,
            firstName: student.firstName,
            lastName: student.lastName,
            dateOfBirth: new Date(student.dateOfBirth),
            gender: student.gender,
            classGrade: student.classGrade,
            address: student.address,
            guardianName: student.guardianName,
            guardianPhone: student.guardianPhone,
            status: StudentStatus.ACTIVE,
          })),
        });

        if (assignments.length) {
          // One statement instead of one UPDATE per row.
          await tx.$executeRaw`
            UPDATE "student_import_rows" AS r
            SET "committed_student_id" = v.sid
            FROM unnest(${assignments.map((a) => a.row.id)}::text[],
                        ${assignments.map((a) => a.studentId)}::text[]) AS v(id, sid)
            WHERE r."id" = v.id`;
        }

        await tx.studentImport.update({
          where: { id: importId },
          data: { committedCount: assignments.length },
        });

        return {
          committed: assignments.length,
          excluded: validRows.length - rows.length,
          students: assignments.map((a) => ({
            rowIndex: a.row.rowIndex,
            studentId: a.studentId,
          })),
        };
      },
      { timeout: 60_000, maxWait: 10_000 },
    );

    await this.audit.log({
      actorId: user.sub,
      schoolId,
      action: AuditAction.StudentImportCompleted,
      targetType: 'StudentImport',
      targetId: importId,
      metadata: {
        committed: result.committed,
        excludedRowIndexes: [...exclude],
      },
    });

    return result;
  }

  /** Import detail + per-row results (kept permanently for error reporting). */
  async getImport(user: AuthTokenPayload, importId: string) {
    const schoolId = this.requireSchool(user);
    const job = await this.prisma.studentImport.findFirst({
      where: { id: importId, schoolId },
      omit: { storageKey: true },
      include: { rows: { orderBy: { rowIndex: 'asc' } } },
    });
    if (!job) throw new NotFoundException('Import not found');
    return job;
  }

  /** Import history for the school (newest first). */
  async listImports(user: AuthTokenPayload) {
    const schoolId = this.requireSchool(user);
    return this.prisma.studentImport.findMany({
      where: { schoolId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        fileName: true,
        status: true,
        totalRows: true,
        successCount: true,
        errorCount: true,
        duplicateCount: true,
        committedCount: true,
        failureReason: true,
        actorId: true,
        createdAt: true,
        completedAt: true,
        confirmedAt: true,
      },
    });
  }

  private async markFailed(
    user: AuthTokenPayload,
    schoolId: string,
    importId: string,
    reason: string,
  ) {
    await this.prisma.studentImport.update({
      where: { id: importId },
      data: {
        status: ImportStatus.FAILED,
        failureReason: reason.slice(0, 500),
        completedAt: new Date(),
      },
    });
    await this.audit.log({
      actorId: user.sub,
      schoolId,
      action: AuditAction.StudentImportFailed,
      targetType: 'StudentImport',
      targetId: importId,
      metadata: { reason },
    });
  }
}
