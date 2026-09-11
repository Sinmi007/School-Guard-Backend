import { Body, Controller, Get, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { LoginDto } from '../../common/auth/dto/login.dto';
import { Public } from '../../common/auth/public.decorator';
import type { AuthTokenPayload } from '../../common/auth/token.service';
import { AuthService } from './auth.service';
import { RegisterSchoolDto } from './dto/register-school.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('register-school')
  registerSchool(@Body() dto: RegisterSchoolDto) {
    return this.authService.registerSchool(dto);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Get('me')
  me(@CurrentUser() user: AuthTokenPayload) {
    return this.authService.getProfile(user);
  }

  @Post('logout')
  logout() {
    // Stateless JWT — client discards the token. Reserved for future revocation.
    return { success: true };
  }
}
