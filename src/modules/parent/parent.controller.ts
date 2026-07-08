import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { RolesGuard } from '../../common/auth/roles.guard';
import { LoginDto } from '../../common/auth/dto/login.dto';
import { ParentService } from './parent.service';
import { RegisterParentDto } from './dto/register-parent.dto';

@Controller('parent/auth')
export class ParentController {
  constructor(private readonly parentService: ParentService) {}

  @Post('register')
  register(@Body() dto: RegisterParentDto) {
    return this.parentService.register(dto);
  }

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.parentService.login(dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('PARENT')
  @Get('me')
  me(@Req() req: { user: { sub: string } }) {
    return this.parentService.getProfile(req.user.sub);
  }
}
