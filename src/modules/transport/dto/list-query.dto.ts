import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { BusStatus, RouteStatus } from '@prisma/client';

export class ListBusesQueryDto {
  /** Code, plate, make/model or driver name. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsEnum(BusStatus)
  status?: BusStatus;
}

export class ListRoutesQueryDto {
  /** Route name, stop name or bus code. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsEnum(RouteStatus)
  status?: RouteStatus;
}
