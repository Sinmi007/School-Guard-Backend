import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks an endpoint as reachable without authentication. Global guards honor
 * this via `Reflector.getAllAndOverride`.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
