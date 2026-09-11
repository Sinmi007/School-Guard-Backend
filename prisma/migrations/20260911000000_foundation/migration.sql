-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('SUPER_ADMIN', 'MAIN_ADMIN', 'MANAGER', 'DRIVER', 'PARENT');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "OnboardingStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('SCHOOL_REGISTERED', 'SCHOOL_APPROVED', 'SCHOOL_REJECTED', 'MANAGER_INVITED', 'MANAGER_ACCEPTED', 'MAIN_ADMIN_TRANSFERRED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "password" TEXT NOT NULL,
    "is_super_admin" BOOLEAN NOT NULL DEFAULT false,
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schools" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "public_token" TEXT NOT NULL,
    "account_status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "onboarding_status" "OnboardingStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "approval_status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "rejection_reason" TEXT,
    "approved_at" TIMESTAMP(3),
    "approved_by" TEXT,
    "rejected_at" TIMESTAMP(3),
    "rejected_by" TEXT,
    "type" TEXT,
    "ownership" TEXT,
    "logo_url" TEXT,
    "website" TEXT,
    "official_email" TEXT,
    "official_phone" TEXT,
    "alt_phone" TEXT,
    "country" TEXT,
    "state" TEXT,
    "lga" TEXT,
    "city" TEXT,
    "full_address" TEXT,
    "transportation_snapshot" JSONB,
    "goals" TEXT,
    "referral_source" TEXT,
    "onboarding_completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "school_memberships" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "school_id" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "school_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manager_invitations" (
    "id" TEXT NOT NULL,
    "school_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "phone" TEXT,
    "token_hash" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "invited_by_id" TEXT,
    "accepted_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accepted_at" TIMESTAMP(3),

    CONSTRAINT "manager_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT,
    "school_id" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "school_id" TEXT,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buses" (
    "id" TEXT NOT NULL,
    "school_id" TEXT NOT NULL,
    "plate_number" TEXT NOT NULL,
    "driver_name" TEXT NOT NULL,
    "auth_token" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OFFLINE',
    "last_lat" DOUBLE PRECISION,
    "last_lng" DOUBLE PRECISION,
    "updated_at" TIMESTAMP(3),

    CONSTRAINT "buses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "students" (
    "id" TEXT NOT NULL,
    "school_id" TEXT NOT NULL,
    "bus_id" TEXT,
    "name" TEXT NOT NULL,
    "parent_name" TEXT NOT NULL,
    "parent_phone" TEXT NOT NULL,
    "home_lat" DOUBLE PRECISION NOT NULL,
    "home_lng" DOUBLE PRECISION NOT NULL,
    "payment_status" TEXT NOT NULL DEFAULT 'UNPAID',

    CONSTRAINT "students_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telemetry_logs" (
    "id" BIGSERIAL NOT NULL,
    "bus_id" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "speed_mps" DOUBLE PRECISION,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telemetry_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manifest_events" (
    "id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "bus_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verification_lat" DOUBLE PRECISION NOT NULL,
    "verification_lng" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "manifest_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "schools_public_token_key" ON "schools"("public_token");

-- CreateIndex
CREATE INDEX "schools_approval_status_idx" ON "schools"("approval_status");

-- CreateIndex
CREATE INDEX "school_memberships_school_id_role_idx" ON "school_memberships"("school_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "school_memberships_user_id_school_id_key" ON "school_memberships"("user_id", "school_id");

-- Defensive backstop: a school may never have more than one MAIN_ADMIN.
CREATE UNIQUE INDEX "school_memberships_one_main_admin"
    ON "school_memberships"("school_id")
    WHERE "role" = 'MAIN_ADMIN';

-- CreateIndex
CREATE UNIQUE INDEX "manager_invitations_token_hash_key" ON "manager_invitations"("token_hash");

-- CreateIndex
CREATE INDEX "manager_invitations_school_id_status_idx" ON "manager_invitations"("school_id", "status");

-- CreateIndex
CREATE INDEX "manager_invitations_email_idx" ON "manager_invitations"("email");

-- CreateIndex
CREATE INDEX "audit_logs_school_id_created_at_idx" ON "audit_logs"("school_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_idx" ON "audit_logs"("actor_id");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");

-- CreateIndex
CREATE INDEX "buses_school_id_idx" ON "buses"("school_id");

-- CreateIndex
CREATE INDEX "students_school_id_idx" ON "students"("school_id");

-- CreateIndex
CREATE INDEX "students_bus_id_idx" ON "students"("bus_id");

-- CreateIndex
CREATE INDEX "telemetry_logs_bus_id_idx" ON "telemetry_logs"("bus_id");

-- CreateIndex
CREATE INDEX "manifest_events_student_id_idx" ON "manifest_events"("student_id");

-- CreateIndex
CREATE INDEX "manifest_events_bus_id_idx" ON "manifest_events"("bus_id");

-- AddForeignKey
ALTER TABLE "school_memberships" ADD CONSTRAINT "school_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "school_memberships" ADD CONSTRAINT "school_memberships_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manager_invitations" ADD CONSTRAINT "manager_invitations_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manager_invitations" ADD CONSTRAINT "manager_invitations_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manager_invitations" ADD CONSTRAINT "manager_invitations_accepted_user_id_fkey" FOREIGN KEY ("accepted_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buses" ADD CONSTRAINT "buses_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_bus_id_fkey" FOREIGN KEY ("bus_id") REFERENCES "buses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telemetry_logs" ADD CONSTRAINT "telemetry_logs_bus_id_fkey" FOREIGN KEY ("bus_id") REFERENCES "buses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manifest_events" ADD CONSTRAINT "manifest_events_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manifest_events" ADD CONSTRAINT "manifest_events_bus_id_fkey" FOREIGN KEY ("bus_id") REFERENCES "buses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
