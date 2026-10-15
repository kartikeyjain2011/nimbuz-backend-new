import { createHmac, timingSafeEqual } from 'node:crypto';
import { BadGatewayException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlanId } from '@prisma/client';
import { cyclePrice, PLANS, type Months } from '../common/plans';

const API = 'https://api.razorpay.com/v1';

export type RzSubscription = {
  id: string;
  plan_id: string;
  status: string;
  current_start?: number | null;
  current_end?: number | null;
  notes?: Record<string, string>;
};

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

@Injectable()
export class RazorpayService {
  private readonly planCache = new Map<string, string>();
  constructor(private readonly config: ConfigService) {}

  get keyId() {
    return this.config.getOrThrow<string>('RAZORPAY_KEY_ID');
  }

  private async rz<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const auth = Buffer.from(`${this.keyId}:${this.config.getOrThrow<string>('RAZORPAY_KEY_SECRET')}`).toString('base64');
    const res = await fetch(`${API}${path}`, { method, headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const json = (await res.json().catch(() => ({}))) as { error?: { description?: string } };
    if (!res.ok) throw new BadGatewayException(json.error?.description ?? `Razorpay request failed (${res.status})`);
    return json as T;
  }

  /** Razorpay plan for a Nimbus plan + billing cycle, created on first use and reused after. */
  async planId(plan: PlanId, months: Months) {
    const key = `nimbus-${plan}-${months}m-${cyclePrice(plan, months)}`;
    const cached = this.planCache.get(key);
    if (cached) return cached;

    const existing = await this.rz<{ items: { id: string; notes?: Record<string, string> }[] }>('/plans?count=100');
    const found = existing.items.find((p) => p.notes?.key === key);
    const id =
      found?.id ??
      (
        await this.rz<{ id: string }>('/plans', 'POST', {
          period: 'monthly',
          interval: months,
          item: { name: `Nimbus ${PLANS[plan].name} · ${months} month${months > 1 ? 's' : ''}`, amount: cyclePrice(plan, months) * 100, currency: 'INR' },
          notes: { key, plan, months: String(months) },
        })
      ).id;
    this.planCache.set(key, id);
    return id;
  }

  async create(plan: PlanId, months: Months, userId: string) {
    return this.rz<RzSubscription>('/subscriptions', 'POST', {
      plan_id: await this.planId(plan, months),
      total_count: Math.ceil(120 / months),
      customer_notify: 1,
      notes: { userId, plan, months: String(months) },
    });
  }

  fetch = (id: string) => this.rz<RzSubscription>(`/subscriptions/${id}`);
  cancel = (id: string, atCycleEnd: boolean) => this.rz<RzSubscription>(`/subscriptions/${id}/cancel`, 'POST', { cancel_at_cycle_end: atCycleEnd ? 1 : 0 });

  async changePlan(id: string, plan: PlanId, months: Months) {
    return this.rz<RzSubscription>(`/subscriptions/${id}`, 'PATCH', { plan_id: await this.planId(plan, months), schedule_change_at: 'cycle_end', customer_notify: 1 });
  }

  verifyCheckout(paymentId: string, subscriptionId: string, signature: string) {
    const expected = createHmac('sha256', this.config.getOrThrow<string>('RAZORPAY_KEY_SECRET')).update(`${paymentId}|${subscriptionId}`).digest('hex');
    return safeEqual(expected, signature);
  }

  verifyWebhook(rawBody: Buffer, signature: string) {
    const secret = this.config.get<string>('RAZORPAY_WEBHOOK_SECRET');
    if (!secret) return false;
    return safeEqual(createHmac('sha256', secret).update(rawBody).digest('hex'), signature);
  }
}
