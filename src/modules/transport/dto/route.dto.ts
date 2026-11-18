import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { PartialType } from '@nestjs/mapped-types';
import { RouteStatus } from '@prisma/client';
import { TIME_PATTERN, trim } from './common';

const TIME_MESSAGE = 'must be a 24-hour time like 07:15';

export class StopDto {
  /** Existing stop id to keep (and its student assignments); omit for a new stop. */
  @IsOptional()
  @IsUUID()
  id?: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(150)
  landmark?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  address?: string | null;

  @IsOptional()
  @IsLatitude()
  latitude?: number | null;

  @IsOptional()
  @IsLongitude()
  longitude?: number | null;

  @IsOptional()
  @Matches(TIME_PATTERN, { message: `pickupTime ${TIME_MESSAGE}` })
  pickupTime?: string | null;

  @IsOptional()
  @Matches(TIME_PATTERN, { message: `dropoffTime ${TIME_MESSAGE}` })
  dropoffTime?: string | null;
}

export class CreateRouteDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @IsOptional()
  @IsUUID()
  busId?: string | null;

  @IsOptional()
  @Matches(TIME_PATTERN, { message: `morningDeparture ${TIME_MESSAGE}` })
  morningDeparture?: string | null;

  @IsOptional()
  @Matches(TIME_PATTERN, { message: `afternoonDeparture ${TIME_MESSAGE}` })
  afternoonDeparture?: string | null;

  /** Optional initial stops, in order. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => StopDto)
  stops?: StopDto[];
}

export class UpdateRouteDto extends PartialType(CreateRouteDto) {
  @IsOptional()
  @IsEnum(RouteStatus)
  status?: RouteStatus;
}

/** Full ordered replacement of a route's stops. */
export class ReplaceStopsDto {
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => StopDto)
  stops: StopDto[];
}

export class AssignmentItemDto {
  @IsUUID()
  studentId: string;

  /** Must be a stop on this route; null/omitted = stop not chosen yet. */
  @IsOptional()
  @IsUUID()
  pickupStopId?: string | null;
}

export class AssignStudentsDto {
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AssignmentItemDto)
  assignments: AssignmentItemDto[];
}
