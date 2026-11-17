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
import { DriverStatus } from '@prisma/client';

export const LICENSE_FILTERS = ['EXPIRED', 'EXPIRING_SOON', 'VALID'] as const;
export type LicenseFilter = (typeof LICENSE_FILTERS)[number];

export class ListDriversQueryDto {
  /** Name, driverId, email, phone or licence number; every word must match. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsEnum(DriverStatus)
  status?: DriverStatus;

  /** EXPIRING_SOON = expires within the next 30 days. */
  @IsOptional()
  @IsIn(LICENSE_FILTERS)
  license?: LicenseFilter;

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
