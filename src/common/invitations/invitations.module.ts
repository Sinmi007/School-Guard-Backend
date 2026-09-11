import { Global, Module } from '@nestjs/common';
import { InvitationTokenService } from './invitation-token.service';

@Global()
@Module({
  providers: [InvitationTokenService],
  exports: [InvitationTokenService],
})
export class InvitationsModule {}
