import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ClassGrade, StudentStatus } from '@prisma/client';

export const TRANSPORT_FILTERS = ['ASSIGNED', 'UNASSIGNED'] as const;
export type TransportFilter = (typeof TRANSPORT_FILTERS)[number];

export class ListStudentsQueryDto {
  /** Search across firstName, lastName, studentId (every word must match). */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsEnum(ClassGrade)
  classGrade?: ClassGrade;

  @IsOptional()
  @IsEnum(StudentStatus)
  status?: StudentStatus;

  /** Whether the student has a transportation assignment (populated from M5). */
  @IsOptional()
  @IsIn(TRANSPORT_FILTERS)
  transport?: TransportFilter;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
