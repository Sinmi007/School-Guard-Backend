import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ClassGrade, StudentStatus } from '@prisma/client';

export class ListStudentsQueryDto {
  /** Full-text search across firstName, lastName, studentId */
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsEnum(ClassGrade)
  classGrade?: ClassGrade;

  @IsOptional()
  @IsEnum(StudentStatus)
  status?: StudentStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;
}
