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
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { RequireApprovedSchool } from '../../common/auth/require-approved-school.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import type { AuthTokenPayload } from '../../common/auth/token.service';
import { BusesService } from './buses.service';
import { CreateBusDto } from './dto/create-bus.dto';
import { ListBusesQueryDto } from './dto/list-query.dto';
import { UpdateBusDto } from './dto/update-bus.dto';

/** Fleet management (PRD M5). Approved schools only. */
@RequireApprovedSchool()
@Roles(UserRole.MAIN_ADMIN, UserRole.MANAGER)
@Controller('buses')
export class BusesController {
  constructor(private readonly buses: BusesService) {}

  @Get()
  findAll(
    @CurrentUser() user: AuthTokenPayload,
    @Query() query: ListBusesQueryDto,
  ) {
    return this.buses.findAll(user, query);
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: AuthTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.buses.findOne(user, id);
  }

  @Post()
  create(@CurrentUser() user: AuthTokenPayload, @Body() dto: CreateBusDto) {
    return this.buses.create(user, dto);
  }

  /** Any field, incl. `status` and `driverId` (null removes the driver). */
  @Patch(':id')
  update(
    @CurrentUser() user: AuthTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBusDto,
  ) {
    return this.buses.update(user, id, dto);
  }
}
