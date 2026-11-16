import { BadRequestException } from '@nestjs/common';
import { CellValue, Workbook } from 'exceljs';
import { Readable } from 'stream';
import { mapRow } from './student-row.mapper';
// csv-parser ships as CJS; use require() to get the callable factory
// eslint-disable-next-line @typescript-eslint/no-require-imports
const csvParser = require('csv-parser') as (
  options?: Record<string, unknown>,
) => NodeJS.ReadWriteStream;

export const MAX_IMPORT_ROWS = 5000;

export type StudentFileKind = 'csv' | 'xlsx';
export type RawRow = Record<string, string>;

/** Columns that must be present in the header row (any accepted spelling). */
const REQUIRED_FIELDS = [
  'firstName',
  'lastName',
  'dateOfBirth',
  'gender',
  'classGrade',
  'address',
  'guardianName',
  'guardianPhone',
] as const;

/**
 * Decides how to parse the upload from its extension AND its bytes — the
 * extension alone is never trusted (PRD M3 §7).
 */
export function detectFileKind(
  fileName: string,
  buffer: Buffer,
): StudentFileKind {
  if (buffer.length === 0) throw new BadRequestException('The file is empty');

  const isZip = buffer[0] === 0x50 && buffer[1] === 0x4b; // xlsx = zip container
  const isOle = buffer[0] === 0xd0 && buffer[1] === 0xcf; // legacy .xls
  const ext = fileName.toLowerCase().split('.').pop();

  if (isOle) {
    throw new BadRequestException(
      'Old Excel (.xls) files are not supported. Save it as .xlsx or "CSV UTF-8" and try again.',
    );
  }
  if (ext === 'xlsx') {
    if (!isZip) {
      throw new BadRequestException('This file is not a valid .xlsx workbook');
    }
    return 'xlsx';
  }
  if (ext === 'csv') {
    if (isZip || buffer.subarray(0, 8192).includes(0)) {
      throw new BadRequestException(
        'This file is not a text CSV. If it is an Excel workbook, upload it as .xlsx.',
      );
    }
    return 'csv';
  }
  throw new BadRequestException('Only .csv and .xlsx files are supported');
}

/** Parses the file and checks it has the required columns and 1..MAX rows. */
export async function parseStudentFile(
  kind: StudentFileKind,
  buffer: Buffer,
): Promise<RawRow[]> {
  const rows =
    kind === 'xlsx' ? await parseXlsx(buffer) : await parseCsv(buffer);
  const nonEmpty = rows.filter((r) =>
    Object.values(r).some((v) => v.trim() !== ''),
  );
  assertStructure(nonEmpty);
  return nonEmpty;
}

// ---------------------------------------------------------------------------

function parseCsv(buffer: Buffer): Promise<RawRow[]> {
  return new Promise((resolve, reject) => {
    const results: RawRow[] = [];
    Readable.from(buffer)
      .pipe(
        csvParser({
          // Strip the UTF-8 BOM Excel adds, and surrounding whitespace.
          mapHeaders: ({ header }: { header: string }) =>
            header.replace(/^\uFEFF/, '').trim(),
        }),
      )
      .on('data', (row: RawRow) => {
        results.push(row);
        if (results.length > MAX_IMPORT_ROWS) {
          reject(tooManyRows());
        }
      })
      .on('end', () => resolve(results))
      .on('error', reject);
  });
}

async function parseXlsx(buffer: Buffer): Promise<RawRow[]> {
  const workbook = new Workbook();
  try {
    await workbook.xlsx.load(
      buffer as unknown as Parameters<typeof workbook.xlsx.load>[0],
    );
  } catch {
    throw new Error(
      'Could not read the Excel file; it may be corrupt or password-protected',
    );
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('The workbook has no worksheets');
  if (sheet.actualRowCount - 1 > MAX_IMPORT_ROWS) throw tooManyRows();

  const headers: string[] = [];
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col] = cellToString(cell.value).trim();
  });
  // Which column (if any) holds guardian phone numbers — see fixPhone().
  const phoneCol = headers.findIndex(
    (h) => h && mapRow({ [h]: 'x' }).fields.guardianPhone !== undefined,
  );

  const rows: RawRow[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const record: RawRow = {};
    headers.forEach((header, col) => {
      if (!header) return;
      const value = row.getCell(col).value;
      record[header] = col === phoneCol ? fixPhone(value) : cellToString(value);
    });
    rows.push(record);
  });
  return rows;
}

/** Converts any Excel cell value to the text a user would expect to see. */
function cellToString(value: CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) {
    // Excel dates carry no timezone; exceljs returns them as UTC midnight.
    return Number.isNaN(value.getTime())
      ? ''
      : value.toISOString().slice(0, 10);
  }
  if ('formula' in value || 'sharedFormula' in value) {
    // Never evaluate or trust formulas; prefix "=" so validation rejects the row.
    const f = 'formula' in value ? value.formula : value.sharedFormula;
    return `=${f}`;
  }
  if ('richText' in value) return value.richText.map((r) => r.text).join('');
  if ('hyperlink' in value) {
    const t = value.text as unknown;
    return typeof t === 'string' ? t : '';
  }
  if ('error' in value) return '';
  return '';
}

/**
 * Excel stores "08012345678" typed into a General-format cell as the number
 * 8012345678, silently dropping the leading 0. Restore it for 10-digit
 * Nigerian mobile numbers (7xx/8xx/9xx).
 */
function fixPhone(value: CellValue): string {
  if (typeof value === 'number' && Number.isInteger(value)) {
    const digits = String(value);
    if (/^[789]\d{9}$/.test(digits)) return `0${digits}`;
    return digits;
  }
  return cellToString(value);
}

function tooManyRows() {
  return new Error(
    `File has more than ${MAX_IMPORT_ROWS} rows; split it into smaller files`,
  );
}

function assertStructure(rows: RawRow[]) {
  if (rows.length === 0) {
    throw new Error('The file has no student rows');
  }
  if (rows.length > MAX_IMPORT_ROWS) throw tooManyRows();
  // Map the header names (with dummy values) to see which fields are covered.
  const headers = Object.keys(rows[0]);
  const covered = new Set(
    Object.keys(
      mapRow(Object.fromEntries(headers.map((h) => [h, 'x']))).fields,
    ),
  );
  const missing = REQUIRED_FIELDS.filter((f) => !covered.has(f));
  if (missing.length) {
    throw new Error(`Missing required column(s): ${missing.join(', ')}`);
  }
}
