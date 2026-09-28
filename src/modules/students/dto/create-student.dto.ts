import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';
import { ClassGrade, Gender } from '@prisma/client';

export class CreateStudentDto {
  @IsString()
  @IsNotEmpty()
  firstName: string;

  @IsString()
  @IsNotEmpty()
  lastName: string;

  /** ISO 8601 date string, e.g. "2010-04-15" */
  @IsDateString()
  dateOfBirth: string;

  @IsEnum(Gender)
  gender: Gender;

  @IsEnum(ClassGrade)
  classGrade: ClassGrade;

  @IsString()
  @IsNotEmpty()
  address: string;

  @IsString()
  @IsNotEmpty()
  guardianName: string;

  @IsString()
  @Matches(/^\+?[0-9\s\-().]{7,20}$/, { message: 'Invalid phone number' })
  guardianPhone: string;
}
