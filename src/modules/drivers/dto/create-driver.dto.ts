import {
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { Gender } from '@prisma/client';
import { IsDateOnly } from './date-only.validator';

export const PHONE_PATTERN = /^\+?[0-9\s\-().]{7,20}$/;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Licence numbers are stored upper-case without spaces so duplicates match. */
export const normalizeLicense = (value: unknown) =>
  typeof value === 'string' ? value.replace(/\s+/g, '').toUpperCase() : value;

export class CreateDriverDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lastName: string;

  /** Becomes the driver's login; the invitation is sent here. */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail({}, { message: 'Enter a valid email address' })
  @MaxLength(254)
  email: string;

  @Matches(PHONE_PATTERN, { message: 'Invalid phone number' })
  phone: string;

  @IsOptional()
  @IsDateOnly({ past: true })
  dateOfBirth?: string;

  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  address?: string;

  @Transform(({ value }) => normalizeLicense(value))
  @IsString()
  @Matches(/^[A-Z0-9\-/]{4,30}$/, {
    message: 'licenseNumber must be 4–30 letters, digits, "-" or "/"',
  })
  licenseNumber: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(20)
  licenseClass?: string;

  /** "YYYY-MM-DD" */
  @IsDateOnly()
  licenseExpiry: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  licenseIssuingState?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60)
  yearsOfExperience?: number;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(150)
  emergencyContactName?: string;

  @IsOptional()
  @Matches(PHONE_PATTERN, { message: 'Invalid emergency contact phone' })
  emergencyContactPhone?: string;
}
