import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';

const XP_PER_MINUTE = 2;
const XP_PER_LEVEL = 10_000;
const dayKey = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const DAY = 864e5;

@Injectable()
export class StatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
  ) {}

  /** Profile page: stats, level, streak week, achievements, recent badges, devices. */
  async overview(userId: string) {
    await this.users.ensure(userId);
    const [stats, achievements, devices, sessions] = await Promise.all([
      this.prisma.userStats.upsert({ where: { userId }, create: { userId }, update: {} }),
      this.prisma.achievement.findMany({ include: { users: { where: { userId } } }, orderBy: { xp: 'asc' } }),
      this.prisma.device.findMany({ where: { userId }, orderBy: { lastSeenAt: 'desc' } }),
      this.prisma.playSession.findMany({ where: { userId, startedAt: { gte: new Date(Date.now() - 7 * DAY) } }, select: { startedAt: true } }),
    ]);

    const played = new Set(sessions.map((s) => dayKey(s.startedAt)));
    const today = dayKey(new Date());
    const week = Array.from({ length: 7 }, (_, i) => {
      const d = today - (6 - i) * DAY;
      return { day: new Date(d).toLocaleDateString('en', { weekday: 'narrow', timeZone: 'UTC' }), played: played.has(d) };
    });

    const list = achievements.map((a) => {
      const ua = a.users[0];
      return { id: a.id, title: a.title, description: a.description, icon: a.icon, tier: a.tier, goal: a.goal, progress: Math.min(100, Math.round(((ua?.progress ?? 0) / a.goal) * 100)), unlockedAt: ua?.unlockedAt ?? null };
    });

    return {
      level: stats.level,
      xp: stats.xp % XP_PER_LEVEL,
      xpGoal: XP_PER_LEVEL,
      totalHours: Math.round(stats.totalMinutes / 60),
      gamesPlayed: stats.gamesPlayed,
      achievementsUnlocked: list.filter((a) => a.unlockedAt).length,
      streak: { days: stats.currentStreak, longest: stats.longestStreak, week },
      achievements: list,
      recentBadges: list.filter((a) => a.unlockedAt).sort((a, b) => +b.unlockedAt! - +a.unlockedAt!).slice(0, 4),
      devices: devices.map((d) => ({ ...d, active: Date.now() - d.lastSeenAt.getTime() < 10 * 60_000 })),
    };
  }

  /** Called when a session ends: XP, level, streak, games played, achievement progress. */
  async recordSession(userId: string, gameSlug: string, minutes: number) {
    const stats = await this.prisma.userStats.upsert({ where: { userId }, create: { userId }, update: {} });
    const today = dayKey(new Date());
    const last = stats.lastPlayedDay ? dayKey(stats.lastPlayedDay) : null;
    const streak = last === today ? stats.currentStreak : last === today - DAY ? stats.currentStreak + 1 : 1;
    const distinctGames = await this.prisma.playSession.findMany({ where: { userId, status: 'ended' }, distinct: ['gameSlug'], select: { gameSlug: true } });
    const xp = stats.xp + minutes * XP_PER_MINUTE;
    const totalMinutes = stats.totalMinutes + minutes;

    await this.prisma.userStats.update({
      where: { userId },
      data: { xp, level: 1 + Math.floor(xp / XP_PER_LEVEL), totalMinutes, gamesPlayed: distinctGames.length, currentStreak: streak, longestStreak: Math.max(stats.longestStreak, streak), lastPlayedDay: new Date(today) },
    });

    await Promise.all([
      this.progress(userId, 'first-steps', 1, 'set'),
      this.progress(userId, 'marathon-player', Math.floor(totalMinutes / 60), 'set'),
      this.progress(userId, 'explorer', distinctGames.length, 'set'),
      this.progress(userId, 'on-fire', streak, 'set'),
      this.prisma.achievement.findMany({ where: { gameSlug } }).then((as) => Promise.all(as.map((a) => this.progress(userId, a.id, 1, 'add')))),
    ]);
  }

  private async progress(userId: string, achievementId: string, value: number, mode: 'set' | 'add') {
    const a = await this.prisma.achievement.findUnique({ where: { id: achievementId } });
    if (!a) return;
    const current = await this.prisma.userAchievement.findUnique({ where: { userId_achievementId: { userId, achievementId } } });
    if (current?.unlockedAt) return;
    const progress = Math.min(a.goal, mode === 'add' ? (current?.progress ?? 0) + value : Math.max(current?.progress ?? 0, value));
    const unlocked = progress >= a.goal;
    await this.prisma.userAchievement.upsert({
      where: { userId_achievementId: { userId, achievementId } },
      create: { userId, achievementId, progress, unlockedAt: unlocked ? new Date() : null },
      update: { progress, unlockedAt: unlocked ? new Date() : null },
    });
    if (unlocked) await this.prisma.userStats.update({ where: { userId }, data: { xp: { increment: a.xp } } });
  }
}
