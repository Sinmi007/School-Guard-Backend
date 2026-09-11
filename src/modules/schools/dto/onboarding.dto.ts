import { IsEmail, IsInt, IsOptional, IsString, Min } from 'class-validator';

/**
 * Onboarding is metadata collection only — it must never create operational
 * records (drivers, students, buses, routes, parents).
 */
export class OnboardingDto {
  // 1. School information
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsString()
  ownership?: string;

  @IsOptional()
  @IsString()
  logoUrl?: string;

  @IsOptional()
  @IsString()
  website?: string;

  // 2. Contact & location
  @IsOptional()
  @IsEmail()
  officialEmail?: string;

  @IsOptional()
  @IsString()
  officialPhone?: string;

  @IsOptional()
  @IsString()
  altPhone?: string;

  @IsOptional()
  @IsString()
  country?: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  lga?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  fullAddress?: string;

  // 3. Transportation snapshot (descriptive metadata only)
  @IsOptional()
  @IsString()
  currentTransportationProvision?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  busCount?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  driverCount?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  studentCount?: number;

  @IsOptional()
  @IsString()
  transportationModel?: string;

  // 4. Goals (optional)
  @IsOptional()
  @IsString()
  goals?: string;

  @IsOptional()
  @IsString()
  referralSource?: string;
}
