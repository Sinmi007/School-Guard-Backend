import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class RejectSchoolDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(5)
  reason: string;
}
