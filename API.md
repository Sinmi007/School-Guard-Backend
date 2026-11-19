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
11. [Students](#students)
12. [Drivers](#drivers)
13. [Buses & Routes](#buses--routes)
14. [Parents](#parents)
15. [Trips](#trips)
16. [Live Tracking](#live-tracking)
17. [Error Codes](#error-codes)

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

What a school can do at each status:

| | `PENDING` | `REJECTED` | `APPROVED` |
|---|---|---|---|
| View school, dashboard counts, audit logs, administrators | ✅ | ✅ | ✅ |
| Edit school details (`PATCH /schools/me`) | ❌ `409` (under review) | ✅ | ✅ |
| Resubmit (`POST /schools/resubmit`) | — | ✅ | — |
| Invite managers | ❌ `403` | ❌ `403` | ✅ |
| Students (all endpoints) | ❌ `403` | ❌ `403` | ✅ |

Future operational endpoints (drivers, buses, routes, parents, trips) declare
the same gate.

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
with all statuses, the Main Admin's contact details, and the transport
estimates as flat fields (`busCount`, `driverCount`, `studentCount`,
`transportationModel`, `currentTransportationProvision`).

### `GET /schools/me/overview`

Roles: `MAIN_ADMIN`, `MANAGER`. Dashboard counts, available at any status
(a pending school sees zeros):

```json
{
  "students": { "total": 0, "active": 0, "activeWithoutTransport": 0 },
  "administrators": { "managers": 0, "pendingInvitations": 0, "maxManagers": 5 },
  "drivers": { "total": 0, "active": 0, "invited": 0, "licenseWarnings": 0 },
  "buses": { "total": 0, "active": 0, "maintenance": 0 },
  "routes": { "total": 0, "active": 0, "studentsAssigned": 0 },
  "parents": { "total": 0, "approved": 0, "pending": 0, "pendingRequests": 0 },
  "tripsToday": { "inProgress": 0, "completed": 0 }
}
```

`licenseWarnings` = active/invited drivers whose licence has expired or expires
within 30 days.

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

Onboarding completion never auto-approves a school. It can only be submitted
once — a second call returns `409`; later changes go through `PATCH /schools/me`.

### `PATCH /schools/me`

Roles: `MAIN_ADMIN`. Edits school details (same body as above). Allowed when
`REJECTED` (to fix and resubmit) or `APPROVED`; returns `409` while `PENDING`
so the Super Admin reviews exactly what was submitted. Audited as
`school_details_updated`.

### `POST /schools/resubmit`

Roles: `MAIN_ADMIN`. Moves a `REJECTED` school back to `PENDING` and clears the
rejection reason so it can be reviewed again. Audited as `school_resubmitted`
(with the previous reason) and notifies all Super Admins in-app and by email.

---

## Super Admin

All routes require role `SUPER_ADMIN`, enforced server-side.

### `GET /super-admin/overview`

Real platform counts for the Super Admin dashboard:

```json
{
  "schools": { "pending": 4, "approved": 2, "rejected": 0, "onboardingInProgress": 2, "newThisWeek": 8 },
  "activeStudents": 0,
  "schoolAdmins": 8
}
```

`pending` counts only schools that submitted their details;
`onboardingInProgress` are registrations that haven't yet.

### `GET /super-admin/schools?approvalStatus=PENDING`

Lists schools with school info, Main Admin contact, location, transport
estimates (flat fields), onboarding completion and registration date. With
`approvalStatus=PENDING` only schools that **finished onboarding** are
returned — unsubmitted registrations aren't reviewable.

### `GET /super-admin/schools/:id`

Full detail for one school including all memberships.

### `POST /super-admin/schools/:id/approve`

`PENDING → APPROVED`. Records `approvedAt` / `approvedBy`, audits
`school_approved`, and emails the Main Admin. Approve and reject both return
`400` if the school hasn't finished onboarding.

### `POST /super-admin/schools/:id/reject`

`PENDING → REJECTED`. A `reason` is **required** (`400` otherwise) and stored
with `rejectedAt` / `rejectedBy`. Audits `school_rejected` and emails the Main
Admin with the reason.

**Request Body:** `{ "reason": "Missing documentation" }`

---

## Administrators (Managers)

A school may have exactly 1 Main Admin and at most 5 Managers.

### `POST /schools/administrators/invitations`

Roles: `MAIN_ADMIN` only (Managers get `403`). Requires an **`APPROVED`**
school (`403` otherwise — adding managers is an operational action). Enforces
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
to the caller's school, as a plain array. Entries record `actorId, schoolId,
action, targetType, targetId, metadata, createdAt`, plus `actorName` and
`actorEmail` (null when the actor has been deleted).

Logged events include: `school_registered`, `onboarding_completed`,
`school_approved`, `school_rejected`, `manager_invited`, `manager_accepted`,
`main_admin_transferred`, `student_created`, `student_updated`,
`student_status_changed`, `student_import_started` (file uploaded),
`student_import_completed` (rows committed on confirm), `student_import_failed`
(file rejected), `driver_created`, `driver_invitation_resent`, `driver_accepted`,
`driver_updated`, `driver_status_changed` (metadata: `from`, `to`, `reason?`),
`bus_created`, `bus_updated`, `bus_driver_changed`, `route_created`, `route_updated`,
`route_stops_updated`, `students_assigned_to_route`, `student_unassigned_from_route`,
`student_transport_removed` (student no longer active) and `driver_removed_from_bus`
(driver deactivated), `parent_invited`, `parent_invite_link_rotated`,
`parent_registered`, `parent_approved`, `parent_rejected`, `parent_suspended`,
`parent_link_requested`, `student_relationship_approved`,
`student_relationship_rejected`, `student_relationship_removed`, `trip_started`,
`trip_ended` (metadata `stillOnBoard` when force-ended), `trip_cancelled`.

---

## Students

Roles: `MAIN_ADMIN`, `MANAGER`. **Every endpoint requires an `APPROVED` school**
(`403` otherwise). All data is scoped to the caller's school.

`studentId` is the school-scoped durable identifier. It is generated as
`AJO-000001`, `AJO-000002`, … from a per-school counter (safe under concurrent
requests), or taken from the CSV when the file supplies one.

| Method & path | Description |
|---|---|
| `GET /students?search=&classGrade=&status=&transport=&page=1&limit=20` | List/search. `search` matches name or `studentId` (every word must match, so `ada obi` works). `transport` = `ASSIGNED`\|`UNASSIGNED`. `limit` ≤ 100. Returns `{ data, meta: { total, page, limit, totalPages } }`; each student includes `transportAssignment` (null until Milestone 5) |
| `GET /students/summary` | `{ total, byStatus: { ACTIVE, INACTIVE, GRADUATED, TRANSFERRED_OUT }, activeWithoutTransport }` |
| `GET /students/:id` | One student (with `transportAssignment`) |
| `POST /students` | Create. Body: `firstName, lastName, dateOfBirth (YYYY-MM-DD, not in the future), gender (MALE\|FEMALE\|OTHER), classGrade (NURSERY_1…SS_3\|OTHER), address, guardianName, guardianPhone` |
| `PATCH /students/:id` | Partial update (`studentId` is immutable); `status` (`ACTIVE\|INACTIVE\|GRADUATED\|TRANSFERRED_OUT`) changes are audited with from/to |
| `DELETE /students/:id` | Soft delete → `TRANSFERRED_OUT` (never hard-deleted) |

### CSV import (two steps)

**1. `POST /students/import`** — `multipart/form-data`, field `file`.
- `.csv` or `.xlsx` (first worksheet; max 5 MB, 5,000 rows). The file's
  bytes must match its extension. Legacy `.xls` is rejected with a message to
  re-save as `.xlsx`. Rate limited to 5 uploads/minute.
- Header names are flexible (case/spaces ignored), e.g. `First Name`/`firstName`,
  `Surname`/`lastName`, `DOB`, `Sex` (`M`/`F` accepted), `Class` (`Primary 3`,
  `JSS1` accepted), `Parent Name`, `Parent Phone`. Optional `Student ID` /
  `Admission No` column keeps the school's own IDs.
- Dates: `YYYY-MM-DD` or day-first `DD/MM/YYYY` (also `-` / `.`), or real
  Excel date cells. Excel-mangled phone numbers (`8012345678`) get their
  leading `0` restored. Excel formula cells are never evaluated — the row is
  rejected.
- Validates synchronously and returns the preview. **Nothing is saved as a
  student yet.**

```json
{
  "importId": "uuid",
  "status": "COMPLETED",
  "totalRows": 7, "validCount": 4, "errorCount": 3, "duplicateCount": 2,
  "errorRows": [ { "rowIndex": 2, "errors": ["studentId ADM-1 also appears in row 0"] } ],
  "duplicateRows": [ { "rowIndex": 4, "duplicateOf": "row 0" },
                     { "rowIndex": 6, "duplicateOf": "AJO-000001" } ]
}
```

- `errorRows` are never imported (missing/invalid fields, duplicate `studentId`
  in the file or already in the school, spreadsheet formulas in cells).
- `duplicateRows` are *warnings* (same name + date of birth + class as an
  existing student or an earlier row) — imported unless excluded in step 2.
- A structurally bad file (missing columns, no rows, too many rows) returns
  `400` with `{ message, importId }` and is recorded as a `FAILED` import.

**2. `POST /students/imports/:importId/confirm`** — body (optional):
`{ "excludeRowIndexes": [6] }`. Commits all valid rows except the excluded
ones, all-or-nothing. Returns `{ committed, excluded, students: [{ rowIndex, studentId }] }`.
A second confirm returns `409`.

**History:** `GET /students/imports` (newest first: status, counts,
`committedCount`, `failureReason`) and `GET /students/imports/:importId`
(every row with `errorMessages`, `isDuplicate`, `duplicateOf`,
`committedStudentId`).

Import status: `PROCESSING` → `COMPLETED` (preview ready) → `CONFIRMED`, or `FAILED`.

---

## Drivers

Milestone 4. School endpoints need `MAIN_ADMIN` or `MANAGER` **and an approved
school** (403 otherwise). Every query is scoped to the caller's school; another
school's driver id returns `404`.

**Lifecycle:** `INVITED` (record created, invitation emailed) → `ACTIVE` (driver
accepted and set a password) ⇄ `SUSPENDED`, and `ACTIVE`/`SUSPENDED` → `INACTIVE`
(left the school) → `ACTIVE`. An admin can never set `ACTIVE` on a driver who
hasn't accepted. Suspending/deactivating updates the driver's membership, so the
driver is locked out on their very next request.

**Driver object** (all school endpoints):

```json
{
  "id": "uuid", "driverId": "DRV-000001", "status": "INVITED",
  "firstName": "Musa", "lastName": "Bello",
  "email": "musa@example.com", "phone": "08031234567",
  "dateOfBirth": "1985-03-02", "gender": "MALE", "address": "…",
  "licenseNumber": "LAG12345AA1", "licenseClass": "E",
  "licenseExpiry": "2027-06-05", "licenseIssuingState": "Lagos",
  "yearsOfExperience": 8,
  "emergencyContactName": "Aisha Bello", "emergencyContactPhone": "08039876543",
  "licenseState": "VALID",
  "hasAccount": false,
  "activatedAt": null, "createdAt": "…", "updatedAt": "…"
}
```

- `driverId` is generated per school (`DRV-000001`, …) and never changes.
- `licenseNumber` is stored upper-case without spaces; unique per school.
- `email` is the driver's login; unique per school and must not already belong
  to any Àjò account. It can be edited until the driver has set up their account.
- `licenseState`: `EXPIRED`, `EXPIRING_SOON` (within 30 days) or `VALID`. An expired
  licence is accepted (so schools can record drivers mid-renewal) and flagged.
- Dates are `YYYY-MM-DD`.

### `POST /drivers`

Body: `firstName`, `lastName`, `email`, `phone`, `licenseNumber`,
`licenseExpiry` (required); `dateOfBirth`, `gender`, `address`, `licenseClass`,
`licenseIssuingState`, `yearsOfExperience` (0–60), `emergencyContactName`,
`emergencyContactPhone` (optional). Creates the driver as `INVITED` and emails a
single-use invitation link (`{APP_BASE_URL}/driver-invitations/{token}`, valid
`INVITATION_TTL_HOURS`, default 7 days). Returns the driver detail (below).
`409` on duplicate licence/email or an email that already has an account.

### `GET /drivers?search=&status=&license=&page=&limit=`

`search` matches name, driverId, email, phone and licence number (every word
must match). `status`: a driver status. `license`: `EXPIRED` | `EXPIRING_SOON` |
`VALID`. Returns `{ data: Driver[], meta: { total, page, limit, totalPages } }`.

### `GET /drivers/summary`

`{ total, byStatus: { INVITED, ACTIVE, SUSPENDED, INACTIVE }, licenseExpired,
licenseExpiringSoon }` (licence counts only include active/invited drivers).

### `GET /drivers/:id`

Driver plus `createdByName` and `invitation` (latest: `status`, `email`,
`expiresAt`, `createdAt`, `acceptedAt`; a pending invitation past its expiry is
reported as `EXPIRED`). Never includes the token.

### `PATCH /drivers/:id`

Any create field. Send `null` to clear an optional field. Changing `email` after
the driver has an account → `400`. Audited as `driver_updated` with the changed
field names.

### `PATCH /drivers/:id/status`

Body: `{ "status": "ACTIVE" | "SUSPENDED" | "INACTIVE", "reason?": "…" }`.
`INACTIVE` on an `INVITED` driver cancels the invitation (the link stops
working). Disallowed transitions → `400`.

### `POST /drivers/:id/resend-invitation`

Revokes the pending link and emails a new one. Works for `INVITED` drivers and
re-opens a cancelled invitation (`INACTIVE` without an account → `INVITED`).
`400` once the driver has set up their account.

### `POST /drivers/:id/invite-link`

Same eligibility as resend, but **no email is sent**: returns `{ path:
"/driver-invitations/<token>", expiresAt, driver }` for the admin to share
themselves (copy / WhatsApp). The app prefixes its own address. Tokens are stored
hashed, so this always issues a new link and revokes the previous one. Audited as
`driver_invite_link_created`.

### `GET /driver-invitations/:token`

Public. `{ email, firstName, lastName, driverId, schoolName, expiresAt }` for the
accept screen. `404` unknown/used/revoked, `410` expired.

### `POST /driver-invitations/accept`

Public. Body: `{ "token", "password" }` (8–128 chars). Creates the `DRIVER` user
and membership, sets the driver `ACTIVE`, notifies the inviter in-app. Single-use
(second attempt → `404`). The driver then signs in with `POST /auth/login`.

### `GET /driver-portal/me`

Role `DRIVER`. The signed-in driver's own record plus `schoolName` and `bus`
(null when not assigned): `{ id, code, plateNumber, capacity, make, vehicleModel,
color, status, routes: [{ id, name, morningDeparture, afternoonDeparture,
studentCount, stops: [{ id, sequence, name, landmark, pickupTime, dropoffTime,
students: [{ id, studentId, firstName, lastName, classGrade }] }],
unplacedStudents: [...] }] }` — only `ACTIVE` routes. `403` while
suspended/inactive. School-side driver responses also include `bus`
(`{ id, code, plateNumber }` or null).

---

## Buses & Routes

Milestone 5. All endpoints need `MAIN_ADMIN` or `MANAGER` **and an approved
school**; everything is scoped to the caller's school (another school's ids →
`404`/`400`).

**Rules**

- A bus has at most one driver and a driver drives at most one bus. Only
  `ACTIVE` or `INVITED` drivers can be assigned.
- A route has at most one bus; a bus may serve several routes (e.g. morning and
  afternoon). Students ride the bus of their route.
- A route can never hold more students than its bus has seats (`409`).
- Deactivating a driver removes them from their bus. A student who stops being
  `ACTIVE` (incl. transferred out) loses their route assignment.
- Times are 24-hour `"HH:MM"`.

### Buses

`GET /buses?search=&status=` → `Bus[]` (ordered by code). `search` matches code,
plate, make/model and driver name; `status`: `ACTIVE` | `MAINTENANCE` | `RETIRED`.

```json
{
  "id": "uuid", "code": "AJO-03", "plateNumber": "LAG123AA", "capacity": 30,
  "make": "Toyota", "vehicleModel": "Coaster", "year": 2019, "color": "Yellow",
  "notes": null, "status": "ACTIVE", "driverId": "uuid",
  "driver": { "id", "driverId", "firstName", "lastName", "phone", "status" },
  "routes": [{ "id", "name", "status", "studentCount": 12 }],
  "maxRouteLoad": 12
}
```

`GET /buses/:id` → `Bus`.

`POST /buses` — `code`, `plateNumber` (both stored upper-case without spaces,
unique per school), `capacity` (1–100) required; `make`, `vehicleModel`, `year`,
`color`, `notes`, `driverId` optional.

`PATCH /buses/:id` — any of the above plus `status`; `driverId: null` removes
the driver. Retiring requires the bus to be on no route (`409`) and removes its
driver. Lowering `capacity` below a route's student count → `409`.

### Routes

`GET /routes?search=&status=` → summaries: route fields plus `bus` (with
driver), `stopCount`, `firstStop`, `lastStop`, `studentCount`. `search`
matches route name, stop names and bus code.

`GET /routes/:id` → route plus `bus`, `stops` (ordered, each with
`studentCount`), `students` (`id, studentId, firstName, lastName, classGrade,
status, pickupStop`), `studentCount`, `seatsLeft` (null without a bus).

`POST /routes` — `name` (unique per school, case-insensitive) required;
`description`, `busId` (not retired), `morningDeparture`, `afternoonDeparture`,
`stops` (initial ordered list) optional.

`PATCH /routes/:id` — same fields plus `status` (`ACTIVE` | `INACTIVE`).
Changing the bus moves every student on the route to it (`409` if they don't
fit). Deactivating a route that still has students → `409`.

`PUT /routes/:id/stops` — `{ "stops": [{ "id?", "name", "landmark?", "address?",
"latitude?", "longitude?", "pickupTime?", "dropoffTime?" }] }`, the full ordered
list (max 60). Stops sent with their `id` are kept (with their students), new
ones are created, missing ones deleted — unless students are picked up there
(`409`).

`POST /routes/:id/students` — `{ "assignments": [{ "studentId", "pickupStopId?" }] }`
(max 200). Adds students (or moves them from another route) and sets their
pickup stop, which must be on this route. Only `ACTIVE` students; the route must
be `ACTIVE`; capacity enforced. Sending a student already on the route just
changes their stop.

`DELETE /routes/:id/students/:studentId` — removes the student from the route.

Student responses (`GET /students`, `GET /students/:id`) include
`transportAssignment` with `route { id, name }`, `pickupStop { id, name,
pickupTime }` and `bus { id, code, plateNumber }`.

---

## Parents

Milestone 6. Parents register through their school's **public link**, then ask
to be linked to their children. The school reviews every request.

**Access rule:** a parent only ever receives details of students whose link is
`APPROVED`; this is enforced in the queries themselves. Parents can't browse or
search the roster.

**Statuses** — account: `PENDING` → `APPROVED` / `REJECTED`, `SUSPENDED`
(locked out). Link: `PENDING` → `APPROVED` / `REJECTED`, or `REMOVED` (unlinked).
Approving a link also approves a pending account. Rejecting an account rejects
its open requests.

### Registration (public)

`GET /parent-registration/:token` → `{ schoolName }`. `token` is the school's
opaque `publicToken` (never an internal id). `404` if unknown, or the school is
not approved/active.

`POST /parent-registration` — `{ schoolToken, firstName, lastName, email, phone,
password, confirmPassword }`. Creates the user, a `PARENT` membership in the
token's school and a `PENDING` parent account; returns `{ accessToken, user,
schoolName, redirectTo: "/parent" }`. `409` if the email already has an account.
Throttled to 5/min.

### Parent portal (role `PARENT`)

`GET /parent-portal/me` → `{ id, status, rejectionReason, firstName, lastName,
email, phone, schoolName, links: [{ id, status, relationship, rejectionReason,
createdAt, reviewedAt, studentCode, student }] }`. `student` is null unless the
link is `APPROVED`; then it has `studentId, firstName, lastName, classGrade,
status, transport { pickupStop { name, landmark, pickupTime, dropoffTime },
route { name, morningDeparture, afternoonDeparture }, bus { code, plateNumber,
color, make, vehicleModel, status, driver { firstName, lastName, phone } } }`
(`pickupStop` also has `latitude`/`longitude`) and `todayTrips: [{ direction,
tripStatus, startedAt, endedAt, status, boardedAt, droppedOffAt, stop }]`.

`POST /parent-portal/link-requests` — `{ studentId: "AJO-000123", dateOfBirth:
"2015-04-15", relationship, note? }`. Both the student ID **and** date of birth
must match a student in the parent's own school; every miss returns the same
`404` so the roster can't be probed. `409` if already pending/linked; `403` if the
account was rejected; max 10 open requests; throttled to 10/min. A previously
rejected/removed link re-opens as `PENDING`. Records whether the parent's phone
matches the student's guardian phone (`phoneMatchesGuardian`, a reviewer hint).

### School side (`MAIN_ADMIN`, `MANAGER`; approved school)

- `GET /parents/invite-link` → `{ url, schoolName }` (`{APP_BASE_URL}/register/parent?school=<publicToken>`).
- `POST /parents/invite-link/rotate` — Main Admin only; new token, old links stop working.
- `POST /parents/invite-link/email` — `{ emails: [...] }` (1–50); emails the link. Throttled 5/min.
- `GET /parents/requests?status=` — link requests (default `PENDING`), each with
  `parent` (name, email, phone, account status) and `student` (incl. the school's
  `dateOfBirth`, `guardianName`, `guardianPhone` for comparison).
- `POST /parents/requests/:id/approve` · `POST /parents/requests/:id/reject` (`{ reason }` required).
- `POST /parents/links/:id/remove` — unlink (parent loses access to that child).
- `GET /parents?status=&search=` — parent accounts with their links.
- `GET /parents/summary` → `{ total, approved, pending, pendingRequests }`.
- `PATCH /parents/:id/status` — `{ status: APPROVED | REJECTED | SUSPENDED, reason? }`
  (reason required for `REJECTED`). Suspension locks the parent out immediately.

Parents are emailed (and notified in-app) when their account or a link is
approved/rejected; school admins get an in-app notification for each new request.
`GET /students/:id` includes `parents` (confirmed parents/guardians).

---

## Trips

Milestone 7. A trip is one run of a route (`MORNING` = home → school,
`AFTERNOON` = school → home) on a school day. The school day is computed in
`SCHOOL_TIMEZONE` (default `Africa/Lagos`).

**Rules**

- A route runs at most once per day in each direction (cancelled runs excepted);
  a driver has at most one trip in progress. Both are enforced by database
  indexes and surface as `409`.
- Starting a trip snapshots the route's `ACTIVE` students (at their pickup stops)
  into the trip's manifest.
- Student states: `PENDING` → `BOARDED` | `ABSENT`; `BOARDED` → `DROPPED_OFF`.
  Each step can be undone one step back while the trip is running.
- Ending a **morning** trip marks everyone still on board as dropped off (arrived
  at school). Ending an **afternoon** trip while a child is still `BOARDED` returns
  `409` (`{ message, onBoard: [studentIds] }`) unless `force: true`; the count is
  kept as `endedWithOnBoard` and flagged to the school and parents.

### Driver (role `DRIVER`)

- `GET /driver-portal/trips/today` → `{ serviceDate, bus, activeTripId, routes: [{ id,
  name, morningDeparture, afternoonDeparture, studentCount, runs: [{ direction,
  trip: { id, status, startedAt, endedAt, counts } | null }] }] }` (active routes on
  the driver's bus).
- `POST /driver-portal/trips` — `{ routeId, direction }` → trip detail. Route must be
  served by the driver's bus; driver must be `ACTIVE`.
- `GET /driver-portal/trips/:id` → trip detail (own trips only).
- `POST /driver-portal/trips/:id/students/:studentId` — `{ status }` → trip detail.
- `POST /driver-portal/trips/:id/end` — `{ force? }` → trip detail.

**Trip detail:** `{ id, direction, status, serviceDate, startedAt, endedAt,
cancelledReason, endedWithOnBoard, route, bus, driver, counts: { total, PENDING,
BOARDED, DROPPED_OFF, ABSENT }, students: [{ studentId, code, firstName, lastName,
classGrade, stop, status, boardedAt, droppedOffAt }] }` (students ordered by stop).

### School (`MAIN_ADMIN`, `MANAGER`; approved school)

- `GET /trips?date=YYYY-MM-DD` (default today) → `{ serviceDate, trips: [...] }` with
  route, bus, driver and `counts`.
- `GET /trips/:id` → trip detail.
- `POST /trips/:id/cancel` — `{ reason }`; only trips in progress.

### Stop coordinates

`PUT /routes/:id/stops` accepts `latitude`/`longitude` per stop (set by clicking an
OpenStreetMap map in the route editor); they're returned on stops everywhere.

---

## Live Tracking

Milestone 8. While a trip is `IN_PROGRESS` the driver's phone sends GPS fixes;
the school and the child's parents read the latest position by polling (every
~15 s in the apps). No WebSockets: plain HTTP suits the hosting and sleeping
instances.

**Location object** (wherever a live position appears): `{ lat, lng, at,
speedKmh, stale }`. `stale` = no fix for over 2 minutes.

### Driver

`POST /driver-portal/trips/:id/locations` — `{ points: [{ lat, lng, recordedAt,
speedMps?, heading?, accuracyM? }] }` (1–200 points; the app sends every ~10 s
and batches fixes queued while offline). Own running trip only. Points older
than the trip (minus 5 min), in the future, or less accurate than 1 km are
dropped. Returns `{ accepted, ended }`; after the trip ends, late batches are
accepted as `{ accepted: 0, ended: true }` rather than erroring.

### School (`MAIN_ADMIN`, `MANAGER`)

- `GET /trips/live` → today's running trips: `{ id, direction, startedAt, route {
  id, name, stops[] }, bus, driver, onBoard, total, location }`.
- `GET /trips/:id/path` → `{ tripId, status, stops, location, points: [{ lat, lng,
  at }] }` (thinned to at most 500 points).

### Parent (role `PARENT`)

`GET /parent-portal/live` → one entry per **approved** child on a trip that's
running now **and** who is still waiting for the bus or riding it:
`{ studentId, studentCode, firstName, tripId, direction, childStatus, bus,
location, stop { name, latitude, longitude }, eta }`. Once the child is dropped
off or marked absent, the parent no longer receives the bus position.

`eta` (or null) — `{ minutes, distanceKm, arriving }` — is given only while the
bus is heading to the child's stop (morning: not yet picked up; afternoon: on
board), the fix isn't stale and the stop has coordinates. It's straight-line
distance × 1.3 (roads) at the bus's current speed (10–60 km/h) or 20 km/h when
slower; `arriving` within 300 m.

### Retention

GPS breadcrumbs are deleted after 30 days (checked whenever a trip starts).

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
