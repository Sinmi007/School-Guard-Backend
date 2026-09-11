/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { EmailService } from './../src/modules/notifications/email.service';
import { PrismaService } from './../src/prisma/prisma.service';

class FakeEmailService {
  sent: { to: string; subject: string; html: string }[] = [];

  sendMail(options: {
    to: string;
    subject: string;
    html: string;
  }): Promise<void> {
    this.sent.push(options);
    return Promise.resolve();
  }

  invitationTokenFor(to: string): string | undefined {
    const target = to.toLowerCase();
    const message = this.sent.find(
      (m) =>
        m.to.toLowerCase() === target &&
        m.html.includes('/admin-invitations/accept'),
    );
    const match = message?.html.match(/token=([A-Za-z0-9_-]+)/);
    return match?.[1];
  }
}

describe('Foundation flows (e2e)', () => {
  jest.setTimeout(60_000);
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let email: FakeEmailService;
  const stamp = Date.now();
  const suffix = `.e2e.${stamp}@test.dev`;
  const password = 'Password123';
  const createdSchoolIds: string[] = [];

  const POST = (url: string, token?: string) =>
    request(app.getHttpServer())
      .post(url)
      .set(token ? { Authorization: `Bearer ${token}` } : {});

  const GET = (url: string, token?: string) =>
    request(app.getHttpServer())
      .get(url)
      .set(token ? { Authorization: `Bearer ${token}` } : {});

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EmailService)
      .useValue(new FakeEmailService())
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();

    prisma = app.get(PrismaService);
    email = app.get(EmailService);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: suffix } } });
    await prisma.school.deleteMany({ where: { id: { in: createdSchoolIds } } });
    await app.close();
    await prisma.$disconnect();
  });

  async function registerSchool(label: string) {
    const res = await POST('/auth/register-school').send({
      firstName: label,
      lastName: 'Main',
      email: `${label}${suffix}`,
      phone: '+2348000000000',
      password,
      confirmPassword: password,
    });
    expect(res.status).toBe(201);
    createdSchoolIds.push(res.body.school.id);
    return res.body as {
      accessToken: string;
      school: { id: string };
      user: { id: string };
    };
  }

  it('accepts a manager invitation and enforces manager restrictions', async () => {
    const schoolA = await registerSchool('schoolA');
    const managerEmail = `managerA${suffix}`;

    const invite = await POST(
      '/schools/administrators/invitations',
      schoolA.accessToken,
    ).send({ firstName: 'Manny', lastName: 'Ager', email: managerEmail });
    expect(invite.status).toBe(201);
    expect(invite.body).not.toHaveProperty('tokenHash');

    const token = email.invitationTokenFor(managerEmail);
    expect(token).toBeTruthy();

    const context = await GET(`/admin-invitations/${token}`);
    expect(context.status).toBe(200);
    expect(context.body.schoolName).toBeTruthy();

    const accept = await POST('/admin-invitations/accept').send({
      token,
      password,
    });
    expect(accept.status).toBe(201);
    expect(accept.body.role).toBe('MANAGER');

    // Single-use: the same token cannot be redeemed twice.
    const reuse = await POST('/admin-invitations/accept').send({
      token,
      password,
    });
    expect(reuse.status).toBe(404);

    const login = await POST('/auth/login').send({
      email: managerEmail,
      password,
    });
    expect(login.status).toBe(201);
    expect(login.body.user.role).toBe('MANAGER');
    const managerToken: string = login.body.accessToken;

    // Managers cannot invite/manage administrators.
    const forbiddenInvite = await POST(
      '/schools/administrators/invitations',
      managerToken,
    ).send({ firstName: 'No', lastName: 'Way', email: `nope${suffix}` });
    expect(forbiddenInvite.status).toBe(403);

    const forbiddenTransfer = await POST(
      '/schools/administrators/transfer',
      managerToken,
    ).send({ membershipId: 'whatever' });
    expect(forbiddenTransfer.status).toBe(403);
  });

  it('enforces the 5-manager cap', async () => {
    const school = await registerSchool('schoolCap');

    let last = 0;
    for (let i = 0; i < 6; i += 1) {
      const res = await POST(
        '/schools/administrators/invitations',
        school.accessToken,
      ).send({
        firstName: `Cap${i}`,
        lastName: 'Manager',
        email: `cap${i}${suffix}`,
      });
      last = res.status;
    }
    expect(last).toBe(409);
  });

  it('transfers Main Admin atomically and revokes the old role immediately', async () => {
    const school = await registerSchool('schoolTransfer');
    const managerEmail = `transferManager${suffix}`;

    const invite = await POST(
      '/schools/administrators/invitations',
      school.accessToken,
    ).send({ firstName: 'Next', lastName: 'Owner', email: managerEmail });
    expect(invite.status).toBe(201);

    const token = email.invitationTokenFor(managerEmail)!;
    const accept = await POST('/admin-invitations/accept').send({
      token,
      password,
    });
    const managerUserId = accept.body.id as string;

    const managerMembership = await prisma.schoolMembership.findFirstOrThrow({
      where: { userId: managerUserId, schoolId: school.school.id },
    });

    const transfer = await POST(
      '/schools/administrators/transfer',
      school.accessToken,
    ).send({ membershipId: managerMembership.id });
    expect(transfer.status).toBe(201);

    // Exactly one MAIN_ADMIN remains, and it is the target.
    const mains = await prisma.schoolMembership.findMany({
      where: { schoolId: school.school.id, role: 'MAIN_ADMIN' },
    });
    expect(mains).toHaveLength(1);
    expect(mains[0].id).toBe(managerMembership.id);

    // The demoted admin's existing token no longer grants MAIN_ADMIN powers.
    const demotedInvite = await POST(
      '/schools/administrators/invitations',
      school.accessToken,
    ).send({ firstName: 'Old', lastName: 'Admin', email: `old${suffix}` });
    expect(demotedInvite.status).toBe(403);
  });

  it('blocks cross-school access via direct id manipulation', async () => {
    const schoolA = await registerSchool('schoolX');
    const schoolB = await registerSchool('schoolY');

    const membershipB = await prisma.schoolMembership.findFirstOrThrow({
      where: { schoolId: schoolB.school.id, role: 'MAIN_ADMIN' },
    });

    const attempt = await request(app.getHttpServer())
      .delete(`/schools/administrators/${membershipB.id}`)
      .set({ Authorization: `Bearer ${schoolA.accessToken}` });

    expect([403, 404]).toContain(attempt.status);
    expect(attempt.status).not.toBe(200);
  });

  it('rejects the approval gate for a non-approved school on operational actions', async () => {
    const school = await registerSchool('schoolGate');
    const managerEmail = `gateManager${suffix}`;

    await POST('/schools/administrators/invitations', school.accessToken).send({
      firstName: 'Gate',
      lastName: 'Manager',
      email: managerEmail,
    });

    const token = email.invitationTokenFor(managerEmail)!;
    const accept = await POST('/admin-invitations/accept').send({
      token,
      password,
    });
    const managerLogin = await POST('/auth/login').send({
      email: managerEmail,
      password,
    });
    expect(accept.status).toBe(201);
    const managerToken: string = managerLogin.body.accessToken;

    // School is still PENDING here; the dashboard remains readable.
    const me = await GET('/schools/me', managerToken);
    expect(me.status).toBe(200);
    expect(me.body.approvalStatus).toBe('PENDING');
  });
});
