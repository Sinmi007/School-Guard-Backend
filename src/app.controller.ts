import { Controller, Get } from '@nestjs/common';
import { Public } from './common/auth/public.decorator';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  /** Public health check — used by the platform healthcheck. */
  @Public()
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}
