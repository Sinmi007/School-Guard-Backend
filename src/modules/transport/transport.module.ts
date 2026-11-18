import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { BusesController } from './buses.controller';
import { BusesService } from './buses.service';
import { RoutesController } from './routes.controller';
import { RoutesService } from './routes.service';

@Module({
  imports: [AuditModule],
  controllers: [BusesController, RoutesController],
  providers: [BusesService, RoutesService],
  exports: [BusesService, RoutesService],
})
export class TransportModule {}
