import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UserRole } from '@prisma/client';
import { memoryStorage } from 'multer';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { RequireApprovedSchool } from '../../common/auth/require-approved-school.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import type { AuthTokenPayload } from '../../common/auth/token.service';
import { CreateStudentDto } from './dto/create-student.dto';
import { ListStudentsQueryDto } from './dto/list-students-query.dto';
import { UpdateStudentDto } from './dto/update-student.dto';
import { StudentImportService } from './student-import.service';
import { StudentsService } from './students.service';

const ALLOWED_MIME = [
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

@RequireApprovedSchool()
@Roles(UserRole.MAIN_ADMIN, UserRole.MANAGER)
@Controller('students')
export class StudentsController {
  constructor(
    private readonly studentsService: StudentsService,
    private readonly importService: StudentImportService,
  ) {}

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

  @Get(':id')
  findOne(@CurrentUser() user: AuthTokenPayload, @Param('id') id: string) {
    return this.studentsService.findOne(user, id);
  }

  @Post()
  create(
    @CurrentUser() user: AuthTokenPayload,
    @Body() dto: CreateStudentDto,
  ) {
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

  // ---------------------------------------------------------------------------
  // Import pipeline
  // ---------------------------------------------------------------------------

  /** Upload CSV/XLSX → queues background job → returns { importId } immediately */
  @Post('import')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_FILE_SIZE_BYTES },
      fileFilter: (_req, file, cb) => {
        if (ALLOWED_MIME.includes(file.mimetype)) {
          cb(null, true);
        } else {
          cb(
            new BadRequestException(
              'Only CSV or Excel files are accepted (.csv, .xls, .xlsx)',
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
    return this.importService.enqueue(user, file.originalname, file.buffer);
  }

  /** List all import jobs for this school (newest first) */
  @Get('imports')
  listImports(@CurrentUser() user: AuthTokenPayload) {
    return this.importService.listImports(user);
  }

  /** Poll a specific import job: status + per-row results */
  @Get('imports/:importId')
  getImport(
    @CurrentUser() user: AuthTokenPayload,
    @Param('importId') importId: string,
  ) {
    return this.importService.getImport(user, importId);
  }

  /** Commit the valid rows from a COMPLETED import job */
  @Post('imports/:importId/confirm')
  confirmImport(
    @CurrentUser() user: AuthTokenPayload,
    @Param('importId') importId: string,
  ) {
    return this.importService.confirm(user, importId);
  }
}
