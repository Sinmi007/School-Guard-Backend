import { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

export const STUDENT_ID_PREFIX = 'AJO-';

export function formatStudentId(n: number): string {
  return `${STUDENT_ID_PREFIX}${String(n).padStart(6, '0')}`;
}

/**
 * Allocates `count` new studentIds for a school.
 *
 * The per-school counter (`schools.student_id_seq`) is incremented in a single
 * UPDATE, which Postgres serialises per row — so concurrent callers can never
 * receive the same number. IDs already in use (e.g. a CSV supplied
 * "AJO-000007" earlier) are skipped and replaced with further allocations.
 */
export async function allocateStudentIds(
  tx: Tx,
  schoolId: string,
  count: number,
  isTaken: (id: string) => boolean | Promise<boolean> = () => false,
): Promise<string[]> {
  const ids: string[] = [];
  let needed = count;

  // Bounded loop: each pass allocates exactly the shortfall.
  for (let guard = 0; needed > 0 && guard < 100; guard++) {
    const { studentIdSeq: last } = await tx.school.update({
      where: { id: schoolId },
      data: { studentIdSeq: { increment: needed } },
      select: { studentIdSeq: true },
    });

    for (let n = last - needed + 1; n <= last; n++) {
      const id = formatStudentId(n);
      if (!(await isTaken(id))) ids.push(id);
    }
    needed = count - ids.length;
  }

  if (needed > 0) {
    throw new Error('Could not allocate unique student IDs');
  }
  return ids;
}
