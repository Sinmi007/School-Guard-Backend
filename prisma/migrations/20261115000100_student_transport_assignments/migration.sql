-- Separate student transportation assignment from student identity (PRD M3 §3).

-- CreateTable
CREATE TABLE "student_transport_assignments" (
    "id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "school_id" TEXT NOT NULL,
    "bus_id" TEXT,
    "route_id" TEXT,
    "pickup_stop_id" TEXT,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_transport_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "student_transport_assignments_student_id_key" ON "student_transport_assignments"("student_id");

-- CreateIndex
CREATE INDEX "student_transport_assignments_school_id_idx" ON "student_transport_assignments"("school_id");

-- CreateIndex
CREATE INDEX "student_transport_assignments_bus_id_idx" ON "student_transport_assignments"("bus_id");

-- AddForeignKey
ALTER TABLE "student_transport_assignments" ADD CONSTRAINT "student_transport_assignments_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_transport_assignments" ADD CONSTRAINT "student_transport_assignments_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_transport_assignments" ADD CONSTRAINT "student_transport_assignments_bus_id_fkey" FOREIGN KEY ("bus_id") REFERENCES "buses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Preserve any existing bus assignments before dropping the old column.
INSERT INTO "student_transport_assignments" ("id", "student_id", "school_id", "bus_id", "updated_at")
SELECT gen_random_uuid()::text, "id", "school_id", "bus_id", CURRENT_TIMESTAMP
FROM "students"
WHERE "bus_id" IS NOT NULL;

-- DropForeignKey
ALTER TABLE "students" DROP CONSTRAINT "students_bus_id_fkey";

-- AlterTable
ALTER TABLE "students" DROP COLUMN "bus_id";
