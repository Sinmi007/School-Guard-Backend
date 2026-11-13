-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER');

-- CreateEnum
CREATE TYPE "StudentStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'GRADUATED', 'TRANSFERRED_OUT');

-- CreateEnum
CREATE TYPE "ClassGrade" AS ENUM ('NURSERY_1', 'NURSERY_2', 'NURSERY_3', 'PRIMARY_1', 'PRIMARY_2', 'PRIMARY_3', 'PRIMARY_4', 'PRIMARY_5', 'PRIMARY_6', 'JSS_1', 'JSS_2', 'JSS_3', 'SS_1', 'SS_2', 'SS_3', 'OTHER');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- DropIndex
DROP INDEX "students_school_id_idx";

-- DropIndex
DROP INDEX "students_bus_id_idx";

-- AlterTable
ALTER TABLE "students" DROP COLUMN "home_lat",
DROP COLUMN "home_lng",
DROP COLUMN "name",
DROP COLUMN "parent_name",
DROP COLUMN "parent_phone",
DROP COLUMN "payment_status",
ADD COLUMN     "address" TEXT NOT NULL,
ADD COLUMN     "class_grade" "ClassGrade" NOT NULL,
ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "date_of_birth" DATE NOT NULL,
ADD COLUMN     "first_name" TEXT NOT NULL,
ADD COLUMN     "gender" "Gender" NOT NULL,
ADD COLUMN     "guardian_name" TEXT NOT NULL,
ADD COLUMN     "guardian_phone" TEXT NOT NULL,
ADD COLUMN     "last_name" TEXT NOT NULL,
ADD COLUMN     "status" "StudentStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "student_id" TEXT NOT NULL,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL;

-- CreateTable
CREATE TABLE "student_imports" (
    "id" TEXT NOT NULL,
    "school_id" TEXT NOT NULL,
    "actor_id" TEXT,
    "status" "ImportStatus" NOT NULL DEFAULT 'PENDING',
    "file_name" TEXT NOT NULL,
    "total_rows" INTEGER,
    "success_count" INTEGER,
    "error_count" INTEGER,
    "storage_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "student_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_import_rows" (
    "id" TEXT NOT NULL,
    "import_id" TEXT NOT NULL,
    "row_index" INTEGER NOT NULL,
    "raw_data" JSONB NOT NULL,
    "error_messages" TEXT[],
    "is_valid" BOOLEAN NOT NULL,
    "is_duplicate" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "student_import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "student_imports_school_id_status_idx" ON "student_imports"("school_id", "status");

-- CreateIndex
CREATE INDEX "student_import_rows_import_id_is_valid_idx" ON "student_import_rows"("import_id", "is_valid");

-- CreateIndex
CREATE INDEX "students_school_id_status_idx" ON "students"("school_id", "status");

-- CreateIndex
CREATE INDEX "students_school_id_class_grade_idx" ON "students"("school_id", "class_grade");

-- CreateIndex
CREATE UNIQUE INDEX "students_school_id_student_id_key" ON "students"("school_id", "student_id");

-- AddForeignKey
ALTER TABLE "student_imports" ADD CONSTRAINT "student_imports_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_imports" ADD CONSTRAINT "student_imports_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_import_rows" ADD CONSTRAINT "student_import_rows_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "student_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
