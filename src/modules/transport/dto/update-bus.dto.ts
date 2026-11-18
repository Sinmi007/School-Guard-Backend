import { IsEnum, IsOptional } from 'class-validator';
import { PartialType } from '@nestjs/mapped-types';
import { BusStatus } from '@prisma/client';
import { CreateBusDto } from './create-bus.dto';

/** Any create field (null clears optionals / unassigns the driver) + status. */
export class UpdateBusDto extends PartialType(CreateBusDto) {
  @IsOptional()
  @IsEnum(BusStatus)
  status?: BusStatus;
}
