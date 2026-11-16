import {
  IsEnum,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  ValidateBy,
  ValidationOptions,
} from 'class-validator';
import { ClassGrade, Gender } from '@prisma/client';

/** A real calendar date (YYYY-MM-DD) between 1950-01-01 and today. */
function IsPlausibleBirthDate(options?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'isPlausibleBirthDate',
      validator: {
        validate: (value: unknown) => {
          if (typeof value !== 'string') return false;
          if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
          const d = new Date(`${value}T00:00:00Z`);
          // Rejects 2015-02-30 etc. (Date would silently roll it over)
          if (d.toISOString().slice(0, 10) !== value) return false;
          return d >= new Date('1950-01-01T00:00:00Z') && d <= new Date();
        },
        defaultMessage: () =>
          'dateOfBirth must be a real date (YYYY-MM-DD) and not in the future',
      },
    },
    options,
  );
}

export class CreateStudentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lastName: string;

  /** "YYYY-MM-DD", e.g. "2015-04-15" */
  @IsPlausibleBirthDate()
  dateOfBirth: string;

  @IsEnum(Gender)
  gender: Gender;

  @IsEnum(ClassGrade)
  classGrade: ClassGrade;

  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  address: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  guardianName: string;

  @IsString()
  @Matches(/^\+?[0-9\s\-().]{7,20}$/, { message: 'Invalid phone number' })
  guardianPhone: string;
}
