# School Guard Backend - API Documentation

Base URL: `/`

SchoolGuard uses a single public **school-registration** flow plus an
**invitation/approval-based** onboarding model. Only registering a new school is
publicly self-serve; Managers, Drivers and Parents enter through invitations,
and every school must be approved by a platform **Super Admin** before
operational features unlock.

---

## Table of Contents

1. [Roles & Auth Model](#roles--auth-model)
2. [Status Model](#status-model)
3. [Approval Gate](#approval-gate)
4. [Auth](#auth)
5. [Schools & Onboarding](#schools--onboarding)
6. [Super Admin](#super-admin)
7. [Administrators (Managers)](#administrators-managers)
8. [Invitation Acceptance](#invitation-acceptance)
9. [Notifications](#notifications)
10. [Audit Logs](#audit-logs)
11. [Error Codes](#error-codes)

---

## Roles & Auth Model

Roles: `SUPER_ADMIN`, `MAIN_ADMIN`, `MANAGER`, `DRIVER`, `PARENT`.

A user's school role always comes from a `SchoolMembership`, never from the
client. The one exception is `SUPER_ADMIN`, a platform role with no school.

**JWT payload:**

```json
{
  "sub": "user-uuid",
  "email": "user@example.com",
  "role": "MAIN_ADMIN",
  "schoolId": "school-uuid",
  "membershipId": "membership-uuid"
}
```

`schoolId` / `membershipId` are absent for `SUPER_ADMIN` tokens. Protected
endpoints require `Authorization: Bearer <JWT_TOKEN>`.

Role checks are resolved from the **current** membership on every request, so a
demotion (e.g. Main Admin transfer) or suspension takes effect immediately
rather than at token expiry.

---

## Status Model

Statuses are tracked independently:

**School.accountStatus:** `ACTIVE | SUSPENDED | DEACTIVATED`
**School.onboardingStatus:** `IN_PROGRESS | COMPLETED`
**School.approvalStatus:** `PENDING | APPROVED | REJECTED`
**SchoolMembership.status:** `ACTIVE | SUSPENDED | DEACTIVATED`

Immediately after onboarding the expected combination is
`accountStatus=ACTIVE, onboardingStatus=COMPLETED, approvalStatus=PENDING`.

School lifecycle:

```
REGISTERED → ONBOARDING → ONBOARDING_COMPLETED → PENDING_APPROVAL → APPROVED
                                                        ↓
                                                    REJECTED (resubmit allowed)
```

---

## Approval Gate

Every operational write endpoint verifies `school.approvalStatus == APPROVED`
server-side, independent of frontend state, via a centralized guard. While a
school is `PENDING` or `REJECTED`, operational mutations are blocked with
`403`; the school's own dashboard/status remains **readable**.

Operational endpoints (later phase) will declare the gate; the infrastructure is
in place now.

---

## Auth

### `POST /auth/register-school`

The single public registration flow. Registers a user **and** creates their
school, automatically making the registrant `MAIN_ADMIN` (never client-supplied).
No role field is accepted — unknown fields are rejected with `400`.

**Request Body:**

| Field             | Type   | Required | Validation   |
|-------------------|--------|----------|--------------|
| `firstName`       | string | Yes      | Non-empty    |
| `lastName`        | string | Yes      | Non-empty    |
| `email`           | string | Yes      | Valid email  |
| `phone`           | string | Yes      | Non-empty    |
| `password`        | string | Yes      | Min length 8 |
| `confirmPassword` | string | Yes      | Must match   |

**Response:** `201 Created`

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "user-uuid",
    "firstName": "Ada",
    "lastName": "Okafor",
    "email": "ada@school.com",
    "phone": "+2348000000000",
    "role": "MAIN_ADMIN",
    "schoolId": "school-uuid"
  },
  "school": {
    "id": "school-uuid",
    "approvalStatus": "PENDING",
    "onboardingStatus": "IN_PROGRESS"
  },
  "redirectTo": "/onboarding"
}
```

---

### `POST /auth/login`

**Request Body:**

| Field      | Type   | Required |
|------------|--------|----------|
| `email`    | string | Yes      |
| `password` | string | Yes      |

**Response:** `200 OK` (or `201`)

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "user": { "id": "user-uuid", "role": "MAIN_ADMIN", "schoolId": "school-uuid" }
}
```

Returns `401 Invalid credentials` for a wrong email/password, `403` if the
account or membership is not active.

---

### `GET /auth/me`

Returns the authenticated user's profile, membership and school statuses.

### `POST /auth/logout`

Stateless JWT — the client discards the token. Reserved for future revocation.
Always returns `{ "success": true }`.

---

## Schools & Onboarding

### `GET /schools/me`

Roles: `MAIN_ADMIN`, `MANAGER`. Viewable **before** approval. Returns the school
with all statuses and the Main Admin's contact details.

### `POST /schools/onboarding`

Roles: `MAIN_ADMIN`. Completes onboarding — **metadata collection only**. It
never creates operational records (no drivers, students, buses, routes or
parents).

**Request Body (all optional):**

| Group                | Fields                                                                                          |
|----------------------|-------------------------------------------------------------------------------------------------|
| School information   | `name`, `type`, `ownership`, `logoUrl`, `website`                                                |
| Contact & location   | `officialEmail`, `officialPhone`, `altPhone`, `country`, `state`, `lga`, `city`, `fullAddress`    |
| Transportation       | `currentTransportationProvision`, `busCount`, `driverCount`, `studentCount`, `transportationModel` |
| Goals                | `goals`, `referralSource`                                                                        |

**Response:** `200 OK`

```json
{
  "school": { "onboardingStatus": "COMPLETED", "approvalStatus": "PENDING" },
  "redirectTo": "/school/dashboard"
}
```

Onboarding completion never auto-approves a school.

### `PATCH /schools/me`

Roles: `MAIN_ADMIN`. Edits onboarding metadata (same body as above).

### `POST /schools/resubmit`

Roles: `MAIN_ADMIN`. Moves a `REJECTED` school back to `PENDING` and clears the
rejection reason so it can be reviewed again.

---

## Super Admin

All routes require role `SUPER_ADMIN`, enforced server-side.

### `GET /super-admin/schools?approvalStatus=PENDING`

Lists schools with school info, Main Admin contact, location, transportation
snapshot, onboarding completion and registration date.

### `GET /super-admin/schools/:id`

Full detail for one school including all memberships.

### `POST /super-admin/schools/:id/approve`

`PENDING → APPROVED`. Records `approvedAt` / `approvedBy`, audits
`school_approved`, and emails the Main Admin.

### `POST /super-admin/schools/:id/reject`

`PENDING → REJECTED`. A `reason` is **required** (`400` otherwise) and stored
with `rejectedAt` / `rejectedBy`. Audits `school_rejected` and emails the Main
Admin with the reason.

**Request Body:** `{ "reason": "Missing documentation" }`

---

## Administrators (Managers)

A school may have exactly 1 Main Admin and at most 5 Managers.

### `POST /schools/administrators/invitations`

Roles: `MAIN_ADMIN` only (Managers get `403`). Enforces
`count(active managers + pending invitations) < 5` server-side inside a locked
transaction; returns `409` at the limit. Emails a single-use, time-expiring
invitation link.

**Request Body:** `{ "firstName", "lastName", "email", "phone?" }`

### `GET /schools/administrators`

Roles: `MAIN_ADMIN`. Lists admin memberships and pending invitations
(never exposes the token hash).

### `DELETE /schools/administrators/:membershipId`

Roles: `MAIN_ADMIN`. Deactivates a `MANAGER`. The Main Admin cannot be removed.

### `POST /schools/administrators/transfer`

Roles: `MAIN_ADMIN`. Atomically demotes the current Main Admin to `MANAGER` and
promotes the target active Manager to `MAIN_ADMIN`. A partial unique index
guarantees a school never has 0 or 2+ Main Admins.

**Request Body:** `{ "membershipId": "target-manager-membership-uuid" }`

---

## Invitation Acceptance

### `GET /admin-invitations/:token`

Public. Returns masked invite context (`email`, `firstName`, `lastName`,
`schoolName`, `expiresAt`) for the accept screen. `404` if used/unknown, `410` if
expired.

### `POST /admin-invitations/accept`

Public. Body: `{ "token", "password", "firstName?", "lastName?", "phone?" }`.
Creates the Manager account and an `ACTIVE` membership, then marks the invitation
`ACCEPTED`. Tokens are **single-use** — a second attempt returns `404`.

---

## Notifications

### `GET /notifications`

Lists the authenticated user's in-app notifications.

### `POST /notifications/:id/read`

Marks one of the caller's notifications as read.

---

## Audit Logs

### `GET /audit-logs`

Roles: `MAIN_ADMIN`. Returns the school's audit trail (most recent 200), scoped
to the caller's school. Entries record `actorId, schoolId, action, targetType,
targetId, metadata, createdAt`.

Logged events include: `school_registered`, `onboarding_completed`,
`school_approved`, `school_rejected`, `manager_invited`, `manager_accepted`,
`main_admin_transferred`.

---

## Error Codes

| Status Code | Description                                        |
|-------------|----------------------------------------------------|
| `400`       | Bad request / validation failure                   |
| `401`       | Unauthorized (missing/invalid token, bad creds)     |
| `403`       | Forbidden (role, tenant, or approval-gate failure)  |
| `404`       | Resource not found                                  |
| `409`       | Conflict (duplicate email, manager limit reached)   |
| `410`       | Invitation expired                                  |
| `429`       | Rate limited (auth and invitation endpoints)        |
| `500`       | Internal server error                               |
