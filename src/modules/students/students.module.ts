import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { StudentImportService } from './student-import.service';
import { StudentsController } from './students.controller';
import { StudentsService } from './students.service';

@Module({
  imports: [AuditModule],
  controllers: [StudentsController],
  providers: [StudentsService, StudentImportService],
  exports: [StudentsService],
})
export class StudentsModule {}
