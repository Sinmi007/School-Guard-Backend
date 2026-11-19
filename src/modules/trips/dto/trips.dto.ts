import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { TripDirection, TripStudentStatus } from '@prisma/client';

export class StartTripDto {
  @IsUUID()
  routeId: string;

  @IsEnum(TripDirection)
  direction: TripDirection;
}

export class MarkStudentDto {
  @IsEnum(TripStudentStatus)
  status: TripStudentStatus;
}

export class EndTripDto {
  /** Afternoon only: end even though students are still marked on board. */
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

export class CancelTripDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty({ message: 'Give a reason' })
  @MaxLength(300)
  reason: string;
}

export class ListTripsQueryDto {
  /** School day, "YYYY-MM-DD"; defaults to today. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date?: string;
}
