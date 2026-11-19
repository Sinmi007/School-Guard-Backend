import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import {
  ParentAccountStatus,
  ParentLinkStatus,
  ParentRelationship,
} from '@prisma/client';
import { IsDateOnly } from '../../drivers/dto/date-only.validator';
import { PHONE_PATTERN } from '../../drivers/dto/create-driver.dto';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const lowerTrim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/** Public: a parent creating their account from a school's invite link. */
export class RegisterParentDto {
  /** The school's public token from the link (?school=...). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  schoolToken: string;

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

  @Transform(lowerTrim)
  @IsEmail({}, { message: 'Enter a valid email address' })
  @MaxLength(254)
  email: string;

  @Matches(PHONE_PATTERN, { message: 'Invalid phone number' })
  phone: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password: string;

  @IsString()
  confirmPassword: string;
}

/** Parent: ask to be linked to a child. Both identifiers must match the school's record. */
export class LinkRequestDto {
  /** The student's school ID, e.g. AJO-000123. */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/\s+/g, '').toUpperCase() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  studentId: string;

  /** "YYYY-MM-DD" */
  @IsDateOnly({ past: true })
  dateOfBirth: string;

  @IsEnum(ParentRelationship)
  relationship: ParentRelationship;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class ReasonDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class RejectDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Give the parent a reason' })
  @MaxLength(500)
  reason: string;
}

export const SETTABLE_PARENT_STATUSES = [
  ParentAccountStatus.APPROVED,
  ParentAccountStatus.REJECTED,
  ParentAccountStatus.SUSPENDED,
] as const;

export class ParentStatusDto extends ReasonDto {
  @IsIn(SETTABLE_PARENT_STATUSES)
  status: (typeof SETTABLE_PARENT_STATUSES)[number];
}

export class ListParentsQueryDto {
  @IsOptional()
  @IsEnum(ParentAccountStatus)
  status?: ParentAccountStatus;

  /** Parent name, email or phone, or a linked student's name / ID. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

export class ListRequestsQueryDto {
  @IsOptional()
  @IsEnum(ParentLinkStatus)
  status?: ParentLinkStatus;
}

export class EmailInvitesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value)
      ? (value as unknown[]).map((v) =>
          typeof v === 'string' ? v.trim().toLowerCase() : v,
        )
      : value,
  )
  @IsEmail({}, { each: true, message: 'Every address must be a valid email' })
  emails: string[];
}
