import { ArrayMaxSize, IsArray, IsInt, IsOptional, Min } from 'class-validator';

export class ConfirmImportDto {
  /**
   * Row indexes (0-based, as returned in the preview) to leave out of the
   * import — typically rows flagged as possible duplicates. Rows with errors
   * are never imported regardless.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5000)
  @IsInt({ each: true })
  @Min(0, { each: true })
  excludeRowIndexes?: number[];
}
