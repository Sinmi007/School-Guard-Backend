import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { compactUpper, trim } from './common';

export class CreateBusDto {
  /** The school's own fleet number, e.g. "AJO-03". */
  @Transform(compactUpper)
  @IsString()
  @Matches(/^[A-Z0-9\-/]{1,20}$/, {
    message: 'code must be 1–20 letters, digits, "-" or "/"',
  })
  code: string;

  @Transform(compactUpper)
  @IsString()
  @Matches(/^[A-Z0-9-]{4,15}$/, {
    message: 'plateNumber must be 4–15 letters, digits or "-"',
  })
  plateNumber: string;

  /** Passenger seats (students). */
  @IsInt()
  @Min(1)
  @Max(100)
  capacity: number;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(50)
  make?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(50)
  vehicleModel?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1980)
  @Max(2100)
  year?: number | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(30)
  color?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  notes?: string | null;

  /** Driver to put on this bus (ACTIVE or INVITED, not on another bus). */
  @IsOptional()
  @IsUUID()
  driverId?: string | null;
}
