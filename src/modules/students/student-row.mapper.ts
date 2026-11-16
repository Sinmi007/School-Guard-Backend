import { Gender } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { CreateStudentDto } from './dto/create-student.dto';

/** Canonical field → accepted CSV header spellings (compared case/space/underscore-insensitively). */
const HEADER_ALIASES: Record<string, string[]> = {
  studentId: ['studentid', 'id', 'admissionnumber', 'admissionno'],
  firstName: ['firstname', 'givenname'],
  lastName: ['lastname', 'surname', 'familyname'],
  dateOfBirth: ['dateofbirth', 'dob', 'birthdate'],
  gender: ['gender', 'sex'],
  classGrade: ['classgrade', 'class', 'grade'],
  address: ['address', 'homeaddress'],
  guardianName: ['guardianname', 'parentname', 'parentguardianname'],
  guardianPhone: ['guardianphone', 'parentphone', 'phone', 'phonecontact'],
};

const normKey = (k: string) => k.toLowerCase().replace(/[\s_\-.]/g, '');

const ALIAS_LOOKUP = new Map<string, string>();
for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
  for (const a of aliases) ALIAS_LOOKUP.set(a, field);
}

/** Cells starting with these are executed as formulas by Excel/Sheets. */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

const STUDENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9\-_/]{0,49}$/;

export interface MappedRow {
  /** Fields ready for CreateStudentDto validation. */
  fields: Record<string, string | undefined>;
  /** School's own identifier from the file, if provided. */
  suppliedStudentId?: string;
}

/** Maps a raw CSV record (arbitrary header spellings) to canonical fields. */
export function mapRow(raw: Record<string, unknown>): MappedRow {
  const fields: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(raw)) {
    const field = ALIAS_LOOKUP.get(normKey(key));
    if (!field || fields[field] !== undefined) continue;
    // CSV cells are always strings; anything else (corrupt rawData) is ignored.
    const str = typeof value === 'string' ? value.trim() : '';
    fields[field] = str === '' ? undefined : str;
  }

  if (fields.gender) {
    const g = fields.gender.toUpperCase();
    fields.gender = g === 'M' ? Gender.MALE : g === 'F' ? Gender.FEMALE : g;
  }
  if (fields.dateOfBirth) {
    fields.dateOfBirth = normaliseDate(fields.dateOfBirth);
  }
  if (fields.classGrade) {
    // "Primary 3" / "primary-3" / "JSS1" → PRIMARY_3 / JSS_1
    fields.classGrade = fields.classGrade
      .toUpperCase()
      .replace(/[\s-]+/g, '_')
      .replace(/^(NURSERY|PRIMARY|JSS|SS)(\d)$/, '$1_$2');
  }

  const { studentId, ...rest } = fields;
  return { fields: rest, suppliedStudentId: studentId };
}

/**
 * Accepts ISO dates and the DD/MM/YYYY form Nigerian schools use
 * (also DD-MM-YYYY, DD.MM.YYYY). Day-first is assumed; anything
 * unrecognised is returned unchanged so validation reports it.
 */
export function normaliseDate(input: string): string {
  const s = input.trim();
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) {
    const [y, m, d] = s.split('-');
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) {
    const [, day, month, year] = m;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  return s;
}

/** Validates a mapped row; returns a CreateStudentDto and human-readable errors. */
export async function validateRow(
  mapped: MappedRow,
): Promise<{ dto: CreateStudentDto; errors: string[] }> {
  const errors: string[] = [];

  for (const [field, value] of Object.entries(mapped.fields)) {
    // Phone numbers legitimately start with "+"; the phone regex rejects formulas.
    if (field === 'guardianPhone') continue;
    if (value && FORMULA_PREFIX.test(value)) {
      errors.push(`${label(field)}: looks like a spreadsheet formula`);
    }
  }

  if (
    mapped.suppliedStudentId !== undefined &&
    !STUDENT_ID_PATTERN.test(mapped.suppliedStudentId)
  ) {
    errors.push(
      `${label('studentId')}: must be 1-50 letters, digits, "-", "_" or "/" and start with a letter or digit`,
    );
  }

  const dto = plainToInstance(CreateStudentDto, mapped.fields);
  for (const e of await validate(dto)) {
    errors.push(`${label(e.property)}: ${friendlyMessage(e)}`);
  }

  return { dto, errors };
}

/** Column names as a school admin would recognise them in their spreadsheet. */
const FIELD_LABELS: Record<string, string> = {
  studentId: 'Student ID',
  firstName: 'First name',
  lastName: 'Last name',
  dateOfBirth: 'Date of birth',
  gender: 'Gender',
  classGrade: 'Class',
  address: 'Address',
  guardianName: 'Guardian name',
  guardianPhone: 'Guardian phone',
};
const label = (field: string) => FIELD_LABELS[field] ?? field;

/** Turns class-validator output into plain wording without the field name. */
function friendlyMessage(e: ValidationError): string {
  const c = e.constraints ?? {};
  if (c.isNotEmpty || (e.value === undefined && Object.keys(c).length)) {
    return 'is missing';
  }
  if (c.isEnum && e.property === 'gender') {
    return `"${String(e.value)}" is not valid; use M, F, Male, Female or Other`;
  }
  if (c.isEnum && e.property === 'classGrade') {
    return `"${String(e.value)}" is not a recognised class; use e.g. Nursery 1, Primary 3, JSS 1 or SS 2`;
  }
  if (c.isPlausibleBirthDate) {
    return `"${String(e.value)}" is not a valid date; use DD/MM/YYYY (e.g. 15/04/2015), not in the future`;
  }
  if (c.maxLength) return 'is too long';
  if (c.matches && e.property === 'guardianPhone') {
    return 'is not a valid phone number';
  }
  // Remaining messages start with the property name ("dateOfBirth must ...").
  return Object.values(c)
    .map((m) => m.replace(new RegExp(`^${e.property}\\s+`), ''))
    .join('; ');
}

/** Key used for probable-duplicate detection (same name + DOB + class). */
export function duplicateKey(s: {
  firstName: string;
  lastName: string;
  dateOfBirth: string | Date;
  classGrade: string;
}): string {
  const dob =
    s.dateOfBirth instanceof Date
      ? s.dateOfBirth.toISOString().slice(0, 10)
      : new Date(s.dateOfBirth).toISOString().slice(0, 10);
  return [
    s.firstName.trim().toLowerCase(),
    s.lastName.trim().toLowerCase(),
    dob,
    s.classGrade,
  ].join('|');
}
