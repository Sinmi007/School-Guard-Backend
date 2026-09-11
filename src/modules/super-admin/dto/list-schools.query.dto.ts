import { IsEnum, IsOptional } from 'class-validator';
import { ApprovalStatus } from '@prisma/client';

export class ListSchoolsQueryDto {
  @IsOptional()
  @IsEnum(ApprovalStatus)
  approvalStatus?: ApprovalStatus;
}
