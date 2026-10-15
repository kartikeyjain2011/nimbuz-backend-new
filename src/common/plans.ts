import { PlanId } from '@prisma/client';

/** Keep in sync with the website's lib/plans.ts. */
export const PLANS: Record<PlanId, { name: string; price: number; queuePriority: number; maxResolution: string; maxFps: number }> = {
  basic: { name: 'Basic', price: 799, queuePriority: 0, maxResolution: '1080p', maxFps: 60 },
  pro: { name: 'Pro', price: 1499, queuePriority: 10, maxResolution: '1440p', maxFps: 120 },
  premium: { name: 'Premium', price: 2499, queuePriority: 20, maxResolution: '2160p', maxFps: 120 },
  ultimate: { name: 'Ultimate', price: 2999, queuePriority: 30, maxResolution: '2160p', maxFps: 240 },
};

export const PLAN_ORDER: PlanId[] = ['basic', 'pro', 'premium', 'ultimate'];
export const tier = (p: PlanId) => PLAN_ORDER.indexOf(p);

export const DURATIONS = { 1: 0, 3: 0.05, 6: 0.1, 12: 0.2 } as const;
export type Months = keyof typeof DURATIONS;
export const isMonths = (m: unknown): m is Months => typeof m === 'number' && m in DURATIONS;

/** Rupees charged per billing cycle. */
export const cyclePrice = (plan: PlanId, months: Months) => Math.round(PLANS[plan].price * (1 - DURATIONS[months]) * months);

const LIVE = new Set(['authenticated', 'active', 'pending']);

export function activePlan(sub: { plan: PlanId; status: string; currentEnd: Date | null } | null | undefined): PlanId | null {
  if (!sub) return null;
  if (LIVE.has(sub.status)) return sub.plan;
  if (sub.currentEnd && sub.currentEnd.getTime() > Date.now() && sub.status !== 'halted') return sub.plan;
  return null;
}
