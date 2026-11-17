import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { DriverStatus } from '@prisma/client';

/** INVITED is never set by hand — it is the state before acceptance. */
export const SETTABLE_DRIVER_STATUSES = [
  DriverStatus.ACTIVE,
  DriverStatus.SUSPENDED,
  DriverStatus.INACTIVE,
] as const;

export class ChangeDriverStatusDto {
  @IsIn(SETTABLE_DRIVER_STATUSES)
  status: (typeof SETTABLE_DRIVER_STATUSES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
