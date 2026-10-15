import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PLANS, tier } from '../common/plans';
import { GamesService } from '../games/games.service';
import { PrismaService } from '../prisma/prisma.service';
import { StatsService } from '../stats/stats.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { UsersService } from '../users/users.service';

const AVG_SESSION_MIN = 45;
const READY_TTL_MS = 2 * 60_000;

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly games: GamesService,
    private readonly subs: SubscriptionsService,
    private readonly stats: StatsService,
    private readonly users: UsersService,
  ) {}

  async regions() {
    const regions = await this.prisma.region.findMany({ where: { online: true }, orderBy: { name: 'asc' } });
    const running = await this.prisma.playSession.groupBy({ by: ['regionId'], where: { status: { in: ['starting', 'running'] } }, _count: true });
    const waiting = await this.prisma.queueEntry.groupBy({ by: ['regionId'], where: { status: 'waiting' }, _count: true });
    const count = (rows: { regionId: string; _count: number }[], id: string) => rows.find((r) => r.regionId === id)?._count ?? 0;
    return regions.map((r) => {
      const load = count(running, r.id) / r.capacity;
      return { ...r, running: count(running, r.id), waiting: count(waiting, r.id), load: Math.min(1, load), status: load >= 1 ? 'full' : load > 0.75 ? 'busy' : 'available' };
    });
  }

  /** Join the queue for a game. Requires a plan that covers the game; higher plans get priority. */
  async join(userId: string, slug: string, regionId: string) {
    await this.users.ensure(userId);
    const [game, plan, region] = await Promise.all([this.games.get(slug), this.subs.plan(userId), this.prisma.region.findUnique({ where: { id: regionId } })]);
    if (!region?.online) throw new BadRequestException('Unknown or offline region');
    if (!plan) throw new ForbiddenException({ code: 'NO_PLAN', message: 'Subscribe to start playing', requiredPlan: game.requiredPlan });
    if (tier(plan) < tier(game.requiredPlan)) throw new ForbiddenException({ code: 'UPGRADE_REQUIRED', message: `${game.title} needs the ${PLANS[game.requiredPlan].name} plan`, requiredPlan: game.requiredPlan });

    await this.prisma.queueEntry.updateMany({ where: { userId, status: { in: ['waiting', 'ready'] } }, data: { status: 'cancelled' } });
    const entry = await this.prisma.queueEntry.create({ data: { userId, gameSlug: game.slug, regionId, plan, priority: PLANS[plan].queuePriority } });
    await this.advance(regionId);
    return this.status(userId, entry.id);
  }

  /** Promote waiting entries to "ready" while the region has free rigs; expire stale "ready" slots. */
  private async advance(regionId: string) {
    await this.prisma.queueEntry.updateMany({ where: { regionId, status: 'ready', readyAt: { lt: new Date(Date.now() - READY_TTL_MS) } }, data: { status: 'expired' } });
    const region = await this.prisma.region.findUniqueOrThrow({ where: { id: regionId } });
    const busy = await this.prisma.playSession.count({ where: { regionId, status: { in: ['starting', 'running'] } } });
    const ready = await this.prisma.queueEntry.count({ where: { regionId, status: 'ready' } });
    const free = region.capacity - busy - ready;
    if (free <= 0) return;
    const next = await this.prisma.queueEntry.findMany({ where: { regionId, status: 'waiting' }, orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }], take: free });
    if (next.length) await this.prisma.queueEntry.updateMany({ where: { id: { in: next.map((e) => e.id) } }, data: { status: 'ready', readyAt: new Date() } });
  }

  async status(userId: string, id: string) {
    const entry = await this.prisma.queueEntry.findUnique({ where: { id }, include: { game: { select: { slug: true, title: true, backdrop: true } }, region: true } });
    if (!entry || entry.userId !== userId) throw new NotFoundException('Queue entry not found');
    if (entry.status === 'waiting') await this.advance(entry.regionId);
    const fresh = await this.prisma.queueEntry.findUniqueOrThrow({ where: { id }, include: { game: { select: { slug: true, title: true, backdrop: true } }, region: true } });

    const ahead =
      fresh.status === 'waiting'
        ? await this.prisma.queueEntry.count({
            where: { regionId: fresh.regionId, status: 'waiting', OR: [{ priority: { gt: fresh.priority } }, { priority: fresh.priority, createdAt: { lt: fresh.createdAt } }] },
          })
        : 0;
    const etaMinutes = fresh.status === 'waiting' ? Math.max(1, Math.round(((ahead + 1) * AVG_SESSION_MIN) / fresh.region.capacity)) : 0;
    return { ...fresh, position: fresh.status === 'waiting' ? ahead + 1 : 0, etaMinutes };
  }

  async leave(userId: string, id: string) {
    const r = await this.prisma.queueEntry.updateMany({ where: { id, userId, status: { in: ['waiting', 'ready'] } }, data: { status: 'cancelled' } });
    if (!r.count) throw new NotFoundException('Queue entry not found');
  }

  /** Turn a "ready" queue slot into a running session. */
  async start(userId: string, queueId: string, opts: { launcher?: string; resolution?: string; fps?: number; device?: { name: string; kind: string; userAgent?: string } }) {
    const entry = await this.prisma.queueEntry.findUnique({ where: { id: queueId } });
    if (!entry || entry.userId !== userId) throw new NotFoundException('Queue entry not found');
    if (entry.status !== 'ready') throw new BadRequestException(`Queue entry is ${entry.status}, not ready`);

    const caps = PLANS[entry.plan];
    const device = opts.device
      ? await this.prisma.device.upsert({
          where: { userId_name: { userId, name: opts.device.name } },
          create: { userId, ...opts.device },
          update: { lastSeenAt: new Date(), userAgent: opts.device.userAgent },
        })
      : null;

    const [, session] = await this.prisma.$transaction([
      this.prisma.queueEntry.update({ where: { id: queueId }, data: { status: 'started' } }),
      this.prisma.playSession.create({
        data: {
          userId,
          gameSlug: entry.gameSlug,
          regionId: entry.regionId,
          plan: entry.plan,
          launcher: opts.launcher,
          resolution: opts.resolution ?? caps.maxResolution,
          fps: Math.min(opts.fps ?? caps.maxFps, caps.maxFps),
          status: 'running',
          deviceId: device?.id,
        },
      }),
    ]);
    return session;
  }

  async end(userId: string, id: string) {
    const session = await this.prisma.playSession.findUnique({ where: { id } });
    if (!session || session.userId !== userId) throw new NotFoundException('Session not found');
    if (session.status === 'ended') return session;

    const endedAt = new Date();
    const minutes = Math.max(1, Math.round((endedAt.getTime() - session.startedAt.getTime()) / 60_000));
    const ended = await this.prisma.playSession.update({ where: { id }, data: { status: 'ended', endedAt } });

    await this.prisma.libraryItem.upsert({
      where: { userId_gameSlug: { userId, gameSlug: session.gameSlug } },
      create: { userId, gameSlug: session.gameSlug, lastPlayed: endedAt, playtimeMinutes: minutes },
      update: { lastPlayed: endedAt, playtimeMinutes: { increment: minutes } },
    });
    await this.stats.recordSession(userId, session.gameSlug, minutes);
    await this.advance(session.regionId);
    return { ...ended, minutes };
  }

  history(userId: string) {
    return this.prisma.playSession.findMany({ where: { userId }, include: { game: { select: { slug: true, title: true, poster: true } }, region: true }, orderBy: { startedAt: 'desc' }, take: 50 });
  }

  /** "Recently played" for the right panel. */
  recent(userId: string) {
    return this.prisma.libraryItem.findMany({ where: { userId, lastPlayed: { not: null } }, include: { game: true }, orderBy: { lastPlayed: 'desc' }, take: 10 });
  }
}
