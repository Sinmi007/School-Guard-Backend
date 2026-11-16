/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return */
import { allocateStudentIds, formatStudentId } from './student-id.allocator';
import {
  duplicateKey,
  mapRow,
  normaliseDate,
  validateRow,
} from './student-row.mapper';

describe('allocateStudentIds', () => {
  function fakeTx(start = 0) {
    let seq = start;
    return {
      school: {
        update: jest.fn(({ data }: any) => {
          seq += data.studentIdSeq.increment;
          return Promise.resolve({ studentIdSeq: seq });
        }),
      },
    } as any;
  }

  it('allocates a contiguous range from the counter', async () => {
    const ids = await allocateStudentIds(fakeTx(5), 's1', 3);
    expect(ids).toEqual(['AJO-000006', 'AJO-000007', 'AJO-000008']);
  });

  it('skips IDs that are already taken and tops up the shortfall', async () => {
    const taken = new Set(['AJO-000002']);
    const tx = fakeTx(0);
    const ids = await allocateStudentIds(tx, 's1', 3, (id) => taken.has(id));
    expect(ids).toEqual(['AJO-000001', 'AJO-000003', 'AJO-000004']);
    expect(tx.school.update).toHaveBeenCalledTimes(2);
  });

  it('allocates nothing for count 0', async () => {
    const tx = fakeTx(0);
    expect(await allocateStudentIds(tx, 's1', 0)).toEqual([]);
    expect(tx.school.update).not.toHaveBeenCalled();
  });

  it('formats with 6-digit padding', () => {
    expect(formatStudentId(482)).toBe('AJO-000482');
  });
});

describe('mapRow / validateRow', () => {
  const good = {
    'First Name': ' Ada ',
    surname: 'Obi',
    DOB: '2015-04-15',
    Sex: 'f',
    Class: 'Primary 3',
    Address: '1 Test St',
    'Parent Name': 'Mr Obi',
    'Parent Phone': '+2348011111111',
    'Admission No': 'ADM-77',
  };

  it('maps header aliases and normalises values', () => {
    const m = mapRow(good);
    expect(m.suppliedStudentId).toBe('ADM-77');
    expect(m.fields).toMatchObject({
      firstName: 'Ada',
      lastName: 'Obi',
      gender: 'FEMALE',
      classGrade: 'PRIMARY_3',
      guardianPhone: '+2348011111111',
    });
  });

  it('normalises compact class names like JSS1', () => {
    expect(mapRow({ class: 'jss1' }).fields.classGrade).toBe('JSS_1');
  });

  it('accepts a valid row', async () => {
    const { errors } = await validateRow(mapRow(good));
    expect(errors).toEqual([]);
  });

  it('reports missing and malformed fields', async () => {
    const { errors } = await validateRow(
      mapRow({ ...good, DOB: 'not-a-date', 'First Name': '' }),
    );
    expect(errors.some((e) => e.startsWith('First name'))).toBe(true);
    expect(errors.some((e) => e.startsWith('Date of birth'))).toBe(true);
  });

  it('rejects spreadsheet formulas but allows "+" phone numbers', async () => {
    const { errors } = await validateRow(
      mapRow({ ...good, Address: '=HYPERLINK("http://evil")' }),
    );
    expect(errors).toContain('Address: looks like a spreadsheet formula');
    expect(errors.some((e) => e.startsWith('Guardian phone'))).toBe(false);
  });

  it('rejects unsafe supplied studentIds', async () => {
    const { errors } = await validateRow(
      mapRow({ ...good, 'Admission No': '<script>' }),
    );
    expect(errors.some((e) => e.startsWith('Student ID'))).toBe(true);
  });

  it('normalises day-first dates and rejects impossible/future ones', async () => {
    expect(normaliseDate('15/04/2015')).toBe('2015-04-15');
    expect(normaliseDate('5.4.2015')).toBe('2015-04-05');
    expect(normaliseDate('2015-4-5')).toBe('2015-04-05');

    const bad = async (dob: string) =>
      (await validateRow(mapRow({ ...good, DOB: dob }))).errors.some((e) =>
        e.startsWith('Date of birth'),
      );
    expect(await bad('31/02/2015')).toBe(true); // no Feb 31
    expect(await bad('01/01/2999')).toBe(true); // future
    expect(await bad('15/04/2015')).toBe(false);
  });

  it('builds the same duplicate key regardless of case/whitespace', () => {
    const a = duplicateKey({
      firstName: 'Ada ',
      lastName: 'OBI',
      dateOfBirth: '2015-04-15',
      classGrade: 'PRIMARY_3',
    });
    const b = duplicateKey({
      firstName: 'ada',
      lastName: 'obi',
      dateOfBirth: new Date('2015-04-15'),
      classGrade: 'PRIMARY_3',
    });
    expect(a).toBe(b);
  });
});
