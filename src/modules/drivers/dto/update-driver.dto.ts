import { PartialType } from '@nestjs/mapped-types';
import { CreateDriverDto } from './create-driver.dto';

/**
 * Any profile field. `email` can only change until the driver has an account
 * (it is their login once they accept); status changes use PATCH :id/status.
 */
export class UpdateDriverDto extends PartialType(CreateDriverDto) {}
