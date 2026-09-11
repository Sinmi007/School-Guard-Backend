import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class InviteManagerDto {
  @IsString()
  @IsNotEmpty()
  firstName: string;

  @IsString()
  @IsNotEmpty()
  lastName: string;

  @IsEmail()
  email: string;

  @IsOptional()
  @IsString()
  phone?: string;
}
