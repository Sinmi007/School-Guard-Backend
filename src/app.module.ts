import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { HashingModule } from './common/hashing/hashing.module';
import { AuthModule as CommonAuthModule } from './common/auth/auth.module';
import { JwtAuthGuard } from './common/auth/jwt-auth.guard';
import { RolesGuard } from './common/auth/roles.guard';
import { SchoolApprovalGuard } from './common/auth/school-approval.guard';
import { InvitationsModule } from './common/invitations/invitations.module';
import { AuthorizationModule } from './common/authorization/authorization.module';
import { AuditModule } from './modules/audit/audit.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { AuthModule } from './modules/auth/auth.module';
import { SchoolsModule } from './modules/schools/schools.module';
import { SuperAdminModule } from './modules/super-admin/super-admin.module';
import { AdministratorsModule } from './modules/administrators/administrators.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            ttl: Number(config.get<string>('THROTTLE_TTL', '60000')),
            limit: Number(config.get<string>('THROTTLE_LIMIT', '100')),
          },
        ],
      }),
    }),
    PrismaModule,
    HashingModule,
    CommonAuthModule,
    InvitationsModule,
    AuthorizationModule,
    AuditModule,
    NotificationsModule,
    AuthModule,
    SchoolsModule,
    SuperAdminModule,
    AdministratorsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: SchoolApprovalGuard },
  ],
})
export class AppModule {}
