import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ImportStatus, Prisma, StudentStatus } from '@prisma/client';
// csv-parser ships as CJS; use require() to get the callable factory
// eslint-disable-next-line @typescript-eslint/no-require-imports
const csvParser = require('csv-parser') as (options?: Record<string, unknown>) => NodeJS.ReadWriteStream;
import { Readable } from 'stream';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AuthTokenPayload } from '../../common/auth/token.service';
import { CreateStudentDto } from './dto/create-student.dto';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

// Simple sequential ID using current count + offset (race-safe per school via unique constraint)
async function generateStudentId(
  prisma: PrismaService,
  schoolId: string,
  offset: number,
): Promise<string> {
  const count = await prisma.student.count({ where: { schoolId } });
  return `AJO-${String(count + offset + 1).padStart(6, '0')}`;
}

@Injectable()
export class StudentImportService {
  private readonly logger = new Logger(StudentImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Step 1 — Accept a file buffer, store it, and queue the import job.
   * Returns immediately with { importId } so the client can poll.
   */
  async enqueue(
    user: AuthTokenPayload,
    fileName: string,
    fileBuffer: Buffer,
  ): Promise<{ importId: string }> {
    if (!user.schoolId) throw new NotFoundException('No school on account');

    // Store raw file content as base64 in the storageKey field
    // In a real production scenario this would go to object storage (S3/GCS)
    const storageKey = fileBuffer.toString('base64');

    const job = await this.prisma.studentImport.create({
      data: {
        schoolId: user.schoolId,
        actorId: user.sub,
        fileName,
        storageKey,
        status: ImportStatus.PENDING,
      },
    });

    await this.audit.log({
      actorId: user.sub,
      schoolId: user.schoolId,
      action: AuditAction.StudentImportStarted,
      targetType: 'StudentImport',
      targetId: job.id,
      metadata: { fileName },
    });

    // Process in background — fire and forget; status is polled by the client
    void this.process(job.id, user.schoolId, fileBuffer);

    return { importId: job.id };
  }

  /**
   * Background processor: parse → validate → detect duplicates → persist row results.
   * Transitions job status from PENDING → PROCESSING → COMPLETED | FAILED.
   */
  private async process(
    importId: string,
    schoolId: string,
    fileBuffer: Buffer,
  ): Promise<void> {
    try {
      await this.prisma.studentImport.update({
        where: { id: importId },
        data: { status: ImportStatus.PROCESSING },
      });

      const rawRows = await this.parseCsv(fileBuffer);
      const seenStudentIds = new Set<string>();
      // Pre-fetch existing studentIds for duplicate detection
      const existingIds = await this.prisma.student
        .findMany({ where: { schoolId }, select: { studentId: true } })
        .then((rows) => new Set(rows.map((r) => r.studentId)));

      let successCount = 0;
      let errorCount = 0;

      const rowResults: Array<{
        importId: string;
        rowIndex: number;
        rawData: Record<string, unknown>;
        errorMessages: string[];
        isValid: boolean;
        isDuplicate: boolean;
      }> = [];

      for (let i = 0; i < rawRows.length; i++) {
        const raw = rawRows[i];
        const errors: string[] = [];
        let isDuplicate = false;

        // Validate row against DTO
        const dto = plainToInstance(CreateStudentDto, {
          firstName: raw['firstName'] ?? raw['first_name'],
          lastName: raw['lastName'] ?? raw['last_name'],
          dateOfBirth: raw['dateOfBirth'] ?? raw['date_of_birth'],
          gender: (raw['gender'] as string | undefined)?.toUpperCase(),
          classGrade:
            (raw['classGrade'] ?? raw['class_grade'] as string | undefined)
              ?.toUpperCase()
              ?.replace(' ', '_'),
          address: raw['address'],
          guardianName: raw['guardianName'] ?? raw['guardian_name'],
          guardianPhone: raw['guardianPhone'] ?? raw['guardian_phone'],
        });

        const validationErrors = await validate(dto);
        for (const e of validationErrors) {
          errors.push(Object.values(e.constraints ?? {}).join(', '));
        }

        // Duplicate studentId within the file (if supplied)
        const suppliedId = raw['studentId'] ?? raw['student_id'];
        if (suppliedId) {
          if (seenStudentIds.has(suppliedId as string)) {
            errors.push(`Duplicate studentId in file: ${suppliedId}`);
          } else if (existingIds.has(suppliedId as string)) {
            errors.push(
              `studentId already exists in school: ${suppliedId}`,
            );
          }
          seenStudentIds.add(suppliedId as string);
        }

        // Probable-duplicate warning (same name + DOB + class)
        if (errors.length === 0) {
          const possibleDup = await this.prisma.student.findFirst({
            where: {
              schoolId,
              firstName: dto.firstName,
              lastName: dto.lastName,
              dateOfBirth: new Date(dto.dateOfBirth),
              classGrade: dto.classGrade,
            },
            select: { id: true },
          });
          if (possibleDup) isDuplicate = true;
        }

        const isValid = errors.length === 0;
        if (isValid) successCount++;
        else errorCount++;

        rowResults.push({
          importId,
          rowIndex: i,
          rawData: raw as Record<string, unknown>,
          errorMessages: errors,
          isValid,
          isDuplicate,
        });
      }

      // Persist all row results
      await this.prisma.studentImportRow.createMany({
        data: rowResults.map((r) => ({
          ...r,
          rawData: r.rawData as Prisma.InputJsonValue,
        })),
      });

      await this.prisma.studentImport.update({
        where: { id: importId },
        data: {
          status: ImportStatus.COMPLETED,
          totalRows: rawRows.length,
          successCount,
          errorCount,
          completedAt: new Date(),
        },
      });

      await this.audit.log({
        schoolId,
        action: AuditAction.StudentImportCompleted,
        targetType: 'StudentImport',
        targetId: importId,
        metadata: { totalRows: rawRows.length, successCount, errorCount },
      });
    } catch (err) {
      this.logger.error(`Import ${importId} failed`, err);
      await this.prisma.studentImport.update({
        where: { id: importId },
        data: { status: ImportStatus.FAILED, completedAt: new Date() },
      });
      await this.audit.log({
        schoolId,
        action: AuditAction.StudentImportFailed,
        targetType: 'StudentImport',
        targetId: importId,
        metadata: {
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  /** Step 2 — Commit only the valid (non-error) rows from a completed import. */
  async confirm(
    user: AuthTokenPayload,
    importId: string,
  ): Promise<{ committed: number }> {
    const schoolId = user.schoolId!;

    const job = await this.prisma.studentImport.findFirst({
      where: { id: importId, schoolId },
      include: { rows: { where: { isValid: true } } },
    });

    if (!job) throw new NotFoundException('Import job not found');

    if (job.status !== ImportStatus.COMPLETED) {
      throw new NotFoundException(
        'Import job is not ready to confirm (still processing or failed)',
      );
    }

    const validRows = job.rows;
    let committed = 0;

    for (let i = 0; i < validRows.length; i++) {
      const raw = validRows[i].rawData as Record<string, unknown>;
      const dto = plainToInstance(CreateStudentDto, {
        firstName: raw['firstName'] ?? raw['first_name'],
        lastName: raw['lastName'] ?? raw['last_name'],
        dateOfBirth: raw['dateOfBirth'] ?? raw['date_of_birth'],
        gender: (raw['gender'] as string | undefined)?.toUpperCase(),
        classGrade:
          ((raw['classGrade'] ?? raw['class_grade']) as string | undefined)
            ?.toUpperCase()
            ?.replace(' ', '_'),
        address: raw['address'],
        guardianName: raw['guardianName'] ?? raw['guardian_name'],
        guardianPhone: raw['guardianPhone'] ?? raw['guardian_phone'],
      });

      const studentId = await generateStudentId(this.prisma, schoolId, i);

      try {
        await this.prisma.student.create({
          data: {
            studentId,
            schoolId,
            firstName: dto.firstName,
            lastName: dto.lastName,
            dateOfBirth: new Date(dto.dateOfBirth as string),
            gender: dto.gender,
            classGrade: dto.classGrade,
            address: dto.address,
            guardianName: dto.guardianName,
            guardianPhone: dto.guardianPhone,
            status: StudentStatus.ACTIVE,
          },
        });
        committed++;
      } catch (err) {
        // Log but continue — unique constraint violations on studentId can
        // happen in edge cases and should not abort the whole batch.
        this.logger.warn(`Skipping row ${i} on confirm: ${String(err)}`);
      }
    }

    return { committed };
  }

  /** Poll import job status + row results. */
  async getImport(user: AuthTokenPayload, importId: string) {
    const schoolId = user.schoolId!;
    const job = await this.prisma.studentImport.findFirst({
      where: { id: importId, schoolId },
      include: { rows: true },
    });
    if (!job) throw new NotFoundException('Import job not found');
    return job;
  }

  /** List all import jobs for the school (newest first). */
  async listImports(user: AuthTokenPayload) {
    const schoolId = user.schoolId!;
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
        createdAt: true,
        completedAt: true,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private parseCsv(buffer: Buffer): Promise<Record<string, string>[]> {
    return new Promise((resolve, reject) => {
      const results: Record<string, string>[] = [];
      const stream = Readable.from(buffer);
      stream
        .pipe(csvParser())
        .on('data', (row: Record<string, string>) => results.push(row))
        .on('end', () => resolve(results))
        .on('error', reject);
    });
  }
}
