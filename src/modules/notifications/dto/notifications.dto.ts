import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class ListNotificationsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  /** Return notifications older than this (the previous page's `nextBefore`). */
  @IsOptional()
  @IsDateString()
  before?: string;
}

class PushKeysDto {
  @IsString()
  @MaxLength(200)
  p256dh!: string;

  @IsString()
  @MaxLength(100)
  auth!: string;
}

/** The browser's PushSubscription.toJSON(). */
export class PushSubscribeDto {
  @IsUrl({ protocols: ['https'], require_protocol: true, require_tld: false })
  @MaxLength(1000)
  endpoint!: string;

  @ValidateNested()
  @Type(() => PushKeysDto)
  keys!: PushKeysDto;

  /** Browsers always send this (usually null); not used. */
  @IsOptional()
  @IsNumber()
  expirationTime?: number | null;
}

export class PushUnsubscribeDto {
  @IsString()
  @MaxLength(1000)
  endpoint!: string;
}
