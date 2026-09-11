import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccountStatus, NotificationType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from './email.service';

interface SchoolRef {
  id: string;
  name: string;
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
  ) {}

  private get appBaseUrl(): string {
    return this.config.get<string>('APP_BASE_URL', 'http://localhost:3000');
  }

  private async createInApp(
    userId: string,
    schoolId: string | null,
    type: NotificationType,
    title: string,
    body: string,
  ): Promise<void> {
    await this.prisma.notification.create({
      data: { userId, schoolId, type, title, body },
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
        );
        await this.email.sendMail({
          to: admin.email,
          subject: `New school registration: ${school.name}`,
          html: `<p>A new school, <strong>${school.name}</strong>, was registered by ${mainAdmin.firstName} ${mainAdmin.lastName} (${mainAdmin.email}) and is awaiting approval.</p>`,
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
    const acceptUrl = `${this.appBaseUrl}/admin-invitations/accept?token=${rawToken}`;
    await this.email.sendMail({
      to: invitation.email,
      subject: `You've been invited to manage ${school.name}`,
      html: `<p>Hi ${invitation.firstName},</p><p>You have been invited to manage <strong>${school.name}</strong> on SchoolGuard.</p><p><a href="${acceptUrl}">Accept your invitation</a></p><p>This link expires and can only be used once.</p>`,
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
    );
  }
}
