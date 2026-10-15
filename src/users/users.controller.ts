import { BadRequestException, Body, Controller, Get, Headers, Patch, Post, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, Length, Matches } from 'class-validator';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Webhook } from 'svix';
import { CurrentUser, Public, type AuthUser } from '../auth/auth';
import { UsersService } from './users.service';

class UpdateMeDto {
  @IsOptional() @IsString() @Length(2, 40) name?: string;
  @IsOptional() @Matches(/^\w{3,20}$/) username?: string;
  @IsOptional() @Matches(/^\+?[\d\s-]{10,16}$/) phone?: string;
  @IsOptional() @IsDateString() dateOfBirth?: string;
}

@ApiTags('users')
@ApiBearerAuth()
@Controller()
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly config: ConfigService,
  ) {}

  @Get('me')
  me(@CurrentUser() { userId }: AuthUser) {
    return this.users.me(userId);
  }

  @Patch('me')
  update(@CurrentUser() { userId }: AuthUser, @Body() dto: UpdateMeDto) {
    return this.users.update(userId, dto);
  }

  /** Clerk → Dashboard → Webhooks → endpoint `/webhooks/clerk`, events user.created / updated / deleted. */
  @Public()
  @Post('webhooks/clerk')
  async clerkWebhook(@Req() req: RawBodyRequest<Request>, @Headers() headers: Record<string, string>) {
    const secret = this.config.get<string>('CLERK_WEBHOOK_SECRET');
    if (!secret || !req.rawBody) throw new BadRequestException('Webhook not configured');

    let evt: { type: string; data: { id: string } & Record<string, unknown> };
    try {
      evt = new Webhook(secret).verify(req.rawBody.toString('utf8'), {
        'svix-id': headers['svix-id'],
        'svix-timestamp': headers['svix-timestamp'],
        'svix-signature': headers['svix-signature'],
      }) as unknown as typeof evt;
    } catch {
      throw new BadRequestException('Invalid signature');
    }

    if (evt.type === 'user.created' || evt.type === 'user.updated') await this.users.upsertFromClerk(evt.data);
    if (evt.type === 'user.deleted') await this.users.remove(evt.data.id);
    return { received: true };
  }
}
