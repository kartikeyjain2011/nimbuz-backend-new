import { createClerkClient, verifyToken } from '@clerk/backend';
import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Global,
  Injectable,
  Module,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

export type AuthUser = { userId: string; sessionId?: string };

const IS_PUBLIC = 'isPublic';
/** Skip Clerk auth (health checks, webhooks, public catalog). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** The signed-in Clerk user on this request. */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest<Request & { auth: AuthUser }>().auth);

@Injectable()
export class ClerkService {
  readonly client;
  constructor(readonly config: ConfigService) {
    this.client = createClerkClient({ secretKey: config.getOrThrow('CLERK_SECRET_KEY'), publishableKey: config.get('CLERK_PUBLISHABLE_KEY') });
  }
}

/**
 * Global guard: every route needs a valid Clerk session token (`Authorization: Bearer <token>`)
 * unless marked @Public(). The website gets the token from Clerk's `getToken()`.
 */
@Injectable()
export class ClerkAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    const req = ctx.switchToHttp().getRequest<Request & { auth?: AuthUser }>();
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;

    if (!token) {
      if (isPublic) return true;
      throw new UnauthorizedException('Missing bearer token');
    }

    try {
      const claims = await verifyToken(token, { secretKey: this.config.getOrThrow('CLERK_SECRET_KEY') });
      req.auth = { userId: claims.sub, sessionId: claims.sid };
      return true;
    } catch {
      if (isPublic) return true;
      throw new UnauthorizedException('Invalid or expired session');
    }
  }
}

@Global()
@Module({ providers: [ClerkService], exports: [ClerkService] })
export class AuthModule {}
