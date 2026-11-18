-- Milestone 5: Buses & Routes.
-- Reshapes the placeholder "buses" table (driver_name/auth_token/last_lat/last_lng
-- were never written: no endpoint could create a bus, and the table was empty in
-- every environment when this was written), and adds routes + route_stops.

-- CreateEnum
CREATE TYPE "BusStatus" AS ENUM ('ACTIVE', 'MAINTENANCE', 'RETIRED');

-- CreateEnum
CREATE TYPE "RouteStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- DropIndex
DROP INDEX "buses_school_id_idx";

-- AlterTable
ALTER TABLE "buses" DROP COLUMN "auth_token",
DROP COLUMN "driver_name",
DROP COLUMN "last_lat",
DROP COLUMN "last_lng",
ADD COLUMN     "capacity" INTEGER NOT NULL,
ADD COLUMN     "code" TEXT NOT NULL,
ADD COLUMN     "color" TEXT,
ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "driver_id" TEXT,
ADD COLUMN     "make" TEXT,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "vehicle_model" TEXT,
ADD COLUMN     "year" INTEGER,
DROP COLUMN "status",
ADD COLUMN     "status" "BusStatus" NOT NULL DEFAULT 'ACTIVE',
ALTER COLUMN "updated_at" SET NOT NULL;

-- CreateTable
CREATE TABLE "routes" (
    "id" TEXT NOT NULL,
    "school_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "bus_id" TEXT,
    "morning_departure" TEXT,
    "afternoon_departure" TEXT,
    "status" "RouteStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_stops" (
    "id" TEXT NOT NULL,
    "route_id" TEXT NOT NULL,
    "school_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "landmark" TEXT,
    "address" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "pickup_time" TEXT,
    "dropoff_time" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "route_stops_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "routes_school_id_status_idx" ON "routes"("school_id", "status");

-- CreateIndex
CREATE INDEX "routes_bus_id_idx" ON "routes"("bus_id");

-- CreateIndex
CREATE UNIQUE INDEX "routes_school_id_name_key" ON "routes"("school_id", "name");

-- CreateIndex
CREATE INDEX "route_stops_route_id_sequence_idx" ON "route_stops"("route_id", "sequence");

-- CreateIndex
CREATE INDEX "route_stops_school_id_idx" ON "route_stops"("school_id");

-- CreateIndex
CREATE UNIQUE INDEX "buses_driver_id_key" ON "buses"("driver_id");

-- CreateIndex
CREATE INDEX "buses_school_id_status_idx" ON "buses"("school_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "buses_school_id_code_key" ON "buses"("school_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "buses_school_id_plate_number_key" ON "buses"("school_id", "plate_number");

-- CreateIndex
CREATE INDEX "student_transport_assignments_route_id_idx" ON "student_transport_assignments"("route_id");

-- AddForeignKey
ALTER TABLE "buses" ADD CONSTRAINT "buses_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routes" ADD CONSTRAINT "routes_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routes" ADD CONSTRAINT "routes_bus_id_fkey" FOREIGN KEY ("bus_id") REFERENCES "buses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_stops" ADD CONSTRAINT "route_stops_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "routes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_transport_assignments" ADD CONSTRAINT "student_transport_assignments_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "routes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_transport_assignments" ADD CONSTRAINT "student_transport_assignments_pickup_stop_id_fkey" FOREIGN KEY ("pickup_stop_id") REFERENCES "route_stops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

