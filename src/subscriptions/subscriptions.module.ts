import { createHash } from 'node:crypto';
import { BadRequestException, Body, Controller, Get, Global, Headers, HttpCode, Module, Post, Req, type RawBodyRequest } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PlanId } from '@prisma/client';
import { IsEnum, IsIn, IsString } from 'class-validator';
import type { Request } from 'express';
import { CurrentUser, Public, type AuthUser } from '../auth/auth';
import { RazorpayService } from './razorpay.service';
import { SubscriptionsService } from './subscriptions.service';

class CheckoutDto {
  @IsEnum(PlanId) plan!: PlanId;
  @IsIn([1, 3, 6, 12]) months!: number;
}

class VerifyDto {
  @IsString() razorpay_payment_id!: string;
  @IsString() razorpay_subscription_id!: string;
  @IsString() razorpay_signature!: string;
}

class ChangeDto {
  @IsEnum(PlanId) plan!: PlanId;
}

@ApiTags('subscription')
@ApiBearerAuth()
@Controller()
export class SubscriptionsController {
  constructor(
    private readonly subs: SubscriptionsService,
    private readonly razorpay: RazorpayService,
  ) {}

  @Get('subscription')
  current(@CurrentUser() { userId }: AuthUser) {
    return this.subs.current(userId);
  }

  @Get('subscription/payments')
  payments(@CurrentUser() { userId }: AuthUser) {
    return this.subs.payments(userId);
  }

  @Post('subscription/checkout')
  checkout(@CurrentUser() { userId }: AuthUser, @Body() dto: CheckoutDto) {
    return this.subs.checkout(userId, dto.plan, dto.months);
  }

  @Post('subscription/verify')
  verify(@CurrentUser() { userId }: AuthUser, @Body() dto: VerifyDto) {
    return this.subs.verify(userId, dto.razorpay_payment_id, dto.razorpay_subscription_id, dto.razorpay_signature);
  }

  @Post('subscription/downgrade')
  downgrade(@CurrentUser() { userId }: AuthUser, @Body() dto: ChangeDto) {
    return this.subs.downgrade(userId, dto.plan);
  }

  @Post('subscription/cancel')
  cancel(@CurrentUser() { userId }: AuthUser) {
    return this.subs.cancel(userId);
  }

  /** Razorpay Dashboard → Webhooks → `/webhooks/razorpay`, with subscription.* and payment.* events. */
  @Public()
  @Post('webhooks/razorpay')
  @HttpCode(200)
  webhook(@Req() req: RawBodyRequest<Request>, @Headers('x-razorpay-signature') signature?: string, @Headers('x-razorpay-event-id') eventId?: string) {
    if (!req.rawBody || !signature || !this.razorpay.verifyWebhook(req.rawBody, signature)) throw new BadRequestException('Invalid signature');
    const id = eventId ?? `sha256:${createHash('sha256').update(req.rawBody).digest('hex')}`;
    return this.subs.handleWebhook(id, req.body);
  }
}

@Global()
@Module({ controllers: [SubscriptionsController], providers: [SubscriptionsService, RazorpayService], exports: [SubscriptionsService] })
export class SubscriptionsModule {}
