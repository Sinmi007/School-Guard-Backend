import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthTokenPayload } from './token.service';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthTokenPayload => {
    const request = ctx.switchToHttp().getRequest<{ user: AuthTokenPayload }>();
    return request.user;
  },
);
