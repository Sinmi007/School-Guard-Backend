import { ConfigService } from '@nestjs/config';
import { NotificationType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from './email.service';
import { NotificationsService } from './notifications.service';
import { PushService } from './push.service';

function setup() {
  const prisma = {
    notification: {
      create: jest.fn(({ data }: { data: { userId: string } }) =>
        data.userId === 'dup'
          ? Promise.reject(
              new Prisma.PrismaClientKnownRequestError('dup', {
                code: 'P2002',
                clientVersion: 'x',
              }),
            )
          : Promise.resolve({}),
      ),
    },
  };
  const push = { sendToUsers: jest.fn().mockResolvedValue(1) };
  const service = new NotificationsService(
    prisma as unknown as PrismaService,
    { sendMail: jest.fn() } as unknown as EmailService,
    { get: jest.fn() } as unknown as ConfigService,
    push as unknown as PushService,
  );
  return { service, prisma, push };
}

describe('NotificationsService.deliver', () => {
  it('stores one per user, skips users who already have the dedupe key, pushes only new ones', async () => {
    const { service, prisma, push } = setup();
    const created = await service.deliver({
      userIds: ['a', 'dup', 'a'],
      schoolId: 's1',
      type: NotificationType.STUDENT_BOARDED,
      title: 'Ada is on the bus',
      body: 'Picked up at Sabo.',
      link: '/parent',
      dedupeKey: 'trip:t1:ada:BOARDED',
    });
    expect(created).toEqual(['a']);
    expect(prisma.notification.create).toHaveBeenCalledTimes(2);
    expect(prisma.notification.create.mock.calls[0][0].data).toMatchObject({
      link: '/parent',
      dedupeKey: 'trip:t1:ada:BOARDED',
    });
    expect(push.sendToUsers).toHaveBeenCalledWith(
      ['a'],
      expect.objectContaining({ title: 'Ada is on the bus', link: '/parent' }),
    );
  });

  it('push: false stores in-app only', async () => {
    const { service, push } = setup();
    await service.deliver({
      userIds: ['a'],
      schoolId: null,
      type: NotificationType.BUS_ASSIGNED,
      title: 't',
      body: 'b',
      push: false,
    });
    expect(push.sendToUsers).not.toHaveBeenCalled();
  });
});
