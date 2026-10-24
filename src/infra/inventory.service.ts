import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { GamesService, slugify } from '../games/games.service';
import { PrismaService } from '../prisma/prisma.service';

export type InventoryGame = {
  launcher: 'steam' | 'epic' | 'gog';
  id: string; // steam appid · epic AppName · gog productId
  name: string;
  installDir?: string;
  sizeBytes?: number;
};

export type InventoryReportBody = {
  vm: string;
  drive?: string;
  /** true = this is everything on the drive, so games missing from it get marked not-installed */
  full?: boolean;
  games: InventoryGame[];
};

/** Junk that shows up in Steam libraries but isn't a game. */
const IGNORE = /^(steamworks common redistributables|steam linux runtime|proton|directx|vc\+\+|.*dedicated server|.*sdk$)/i;

@Injectable()
export class InventoryService {
  private readonly log = new Logger(InventoryService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly games: GamesService,
    private readonly config: ConfigService,
  ) {}

  /** HMAC-SHA256(hex) of the raw body with INVENTORY_SECRET (falls back to STREAM_TOKEN_SECRET). */
  verify(rawBody: Buffer | undefined, signature: string | undefined) {
    const secret = this.config.get<string>('INVENTORY_SECRET') || this.config.get<string>('STREAM_TOKEN_SECRET');
    if (!secret || !rawBody || !signature) throw new UnauthorizedException('Missing signature');
    const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'));
    const given = Buffer.from(signature.replace(/^sha256=/, '').toLowerCase());
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new UnauthorizedException('Bad signature');
  }

  async ingest(body: InventoryReportBody) {
    const games = (body.games ?? []).filter((g) => g?.name && !IGNORE.test(g.name));
    const now = new Date();
    let matched = 0;
    let created = 0;
    const seen: string[] = [];

    for (const g of games) {
      const steamAppId = g.launcher === 'steam' && /^\d+$/.test(g.id) ? Number(g.id) : undefined;
      const existing =
        (steamAppId && (await this.prisma.game.findFirst({ where: { steamAppId } }))) ||
        (await this.prisma.game.findFirst({ where: { launcher: g.launcher, launcherId: g.id } })) ||
        (await this.prisma.game.findUnique({ where: { slug: slugify(g.name) } }));

      const data: Prisma.GameUpdateInput = {
        installed: true,
        launcher: g.launcher,
        launcherId: g.id,
        installDir: g.installDir,
        installBytes: g.sizeBytes ? BigInt(Math.round(g.sizeBytes)) : undefined,
        inventorySeenAt: now,
        ...(steamAppId && { steamAppId }),
      };

      if (existing) {
        await this.prisma.game.update({ where: { slug: existing.slug }, data });
        seen.push(existing.slug);
        matched++;
      } else {
        const slug = slugify(g.name);
        await this.prisma.game.create({ data: { ...(data as Omit<Prisma.GameCreateInput, 'slug' | 'title'>), slug, title: g.name } });
        seen.push(slug);
        created++;
        // fill in art, description, trailer from RAWG/Steam in the background
        void this.games.sync(slug, g.name).catch((e) => this.log.warn(`sync ${slug}: ${(e as Error).message}`));
      }
    }

    let removed = 0;
    if (body.full) {
      const r = await this.prisma.game.updateMany({ where: { installed: true, slug: { notIn: seen } }, data: { installed: false } });
      removed = r.count;
    }

    await this.prisma.inventoryReport.create({
      data: { vm: body.vm, drive: body.drive, gameCount: games.length, matched, created, payload: body as unknown as Prisma.InputJsonValue },
    });
    this.log.log(`Inventory from ${body.vm}: ${games.length} games (${matched} matched, ${created} new, ${removed} no longer installed)`);
    return { received: games.length, matched, created, removed };
  }

  latest() {
    return this.prisma.inventoryReport.findMany({ orderBy: { receivedAt: 'desc' }, take: 10, select: { id: true, vm: true, drive: true, gameCount: true, matched: true, created: true, receivedAt: true } });
  }
}
