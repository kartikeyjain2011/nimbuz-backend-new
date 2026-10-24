import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RawgService } from './rawg.service';

const DAY = 864e5;

export const slugify = (title: string) =>
  title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

export type Feed = 'popular' | 'new' | 'top' | 'upcoming';

@Injectable()
export class GamesService {
  private readonly log = new Logger(GamesService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly rawg: RawgService,
    private readonly config: ConfigService,
  ) {}

  list(q: { search?: string; genre?: string; featured?: boolean; installed?: boolean; take?: number; skip?: number }) {
    const where: Prisma.GameWhereInput = {
      ...(q.installed !== undefined && { installed: q.installed }),
      ...(q.search && { title: { contains: q.search, mode: 'insensitive' } }),
      ...(q.genre && { genres: { has: q.genre } }),
      ...(q.featured !== undefined && { featured: q.featured }),
    };
    return Promise.all([
      this.prisma.game.findMany({ where, orderBy: [{ installed: 'desc' }, { featured: 'desc' }, { rating: 'desc' }], take: q.take ?? 24, skip: q.skip ?? 0 }),
      this.prisma.game.count({ where }),
    ]).then(([items, total]) => ({ items, total }));
  }

  /** A game by slug; refreshed from RAWG at most once a day. Unknown slugs are imported from RAWG on first view. */
  async get(slug: string) {
    let game = await this.prisma.game.findUnique({ where: { slug } });
    if (!game) game = await this.importFromRawg(slug);
    if (!game) throw new NotFoundException('Game not found');
    if (!game.syncedAt || Date.now() - game.syncedAt.getTime() > DAY) {
      game = (await this.sync(game.slug, game.title).catch(() => null)) ?? game;
    }
    return game;
  }

  /** Pull everything RAWG + Steam know about a title into the DB. Curated fields (poster, logo, requiredPlan) are left alone. */
  async sync(slug: string, title: string) {
    const hit = await this.rawg.search(title);
    if (!hit) return this.prisma.game.update({ where: { slug }, data: { syncedAt: new Date() } });

    const [g, shots, steamAppId] = await Promise.all([this.rawg.details(hit.id), this.rawg.screenshots(hit.id), this.rawg.steamAppId(hit.id)]);
    const trailer = await this.rawg.trailer(hit.id, steamAppId);
    const existing = await this.prisma.game.findUnique({ where: { slug } });

    return this.prisma.game.update({
      where: { slug },
      data: {
        rawgId: hit.id,
        steamAppId,
        backdrop: existing?.backdrop ?? g?.background_image ?? undefined,
        trailer: existing?.trailer ?? trailer,
        about: g?.description_raw?.split(/\n\s*\n/).slice(0, 2).join('\n\n') || undefined,
        genres: g?.genres?.map((x) => x.name) ?? [],
        platforms: g?.platforms?.map((p) => p.platform.name) ?? [],
        developers: g?.developers?.map((d) => d.name) ?? [],
        publishers: g?.publishers?.map((p) => p.name) ?? [],
        rating: g?.rating,
        ratingsCount: g?.ratings_count,
        metacritic: g?.metacritic ?? undefined,
        releasedAt: g?.released ? new Date(g.released) : undefined,
        esrb: g?.esrb_rating?.name,
        screenshots: shots,
        syncedAt: new Date(),
      },
    });
  }

  private async importFromRawg(slug: string) {
    const g = await this.rawg.details(slug);
    if (!g?.name) return null;
    const ownSlug = slugify(g.name);
    const existing = await this.prisma.game.findUnique({ where: { slug: ownSlug } });
    if (existing) return existing;
    await this.prisma.game.create({ data: { slug: ownSlug, title: g.name, rawgId: g.id, backdrop: g.background_image ?? undefined, poster: g.background_image ?? undefined } });
    return this.sync(ownSlug, g.name);
  }

  /** Live RAWG lists, imported into the catalog so they get detail pages and can be played. */
  async feed(kind: Feed) {
    const iso = (d: number) => new Date(d).toISOString().slice(0, 10);
    const now = Date.now();
    const params: Record<Feed, Record<string, string>> = {
      popular: { ordering: '-added', dates: `${iso(now - 3 * 365 * DAY)},${iso(now)}` },
      new: { ordering: '-added', dates: `${iso(now - 90 * DAY)},${iso(now)}` },
      top: { ordering: '-metacritic', metacritic: '85,100' },
      upcoming: { ordering: '-added', dates: `${iso(now)},${iso(now + 365 * DAY)}` },
    };
    const items = (await this.rawg.list(params[kind])).filter((g) => g.background_image);
    await Promise.all(
      items.map((g) =>
        this.prisma.game.upsert({
          where: { slug: slugify(g.name) },
          create: {
            slug: slugify(g.name),
            title: g.name,
            rawgId: g.id,
            poster: g.background_image!,
            backdrop: g.background_image!,
            genres: g.genres?.map((x) => x.name) ?? [],
            rating: g.rating,
            ratingsCount: g.ratings_count,
            releasedAt: g.released ? new Date(g.released) : undefined,
          },
          update: {},
        }),
      ),
    );
    return this.prisma.game.findMany({ where: { slug: { in: items.map((g) => slugify(g.name)) } } });
  }

  /** Re-sync every catalog game (run daily via cron or POST /games/sync). */
  async syncAll() {
    const games = await this.prisma.game.findMany({ select: { slug: true, title: true } });
    let ok = 0;
    for (const g of games) {
      try {
        await this.sync(g.slug, g.title);
        ok++;
      } catch (e) {
        this.log.warn(`sync ${g.slug} failed: ${(e as Error).message}`);
      }
    }
    return { synced: ok, total: games.length };
  }

  /** Kinguin keys for the user's own Steam/Epic account. Falls back to search links without an API key. */
  async buyOptions(slug: string) {
    const game = await this.get(slug);
    const search = (p?: string) => `https://www.kinguin.net/listing?phrase=${encodeURIComponent(p ? `${game.title} ${p}` : game.title)}`;
    const fallback = { live: false, searchUrl: search(), offers: ['Steam', 'Epic Games'].map((platform) => ({ platform, region: 'Global', url: search(platform) })) };

    const key = this.config.get<string>('KINGUIN_API_KEY');
    if (!key) return fallback;
    try {
      const res = await fetch(`https://gateway.kinguin.net/esa/api/v1/products?${new URLSearchParams({ name: game.title, limit: '50', sortBy: 'price', sortType: 'asc' })}`, {
        headers: { 'X-Api-Key': key },
      });
      if (!res.ok) return fallback;
      const { results = [] } = (await res.json()) as { results?: { name: string; kinguinId: number; platform?: string; regionalLimitations?: string; price?: number; qty?: number }[] };
      const best = new Map<string, { platform: string; region: string; price: string; url: string; raw: number }>();
      for (const p of results) {
        if (!p.platform || !p.price || p.qty === 0) continue;
        const cur = best.get(p.platform);
        if (cur && cur.raw <= p.price) continue;
        best.set(p.platform, { platform: p.platform, region: p.regionalLimitations ?? 'Global', price: `€${p.price.toFixed(2)}`, url: `https://www.kinguin.net/category/${p.kinguinId}/${slugify(p.name)}`, raw: p.price });
      }
      const offers = [...best.values()].map(({ raw: _raw, ...o }) => o);
      return offers.length ? { live: true, searchUrl: search(), offers } : fallback;
    } catch {
      return fallback;
    }
  }
}
