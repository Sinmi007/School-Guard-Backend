import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Public } from '../../common/auth/public.decorator';
import { RequireApprovedSchool } from '../../common/auth/require-approved-school.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import type { AuthTokenPayload } from '../../common/auth/token.service';
import {
  EmailInvitesDto,
  LinkRequestDto,
  ListParentsQueryDto,
  ListRequestsQueryDto,
  ParentStatusDto,
  RegisterParentDto,
  RejectDto,
} from './dto/parents.dto';
import { ParentsService } from './parents.service';

/** School side: invite link, review queue and parent accounts (PRD M6). */
@RequireApprovedSchool()
@Roles(UserRole.MAIN_ADMIN, UserRole.MANAGER)
@Controller('parents')
export class ParentsController {
  constructor(private readonly parents: ParentsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthTokenPayload,
    @Query() query: ListParentsQueryDto,
  ) {
    return this.parents.listParents(user, query);
  }

  @Get('summary')
  summary(@CurrentUser() user: AuthTokenPayload) {
    return this.parents.summary(user);
  }

  /** Link requests; PENDING by default. */
  @Get('requests')
  requests(
    @CurrentUser() user: AuthTokenPayload,
    @Query() query: ListRequestsQueryDto,
  ) {
    return this.parents.listRequests(user, query);
  }

  @Post('requests/:id/approve')
  approve(
    @CurrentUser() user: AuthTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.parents.approveRequest(user, id);
  }

  @Post('requests/:id/reject')
  reject(
    @CurrentUser() user: AuthTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectDto,
  ) {
    return this.parents.rejectRequest(user, id, dto.reason);
  }

  /** Ends a parent↔student link (status REMOVED). */
  @Post('links/:id/remove')
  removeLink(
    @CurrentUser() user: AuthTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.parents.removeLink(user, id);
  }

  @Get('invite-link')
  inviteLink(@CurrentUser() user: AuthTokenPayload) {
    return this.parents.getInviteLink(user);
  }

  /** Main Admin only: issue a new link; old links stop working. */
  @Roles(UserRole.MAIN_ADMIN)
  @Post('invite-link/rotate')
  rotate(@CurrentUser() user: AuthTokenPayload) {
    return this.parents.rotateInviteLink(user);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('invite-link/email')
  email(@CurrentUser() user: AuthTokenPayload, @Body() dto: EmailInvitesDto) {
    return this.parents.emailInvites(user, dto.emails);
  }

  /** APPROVED / REJECTED (reason required) / SUSPENDED. */
  @Patch(':id/status')
  status(
    @CurrentUser() user: AuthTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ParentStatusDto,
  ) {
    return this.parents.setParentStatus(user, id, dto);
  }
}

/** Public: the page behind a school's parent invite link. */
@Controller('parent-registration')
export class ParentRegistrationController {
  constructor(private readonly parents: ParentsService) {}

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get(':token')
  get(@Param('token') token: string) {
    return this.parents.getRegistration(token);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post()
  register(@Body() dto: RegisterParentDto) {
    return this.parents.register(dto);
  }
}

/** The signed-in parent (Parent app). */
@Roles(UserRole.PARENT)
@Controller('parent-portal')
export class ParentPortalController {
  constructor(private readonly parents: ParentsService) {}

  @Get('me')
  me(@CurrentUser() user: AuthTokenPayload) {
    return this.parents.me(user);
  }

  /** Student ID + date of birth must both match; throttled against guessing. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('link-requests')
  requestLink(
    @CurrentUser() user: AuthTokenPayload,
    @Body() dto: LinkRequestDto,
  ) {
    return this.parents.requestLink(user, dto);
  }
}
