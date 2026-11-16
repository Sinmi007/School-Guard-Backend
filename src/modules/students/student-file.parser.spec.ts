import { Workbook } from 'exceljs';
import { detectFileKind, parseStudentFile } from './student-file.parser';
import { mapRow, validateRow } from './student-row.mapper';

const HEADERS = [
  'First Name',
  'Surname',
  'DOB',
  'Sex',
  'Class',
  'Address',
  'Parent Name',
  'Parent Phone',
];

async function xlsx(rows: unknown[][]): Promise<Buffer> {
  const wb = new Workbook();
  const ws = wb.addWorksheet('Students');
  ws.addRow(HEADERS);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('detectFileKind', () => {
  it('accepts real csv and xlsx', async () => {
    expect(detectFileKind('a.csv', Buffer.from('a,b\n1,2'))).toBe('csv');
    expect(detectFileKind('a.XLSX', await xlsx([]))).toBe('xlsx');
  });

  it('rejects mismatched or unsupported content', async () => {
    const zip = await xlsx([]);
    expect(() => detectFileKind('a.csv', zip)).toThrow(/not a text CSV/);
    expect(() => detectFileKind('a.xlsx', Buffer.from('a,b'))).toThrow(
      /not a valid .xlsx/,
    );
    expect(() =>
      detectFileKind('a.xls', Buffer.from([0xd0, 0xcf, 0x11, 0xe0])),
    ).toThrow(/Old Excel/);
    expect(() => detectFileKind('a.pdf', Buffer.from('%PDF'))).toThrow(
      /Only .csv and .xlsx/,
    );
    expect(() => detectFileKind('a.csv', Buffer.alloc(0))).toThrow(/empty/);
  });
});

describe('parseStudentFile (xlsx)', () => {
  it('converts dates, restores phone leading zero, keeps text', async () => {
    const buf = await xlsx([
      [
        'Ada',
        'Obi',
        new Date(Date.UTC(2015, 3, 15)),
        'F',
        'Primary 3',
        '1 Test St',
        'Mr Obi',
        8012345678, // Excel dropped the leading 0
      ],
    ]);
    const [row] = await parseStudentFile('xlsx', buf);
    expect(row['DOB']).toBe('2015-04-15');
    expect(row['Parent Phone']).toBe('08012345678');

    const { errors } = await validateRow(mapRow(row));
    expect(errors).toEqual([]);
  });

  it('turns formula cells into rejected values (never evaluated)', async () => {
    const buf = await xlsx([
      [
        'Eve',
        'Uche',
        '2012-12-12',
        'F',
        'JSS1',
        { formula: 'HYPERLINK("http://x")', result: 'click' },
        'Mr Uche',
        '08066666666',
      ],
    ]);
    const [row] = await parseStudentFile('xlsx', buf);
    expect(row['Address']).toBe('=HYPERLINK("http://x")');
    const { errors } = await validateRow(mapRow(row));
    expect(errors).toContain('Address: looks like a spreadsheet formula');
  });

  it('skips blank rows and reports missing columns', async () => {
    const wb = new Workbook();
    const ws = wb.addWorksheet('S');
    ws.addRow(['First Name', 'Surname']);
    ws.addRow(['A', 'B']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    await expect(parseStudentFile('xlsx', buf)).rejects.toThrow(
      /Missing required column\(s\): dateOfBirth/,
    );
  });
});

describe('parseStudentFile (csv)', () => {
  it('strips BOM, ignores trailing empty rows', async () => {
    const csv =
      '\uFEFF' +
      HEADERS.join(',') +
      '\nAda,Obi,2015-04-15,F,Primary 3,1 St,Mr Obi,0801\n,,,,,,,\n';
    const rows = await parseStudentFile('csv', Buffer.from(csv));
    expect(rows).toHaveLength(1);
    expect(rows[0]['First Name']).toBe('Ada');
  });

  it('rejects a header-only file', async () => {
    await expect(
      parseStudentFile('csv', Buffer.from(HEADERS.join(','))),
    ).rejects.toThrow(/no student rows/);
  });
});
