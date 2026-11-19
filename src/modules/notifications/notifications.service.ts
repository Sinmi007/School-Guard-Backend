import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AccountStatus,
  MembershipStatus,
  NotificationType,
  Prisma,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from './email.service';
import { PushService } from './push.service';

interface SchoolRef {
  id: string;
  name: string;
}

export interface DeliverInput {
  userIds: string[];
  schoolId: string | null;
  type: NotificationType;
  title: string;
  body: string;
  /** In-app path opened when the notification is tapped. */
  link?: string | null;
  /** Stored at most once per user with this key (re-sends are skipped, incl. push). */
  dedupeKey?: string;
  /** Also send to phones/browsers that turned on push (default true). */
  push?: boolean;
  /** Replaces an earlier lock-screen notification with the same tag. */
  tag?: string;
}

interface UserRef {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
    private readonly push: PushService,
  ) {}

  private readonly logger = new Logger(NotificationsService.name);

  /**
   * The one way notifications go out: stored in-app for each user (skipping
   * users who already have `dedupeKey`), then pushed to their devices.
   * Returns the users that were actually notified. Push runs in the
   * background so a slow push service never delays the caller.
   */
  async deliver(input: DeliverInput): Promise<string[]> {
    const userIds = [...new Set(input.userIds)];
    const created: string[] = [];
    await Promise.all(
      userIds.map(async (userId) => {
        try {
          await this.prisma.notification.create({
            data: {
              userId,
              schoolId: input.schoolId,
              type: input.type,
              title: input.title,
              body: input.body,
              link: input.link ?? null,
              dedupeKey: input.dedupeKey ?? null,
            },
          });
          created.push(userId);
        } catch (e) {
          // Already sent with this dedupeKey.
          if (
            e instanceof Prisma.PrismaClientKnownRequestError &&
            e.code === 'P2002'
          )
            return;
          throw e;
        }
      }),
    );
    if (created.length && input.push !== false) {
      void this.push
        .sendToUsers(created, {
          title: input.title,
          body: input.body,
          link: input.link,
          tag: input.tag,
        })
        .catch((e: Error) => this.logger.warn(`Push failed: ${e.message}`));
    }
    return created;
  }

  /** Active Main Admins and Managers of a school. */
  async schoolAdminIds(schoolId: string): Promise<string[]> {
    const rows = await this.prisma.schoolMembership.findMany({
      where: {
        schoolId,
        status: MembershipStatus.ACTIVE,
        role: { in: [UserRole.MAIN_ADMIN, UserRole.MANAGER] },
      },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  private get appBaseUrl(): string {
    return this.config.get<string>('APP_BASE_URL', 'http://localhost:3000');
  }

  private async createInApp(
    userId: string,
    schoolId: string | null,
    type: NotificationType,
    title: string,
    body: string,
    link: string | null = null,
  ): Promise<void> {
    await this.deliver({
      userIds: [userId],
      schoolId,
      type,
      title,
      body,
      link,
    });
  }

  async notifySuperAdminsOfRegistration(
    school: SchoolRef,
    mainAdmin: UserRef,
  ): Promise<void> {
    const superAdmins = await this.prisma.user.findMany({
      where: { isSuperAdmin: true, status: AccountStatus.ACTIVE },
      select: { id: true, email: true },
    });

    await Promise.all(
      superAdmins.map(async (admin) => {
        await this.createInApp(
          admin.id,
          school.id,
          NotificationType.SCHOOL_REGISTERED,
          'New school registration awaiting approval',
          `${school.name} was registered by ${mainAdmin.firstName} ${mainAdmin.lastName} and is pending approval.`,
          '/tower/schools',
        );
        await this.email.sendMail({
          to: admin.email,
          subject: `New school registration: ${school.name}`,
          html: `<p>A new school, <strong>${school.name}</strong>, was registered by ${mainAdmin.firstName} ${mainAdmin.lastName} (${mainAdmin.email}) and is awaiting approval.</p>`,
        });
      }),
    );
  }

  /** A rejected school corrected its details and asked for another review. */
  async notifySuperAdminsOfResubmission(school: SchoolRef): Promise<void> {
    const superAdmins = await this.prisma.user.findMany({
      where: { isSuperAdmin: true, status: AccountStatus.ACTIVE },
      select: { id: true, email: true },
    });

    await Promise.all(
      superAdmins.map(async (admin) => {
        await this.createInApp(
          admin.id,
          school.id,
          NotificationType.SCHOOL_REGISTERED,
          'School resubmitted for approval',
          `${school.name} updated its details after a rejection and is pending approval again.`,
          '/tower/schools',
        );
        await this.email.sendMail({
          to: admin.email,
          subject: `School resubmitted: ${school.name}`,
          html: `<p><strong>${school.name}</strong> updated its details after being rejected and is awaiting review again.</p>`,
        });
      }),
    );
  }

  async notifySchoolApproved(
    school: SchoolRef,
    mainAdmin: UserRef,
  ): Promise<void> {
    await this.createInApp(
      mainAdmin.id,
      school.id,
      NotificationType.SCHOOL_APPROVED,
      'Your school has been approved',
      `${school.name} has been approved. You now have access to operational features.`,
      '/school/dashboard',
    );
    await this.email.sendMail({
      to: mainAdmin.email,
      subject: `School approved: ${school.name}`,
      html: `<p>Good news — <strong>${school.name}</strong> has been approved. You can now set up drivers, students, buses, and routes.</p>`,
    });
  }

  async notifySchoolRejected(
    school: SchoolRef,
    mainAdmin: UserRef,
    reason: string,
  ): Promise<void> {
    await this.createInApp(
      mainAdmin.id,
      school.id,
      NotificationType.SCHOOL_REJECTED,
      'Your school registration needs attention',
      `Your registration for ${school.name} was rejected. Reason: ${reason}`,
      '/school/dashboard',
    );
    await this.email.sendMail({
      to: mainAdmin.email,
      subject: `School registration update: ${school.name}`,
      html: `<p>Your registration for <strong>${school.name}</strong> was rejected.</p><p><strong>Reason:</strong> ${reason}</p><p>You may correct the information and resubmit for review.</p>`,
    });
  }

  async notifyManagerInvited(
    invitation: { firstName: string; email: string },
    school: SchoolRef,
    rawToken: string,
  ): Promise<void> {
    // Matches the frontend route /admin-invitations/[token].
    const acceptUrl = `${this.appBaseUrl}/admin-invitations/${encodeURIComponent(rawToken)}`;
    await this.email.sendMail({
      to: invitation.email,
      subject: `You've been invited to manage ${school.name}`,
      html: `<p>Hi ${invitation.firstName},</p><p>You have been invited to manage <strong>${school.name}</strong> on SchoolGuard.</p><p><a href="${acceptUrl}">Accept your invitation</a></p><p>This link expires and can only be used once.</p>`,
    });
  }

  async notifyDriverInvited(
    driver: { firstName: string; email: string },
    school: SchoolRef,
    rawToken: string,
  ): Promise<void> {
    // Matches the frontend route /driver-invitations/[token].
    const acceptUrl = `${this.appBaseUrl}/driver-invitations/${encodeURIComponent(rawToken)}`;
    await this.email.sendMail({
      to: driver.email,
      subject: `${school.name} has added you as a driver on Àjò`,
      html: `<p>Hi ${driver.firstName},</p><p><strong>${school.name}</strong> has added you as a driver on Àjò SchoolGuard.</p><p><a href="${acceptUrl}">Set up your driver account</a></p><p>This link can only be used once and expires in 7 days.</p>`,
    });
  }

  async notifyDriverAccepted(
    inviterId: string,
    school: SchoolRef,
    driverName: string,
  ): Promise<void> {
    await this.createInApp(
      inviterId,
      school.id,
      NotificationType.DRIVER_ACCEPTED,
      'Driver account set up',
      `${driverName} accepted their invitation and can now use the Driver Portal.`,
      '/school/drivers',
    );
  }

  // ---------------------------------------------------------------------------
  // Parents (M6)
  // ---------------------------------------------------------------------------

  /** Public registration link for a school (frontend route /register/parent). */
  parentRegistrationUrl(publicToken: string): string {
    return `${this.appBaseUrl}/register/parent?school=${encodeURIComponent(publicToken)}`;
  }

  async sendParentInvite(
    email: string,
    school: SchoolRef,
    url: string,
  ): Promise<void> {
    await this.email.sendMail({
      to: email,
      subject: `Join ${school.name} on Àjò`,
      html: `<p>Hello,</p><p><strong>${school.name}</strong> uses Àjò to keep parents updated about school transport.</p><p><a href="${url}">Create your parent account</a>, then add your child using their student ID and date of birth. The school will review your request.</p>`,
    });
  }

  /** In-app alert to the school's admins that a link request is waiting. */
  async notifySchoolOfParentRequest(
    school: SchoolRef,
    parentName: string,
    studentCode: string,
  ): Promise<void> {
    const admins = await this.prisma.schoolMembership.findMany({
      where: {
        schoolId: school.id,
        status: MembershipStatus.ACTIVE,
        role: { in: [UserRole.MAIN_ADMIN, UserRole.MANAGER] },
      },
      select: { userId: true },
    });
    for (const a of admins) {
      await this.createInApp(
        a.userId,
        school.id,
        NotificationType.PARENT_LINK_REQUESTED,
        'Parent link request',
        `${parentName} asked to be linked to student ${studentCode}.`,
        '/school/parents',
      );
    }
  }

  async notifyParentAccountDecision(
    parent: { id: string; email: string; firstName: string },
    school: SchoolRef,
    approved: boolean,
    reason?: string | null,
  ): Promise<void> {
    const title = approved
      ? 'Your parent account is approved'
      : 'Your parent account was not approved';
    const body = approved
      ? `${school.name} approved your Àjò parent account.`
      : `${school.name} did not approve your parent account.${reason ? ` Reason: ${reason}` : ''}`;
    await this.createInApp(
      parent.id,
      school.id,
      approved
        ? NotificationType.PARENT_APPROVED
        : NotificationType.PARENT_REJECTED,
      title,
      body,
      '/parent',
    );
    await this.email.sendMail({
      to: parent.email,
      subject: title,
      html: `<p>Hi ${parent.firstName},</p><p>${body}</p><p><a href="${this.appBaseUrl}/login">Sign in to Àjò</a></p>`,
    });
  }

  async notifyParentLinkDecision(
    parent: { id: string; email: string; firstName: string },
    school: SchoolRef,
    studentFirstName: string,
    approved: boolean,
    reason?: string | null,
  ): Promise<void> {
    const title = approved
      ? `You're now linked to ${studentFirstName}`
      : `Your request to link to a student was not approved`;
    const body = approved
      ? `${school.name} confirmed you as ${studentFirstName}'s parent/guardian. You can now see their bus and pickup details.`
      : `${school.name} could not confirm your link request.${reason ? ` Reason: ${reason}` : ''}`;
    await this.createInApp(
      parent.id,
      school.id,
      approved
        ? NotificationType.PARENT_LINK_APPROVED
        : NotificationType.PARENT_LINK_REJECTED,
      title,
      body,
      '/parent',
    );
    await this.email.sendMail({
      to: parent.email,
      subject: title,
      html: `<p>Hi ${parent.firstName},</p><p>${body}</p><p><a href="${this.appBaseUrl}/login">Sign in to Àjò</a></p>`,
    });
  }

  /** A driver was put on a bus (only drivers who have set up their account get it). */
  async notifyBusAssigned(
    driverUserId: string,
    schoolId: string,
    bus: { code: string; plateNumber: string },
  ): Promise<void> {
    await this.deliver({
      userIds: [driverUserId],
      schoolId,
      type: NotificationType.BUS_ASSIGNED,
      title: `You're now driving ${bus.code}`,
      body: `Your school assigned you to bus ${bus.code} (${bus.plateNumber}). Your routes and stops are in the Driver app.`,
      link: '/driver',
    });
  }

  async notifyMainAdminTransferred(
    school: SchoolRef,
    newMainAdmin: { id: string },
  ): Promise<void> {
    await this.createInApp(
      newMainAdmin.id,
      school.id,
      NotificationType.MAIN_ADMIN_TRANSFERRED,
      'You are now the Main Admin',
      `You have been made the Main Admin of ${school.name}.`,
      '/school/administrators',
    );
  }
}
