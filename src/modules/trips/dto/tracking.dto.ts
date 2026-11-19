import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsISO8601,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class LocationPointDto {
  @IsLatitude()
  lat: number;

  @IsLongitude()
  lng: number;

  /** Metres per second, as reported by the phone. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  speedMps?: number | null;

  /** Degrees from north. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(360)
  heading?: number | null;

  /** Reported accuracy radius in metres. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  accuracyM?: number | null;

  /** When the phone took the fix (ISO 8601). */
  @IsISO8601()
  recordedAt: string;
}

export class LocationBatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => LocationPointDto)
  points: LocationPointDto[];
}
