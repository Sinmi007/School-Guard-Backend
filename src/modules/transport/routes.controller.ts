import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { RequireApprovedSchool } from '../../common/auth/require-approved-school.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import type { AuthTokenPayload } from '../../common/auth/token.service';
import { ListRoutesQueryDto } from './dto/list-query.dto';
import {
  AssignStudentsDto,
  CreateRouteDto,
  ReplaceStopsDto,
  UpdateRouteDto,
} from './dto/route.dto';
import { RoutesService } from './routes.service';

/** Routes, stops and student assignment (PRD M5). Approved schools only. */
@RequireApprovedSchool()
@Roles(UserRole.MAIN_ADMIN, UserRole.MANAGER)
@Controller('routes')
export class RoutesController {
  constructor(private readonly routes: RoutesService) {}

  @Get()
  findAll(
    @CurrentUser() user: AuthTokenPayload,
    @Query() query: ListRoutesQueryDto,
  ) {
    return this.routes.findAll(user, query);
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: AuthTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.routes.findOne(user, id);
  }

  @Post()
  create(@CurrentUser() user: AuthTokenPayload, @Body() dto: CreateRouteDto) {
    return this.routes.create(user, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRouteDto,
  ) {
    return this.routes.update(user, id, dto);
  }

  /** Full ordered list; stops sent with `id` are kept, missing ones removed. */
  @Put(':id/stops')
  replaceStops(
    @CurrentUser() user: AuthTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReplaceStopsDto,
  ) {
    return this.routes.replaceStops(user, id, dto.stops);
  }

  /** Add/move students onto this route (with optional pickup stops). */
  @Post(':id/students')
  assign(
    @CurrentUser() user: AuthTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignStudentsDto,
  ) {
    return this.routes.assignStudents(user, id, dto);
  }

  @Delete(':id/students/:studentId')
  unassign(
    @CurrentUser() user: AuthTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('studentId', ParseUUIDPipe) studentId: string,
  ) {
    return this.routes.unassignStudent(user, id, studentId);
  }
}
