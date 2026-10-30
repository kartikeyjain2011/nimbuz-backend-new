import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PlanId, Prisma, Subscription } from '@prisma/client';
import { ClerkService } from '../auth/auth';
import { activePlan, isMonths, tier, type Months } from '../common/plans';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { RazorpayService, type RzSubscription } from './razorpay.service';

const toDate = (unix?: number | null) => (unix ? new Date(unix * 1000) : null);

@Injectable()
export class SubscriptionsService {
  private readonly log = new Logger(SubscriptionsService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly razorpay: RazorpayService,
    private readonly users: UsersService,
    private readonly clerk: ClerkService,
  ) {}

  /** Mirror to Clerk publicMetadata so the website can gate play without calling the API. */
  private async mirror(userId: string, sub: Subscription | null) {
    const subscription = sub && {
      subscriptionId: sub.razorpaySubscriptionId,
      plan: sub.plan,
      months: sub.months,
      status: sub.status,
      currentEnd: sub.currentEnd ? Math.floor(sub.currentEnd.getTime() / 1000) : undefined,
      pendingPlan: sub.pendingPlan ?? undefined,
      cancelAtEnd: sub.cancelAtEnd,
    };
    await this.clerk.client.users.updateUserMetadata(userId, { publicMetadata: { subscription } }).catch((e) => this.log.warn(`Clerk mirror failed: ${e.message}`));
  }

  private async save(userId: string, data: Omit<Prisma.SubscriptionUncheckedCreateInput, 'userId'>) {
    const sub = await this.prisma.subscription.upsert({ where: { userId }, create: { userId, ...data }, update: data });
    await this.mirror(userId, sub);
    return sub;
  }

  current(userId: string) {
    return this.prisma.subscription.findUnique({ where: { userId } });
  }

  /** Active plan: our DB first, else what the website's checkout stored on the Clerk user. */
  async plan(userId: string): Promise<PlanId | null> {
    const own = activePlan(await this.current(userId));
    if (own) return own;
    try {
      const user = await this.clerk.client.users.getUser(userId);
      const s = user.publicMetadata.subscription as { plan?: PlanId; status?: string; currentEnd?: number } | undefined;
      if (!s?.plan || !s.status) return null;
      return activePlan({ plan: s.plan, status: s.status, currentEnd: s.currentEnd ? new Date(s.currentEnd * 1000) : null });
    } catch {
      return null;
    }
  }

  async checkout(userId: string, plan: PlanId, months: number) {
    if (!isMonths(months)) throw new BadRequestException('months must be 1, 3, 6 or 12');
    const user = await this.users.ensure(userId);
    const current = await this.plan(userId);
    if (current && tier(plan) <= tier(current)) throw new BadRequestException('Use downgrade for a lower or equal plan');
    const sub = await this.razorpay.create(plan, months, userId);
    return { subscriptionId: sub.id, key: this.razorpay.keyId, prefill: { name: user.name ?? undefined, email: user.email ?? undefined } };
  }

  async verify(userId: string, paymentId: string, subscriptionId: string, signature: string) {
    if (!this.razorpay.verifyCheckout(paymentId, subscriptionId, signature)) throw new BadRequestException('Payment verification failed');
    const remote = await this.razorpay.fetch(subscriptionId);
    if (remote.notes?.userId !== userId) throw new ForbiddenException('Subscription does not belong to this account');
    return this.activate(userId, remote);
  }

  /** Store a freshly paid subscription and cancel whatever it replaces. */
  private async activate(userId: string, remote: RzSubscription) {
    const plan = remote.notes?.plan as PlanId;
    const months = Number(remote.notes?.months) as Months;
    const previous = await this.current(userId);
    if (previous && previous.razorpaySubscriptionId !== remote.id) {
      await this.razorpay.cancel(previous.razorpaySubscriptionId, false).catch(() => {});
    }
    return this.save(userId, {
      razorpaySubscriptionId: remote.id,
      plan,
      months,
      status: remote.status,
      currentStart: toDate(remote.current_start),
      currentEnd: toDate(remote.current_end),
      pendingPlan: null,
      cancelAtEnd: false,
    });
  }

  async downgrade(userId: string, plan: PlanId) {
    const sub = await this.current(userId);
    const current = activePlan(sub);
    if (!sub || !current) throw new BadRequestException('No active subscription');
    if (tier(plan) >= tier(current)) throw new BadRequestException('Pick a lower plan to downgrade');
    const remote = await this.razorpay.changePlan(sub.razorpaySubscriptionId, plan, sub.months as Months);
    return this.save(userId, { ...sub, pendingPlan: plan, cancelAtEnd: false, status: remote.status, currentEnd: toDate(remote.current_end) ?? sub.currentEnd });
  }

  async cancel(userId: string) {
    const sub = await this.current(userId);
    if (!sub) throw new BadRequestException('No subscription to cancel');
    const remote = await this.razorpay.cancel(sub.razorpaySubscriptionId, true);
    return this.save(userId, { ...sub, cancelAtEnd: true, pendingPlan: null, status: remote.status, currentEnd: toDate(remote.current_end) ?? sub.currentEnd });
  }

  /** Razorpay webhooks: subscription.* lifecycle + payment.captured / failed. Idempotent by event id. */
  async handleWebhook(eventId: string, body: { event: string; payload: Record<string, { entity: Record<string, unknown> }> }) {
    const seen = await this.prisma.webhookEvent.findUnique({ where: { id: eventId } });
    if (seen) return { duplicate: true };
    await this.prisma.webhookEvent.create({ data: { id: eventId, event: body.event, payload: body as unknown as Prisma.InputJsonValue } });

    const remote = body.payload.subscription?.entity as RzSubscription | undefined;
    if (remote?.notes?.userId) {
      const userId = remote.notes.userId;
      await this.users.ensure(userId).catch(() => {});
      const sub = await this.current(userId);

      if (body.event === 'subscription.activated' && sub?.razorpaySubscriptionId !== remote.id) {
        await this.activate(userId, remote);
      } else if (sub && sub.razorpaySubscriptionId === remote.id) {
        let plan = sub.plan;
        let pendingPlan = sub.pendingPlan;
        if (pendingPlan && remote.plan_id === (await this.razorpay.planId(pendingPlan, sub.months as Months))) {
          plan = pendingPlan;
          pendingPlan = null;
        }
        await this.save(userId, { ...sub, plan, pendingPlan, status: remote.status, currentStart: toDate(remote.current_start) ?? sub.currentStart, currentEnd: toDate(remote.current_end) ?? sub.currentEnd });
      }
    }

    const payment = body.payload.payment?.entity as { id: string; amount: number; currency: string; status: string; method?: string; notes?: Record<string, string> } | undefined;
    const payer = remote?.notes?.userId ?? payment?.notes?.userId;
    if (payment && payer) {
      await this.prisma.payment.upsert({
        where: { id: payment.id },
        create: { id: payment.id, userId: payer, razorpaySubscriptionId: remote?.id, amount: payment.amount, currency: payment.currency, status: payment.status, method: payment.method },
        update: { status: payment.status },
      });
    }
    return { ok: true };
  }

  payments(userId: string) {
    return this.prisma.payment.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 50 });
  }
}
