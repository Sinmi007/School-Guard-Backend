import { IsNotEmpty, IsString } from 'class-validator';

export class TransferMainAdminDto {
  /** Membership id of the active Manager who will become Main Admin. */
  @IsString()
  @IsNotEmpty()
  membershipId: string;
}
