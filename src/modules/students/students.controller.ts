import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { memoryStorage } from 'multer';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { RequireApprovedSchool } from '../../common/auth/require-approved-school.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import type { AuthTokenPayload } from '../../common/auth/token.service';
import { ConfirmImportDto } from './dto/confirm-import.dto';
import { CreateStudentDto } from './dto/create-student.dto';
import { ListStudentsQueryDto } from './dto/list-students-query.dto';
import { UpdateStudentDto } from './dto/update-student.dto';
import { StudentImportService } from './student-import.service';
import { StudentsService } from './students.service';

// Browsers label spreadsheets inconsistently (Windows often sends CSVs as
// application/vnd.ms-excel), so the MIME type is ignored here: the filter
// only checks the extension, and the service then verifies the actual bytes
// match it (detectFileKind) before parsing.
const ALLOWED_EXTENSION = /\.(csv|xlsx)$/i;
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB ≈ well over 5,000 rows

@RequireApprovedSchool()
@Roles(UserRole.MAIN_ADMIN, UserRole.MANAGER)
@Controller('students')
export class StudentsController {
  constructor(
    private readonly studentsService: StudentsService,
    private readonly importService: StudentImportService,
  ) {}

  // ---------------------------------------------------------------------------
  // Import pipeline
  // NOTE: these static routes MUST be declared before the `:id` routes below,
  // otherwise `GET /students/imports` is captured by `GET /students/:id`.
  // ---------------------------------------------------------------------------

  /**
   * Upload a .csv or .xlsx → validates every row and returns the preview
   * (valid, errored and possible-duplicate rows). Nothing is saved as a
   * student until POST imports/:importId/confirm.
   */
  @Post('import')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 },
      fileFilter: (_req, file, cb) => {
        if (ALLOWED_EXTENSION.test(file.originalname)) {
          cb(null, true);
        } else {
          cb(
            new BadRequestException(
              'Only .csv and .xlsx files are accepted. For old .xls files, use File → Save As → .xlsx in Excel.',
            ),
            false,
          );
        }
      },
    }),
  )
  importFile(
    @CurrentUser() user: AuthTokenPayload,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    return this.importService.upload(user, file.originalname, file.buffer);
  }

  /** List all import jobs for this school (newest first) */
  @Get('imports')
  listImports(@CurrentUser() user: AuthTokenPayload) {
    return this.importService.listImports(user);
  }

  /** Import detail: status, counts and every row's errors/duplicate flags */
  @Get('imports/:importId')
  getImport(
    @CurrentUser() user: AuthTokenPayload,
    @Param('importId', ParseUUIDPipe) importId: string,
  ) {
    return this.importService.getImport(user, importId);
  }

  /**
   * Commit the valid rows of a previewed import, optionally leaving out rows
   * by index (e.g. flagged duplicates). All-or-nothing; only works once.
   */
  @Post('imports/:importId/confirm')
  confirmImport(
    @CurrentUser() user: AuthTokenPayload,
    @Param('importId', ParseUUIDPipe) importId: string,
    @Body() dto: ConfirmImportDto,
  ) {
    return this.importService.confirm(user, importId, dto);
  }

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  @Get()
  findAll(
    @CurrentUser() user: AuthTokenPayload,
    @Query() query: ListStudentsQueryDto,
  ) {
    return this.studentsService.findAll(user, query);
  }

  /** Counts by status + active students without transport (dashboard tiles) */
  @Get('summary')
  summary(@CurrentUser() user: AuthTokenPayload) {
    return this.studentsService.summary(user);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthTokenPayload, @Param('id') id: string) {
    return this.studentsService.findOne(user, id);
  }

  @Post()
  create(@CurrentUser() user: AuthTokenPayload, @Body() dto: CreateStudentDto) {
    return this.studentsService.create(user, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthTokenPayload,
    @Param('id') id: string,
    @Body() dto: UpdateStudentDto,
  ) {
    return this.studentsService.update(user, id, dto);
  }

  /** Soft-delete: transitions status → TRANSFERRED_OUT */
  @Delete(':id')
  remove(@CurrentUser() user: AuthTokenPayload, @Param('id') id: string) {
    return this.studentsService.softDelete(user, id);
  }
}
