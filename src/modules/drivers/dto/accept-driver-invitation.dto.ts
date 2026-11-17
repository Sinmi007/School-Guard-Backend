import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class AcceptDriverInvitationDto {
  @IsString()
  @IsNotEmpty()
  token: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password: string;
}
