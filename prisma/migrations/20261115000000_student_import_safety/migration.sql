-- AlterEnum
ALTER TYPE "ImportStatus" ADD VALUE 'CONFIRMED';

-- AlterTable
ALTER TABLE "schools" ADD COLUMN     "student_id_seq" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "student_imports" ADD COLUMN     "committed_count" INTEGER,
ADD COLUMN     "confirmed_at" TIMESTAMP(3),
ADD COLUMN     "duplicate_count" INTEGER,
ADD COLUMN     "failure_reason" TEXT;

-- AlterTable
ALTER TABLE "student_import_rows" ADD COLUMN     "committed_student_id" TEXT,
ADD COLUMN     "duplicate_of" TEXT;


-- Backfill: start each school's counter after its highest existing AJO-number
-- (or its student count, whichever is larger) so generated IDs never collide.
UPDATE "schools" s SET "student_id_seq" = GREATEST(
  COALESCE((SELECT COUNT(*) FROM "students" st WHERE st."school_id" = s."id"), 0),
  COALESCE((SELECT MAX(CAST(SUBSTRING(st."student_id" FROM 5) AS INTEGER))
            FROM "students" st
            WHERE st."school_id" = s."id" AND st."student_id" ~ '^AJO-[0-9]{1,9}$'), 0)
);
