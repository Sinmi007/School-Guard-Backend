-- CreateEnum
CREATE TYPE "DriverStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'INACTIVE');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'DRIVER_ACCEPTED';

-- AlterTable
ALTER TABLE "schools" ADD COLUMN     "driver_id_seq" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "drivers" (
    "id" TEXT NOT NULL,
    "driver_id" TEXT NOT NULL,
    "school_id" TEXT NOT NULL,
    "user_id" TEXT,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "date_of_birth" DATE,
    "gender" "Gender",
    "address" TEXT,
    "license_number" TEXT NOT NULL,
    "license_class" TEXT,
    "license_expiry" DATE NOT NULL,
    "license_issuing_state" TEXT,
    "years_of_experience" INTEGER,
    "emergency_contact_name" TEXT,
    "emergency_contact_phone" TEXT,
    "status" "DriverStatus" NOT NULL DEFAULT 'INVITED',
    "created_by_id" TEXT,
    "activated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "drivers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_invitations" (
    "id" TEXT NOT NULL,
    "school_id" TEXT NOT NULL,
    "driver_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "invited_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accepted_at" TIMESTAMP(3),

    CONSTRAINT "driver_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "drivers_user_id_key" ON "drivers"("user_id");

-- CreateIndex
CREATE INDEX "drivers_school_id_status_idx" ON "drivers"("school_id", "status");

-- CreateIndex
CREATE INDEX "drivers_school_id_license_expiry_idx" ON "drivers"("school_id", "license_expiry");

-- CreateIndex
CREATE UNIQUE INDEX "drivers_school_id_driver_id_key" ON "drivers"("school_id", "driver_id");

-- CreateIndex
CREATE UNIQUE INDEX "drivers_school_id_email_key" ON "drivers"("school_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "drivers_school_id_license_number_key" ON "drivers"("school_id", "license_number");

-- CreateIndex
CREATE UNIQUE INDEX "driver_invitations_token_hash_key" ON "driver_invitations"("token_hash");

-- CreateIndex
CREATE INDEX "driver_invitations_driver_id_status_idx" ON "driver_invitations"("driver_id", "status");

-- CreateIndex
CREATE INDEX "driver_invitations_school_id_status_idx" ON "driver_invitations"("school_id", "status");

-- AddForeignKey
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_invitations" ADD CONSTRAINT "driver_invitations_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_invitations" ADD CONSTRAINT "driver_invitations_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_invitations" ADD CONSTRAINT "driver_invitations_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

