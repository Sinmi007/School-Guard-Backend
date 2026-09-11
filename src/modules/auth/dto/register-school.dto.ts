import { IsEmail, IsNotEmpty, IsString, MinLength } from 'class-validator';

/**
 * Single public school-registration flow. Deliberately has NO role field —
 * the registering user is always made MAIN_ADMIN server-side.
 */
export class RegisterSchoolDto {
  @IsString()
  @IsNotEmpty()
  firstName: string;

  @IsString()
  @IsNotEmpty()
  lastName: string;

  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty()
  phone: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsString()
  @IsNotEmpty()
  confirmPassword: string;
}
