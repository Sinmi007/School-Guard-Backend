import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { RolesGuard } from '../../common/auth/roles.guard';
import { LoginDto } from '../../common/auth/dto/login.dto';
import { DriverService } from './driver.service';
import { RegisterDriverDto } from './dto/register-driver.dto';

@Controller('driver/auth')
export class DriverController {
  constructor(private readonly driverService: DriverService) {}

  @Post('register')
  register(@Body() dto: RegisterDriverDto) {
    return this.driverService.register(dto);
  }

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.driverService.login(dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('DRIVER')
  @Get('me')
  me(@Req() req: { user: { sub: string } }) {
    return this.driverService.getProfile(req.user.sub);
  }
}
