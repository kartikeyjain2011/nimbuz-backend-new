import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const API = 'https://api.rawg.io/api';

type Named = { name: string };
export type RawgListItem = {
  id: number;
  slug: string;
  name: string;
  background_image?: string | null;
  rating?: number;
  ratings_count?: number;
  released?: string | null;
  metacritic?: number | null;
  genres?: Named[];
  short_screenshots?: { image: string }[];
};
export type RawgGame = RawgListItem & {
  description_raw?: string;
  website?: string;
  platforms?: { platform: Named }[];
  publishers?: Named[];
  developers?: Named[];
  esrb_rating?: Named | null;
};

/** Catalog titles whose RAWG listing uses a different name. */
const SEARCH_AS: Record<string, string> = {
  "Assassin's Creed Black Flag Resynced": "Assassin's Creed Back Flag Resynced",
  'Resident Evil Requiem': 'Resident Evil 9: Requiem',
  'Call of Duty MW: 3': 'Call of Duty: Modern Warfare III',
};

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(the|of|a)\b/g, '')
    .replace(/\bpart (1|one)\b/g, 'part i')
    .replace(/[^a-z0-9]+/g, '');

@Injectable()
export class RawgService {
  private readonly log = new Logger(RawgService.name);
  constructor(private readonly config: ConfigService) {}

  private async get<T>(path: string, params: Record<string, string> = {}): Promise<T | null> {
    const key = this.config.get<string>('RAWG_API_KEY');
    if (!key) return null;
    try {
      const res = await fetch(`${API}${path}?${new URLSearchParams({ key, ...params })}`);
      return res.ok ? ((await res.json()) as T) : null;
    } catch (e) {
      this.log.warn(`RAWG ${path} failed: ${(e as Error).message}`);
      return null;
    }
  }

  async search(title: string): Promise<RawgListItem | null> {
    const query = SEARCH_AS[title] ?? title;
    const res = await this.get<{ results: RawgListItem[] }>('/games', { search: query, search_precise: 'true', page_size: '5' });
    const a = normalize(query);
    return res?.results.find((r) => normalize(r.name) === a || normalize(r.name).startsWith(a)) ?? null;
  }

  details = (idOrSlug: number | string) => this.get<RawgGame>(`/games/${idOrSlug}`);

  async screenshots(id: number) {
    const res = await this.get<{ results: { image: string }[] }>(`/games/${id}/screenshots`, { page_size: '6' });
    return res?.results.map((s) => s.image) ?? [];
  }

  list(params: Record<string, string>) {
    return this.get<{ results: RawgListItem[] }>('/games', { page_size: '20', exclude_additions: 'true', ...params }).then((r) => r?.results ?? []);
  }

  /** Steam app id from RAWG's store links (Steam is store_id 1). */
  async steamAppId(id: number): Promise<number | undefined> {
    const stores = await this.get<{ results: { store_id: number; url: string }[] }>(`/games/${id}/stores`);
    const match = stores?.results.find((s) => s.store_id === 1)?.url.match(/\/app\/(\d+)/);
    return match ? Number(match[1]) : undefined;
  }

  /** Official trailer: Steam store trailer (HLS/mp4), else RAWG's own clip. */
  async trailer(id: number, steamAppId?: number): Promise<string | undefined> {
    if (steamAppId) {
      try {
        const res = await fetch(`https://store.steampowered.com/api/appdetails?appids=${steamAppId}&filters=movies`);
        const json = (await res.json()) as Record<string, { data?: { movies?: { highlight?: boolean; hls_h264?: string; mp4?: { max?: string } }[] } }>;
        const movies = json[steamAppId]?.data?.movies ?? [];
        const m = movies.find((x) => x.highlight) ?? movies[0];
        const src = m?.mp4?.max ?? m?.hls_h264;
        if (src) return src.replace(/^http:/, 'https:');
      } catch {
        /* fall back to RAWG */
      }
    }
    const movies = await this.get<{ results: { data: { max?: string } }[] }>(`/games/${id}/movies`);
    return movies?.results[0]?.data.max;
  }
}
