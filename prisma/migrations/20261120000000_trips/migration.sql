-- CreateEnum
CREATE TYPE "TripDirection" AS ENUM ('MORNING', 'AFTERNOON');

-- CreateEnum
CREATE TYPE "TripStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TripStudentStatus" AS ENUM ('PENDING', 'BOARDED', 'DROPPED_OFF', 'ABSENT');

-- CreateTable
CREATE TABLE "trips" (
    "id" TEXT NOT NULL,
    "school_id" TEXT NOT NULL,
    "route_id" TEXT NOT NULL,
    "bus_id" TEXT,
    "driver_id" TEXT,
    "direction" "TripDirection" NOT NULL,
    "status" "TripStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "service_date" DATE NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "cancelled_reason" TEXT,
    "ended_with_on_board" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_students" (
    "id" TEXT NOT NULL,
    "trip_id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "stop_id" TEXT,
    "status" "TripStudentStatus" NOT NULL DEFAULT 'PENDING',
    "boarded_at" TIMESTAMP(3),
    "dropped_off_at" TIMESTAMP(3),
    "marked_at" TIMESTAMP(3),
    "marked_by_id" TEXT,

    CONSTRAINT "trip_students_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "trips_school_id_service_date_idx" ON "trips"("school_id", "service_date");

-- CreateIndex
CREATE INDEX "trips_route_id_service_date_direction_idx" ON "trips"("route_id", "service_date", "direction");

-- CreateIndex
CREATE INDEX "trips_driver_id_status_idx" ON "trips"("driver_id", "status");

-- CreateIndex
CREATE INDEX "trip_students_student_id_idx" ON "trip_students"("student_id");

-- CreateIndex
CREATE UNIQUE INDEX "trip_students_trip_id_student_id_key" ON "trip_students"("trip_id", "student_id");

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "routes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_bus_id_fkey" FOREIGN KEY ("bus_id") REFERENCES "buses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_students" ADD CONSTRAINT "trip_students_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_students" ADD CONSTRAINT "trip_students_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_students" ADD CONSTRAINT "trip_students_stop_id_fkey" FOREIGN KEY ("stop_id") REFERENCES "route_stops"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- A route runs at most once per school day in each direction (cancelled runs
-- don't count, so a cancelled trip can be restarted).
CREATE UNIQUE INDEX "trips_one_run_per_route_day_direction"
  ON "trips"("route_id", "service_date", "direction")
  WHERE "status" <> 'CANCELLED';

-- A driver drives one trip at a time.
CREATE UNIQUE INDEX "trips_one_in_progress_per_driver"
  ON "trips"("driver_id")
  WHERE "status" = 'IN_PROGRESS';
