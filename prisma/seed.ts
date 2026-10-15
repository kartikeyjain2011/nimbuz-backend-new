import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PlanId, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const slugify = (t: string) =>
  t
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

/** Mirrors the website catalog; RAWG fills in the rest on first sync. */
const catalog: { title: string; plan?: PlanId; featured?: boolean }[] = [
  { title: 'The Last of Us Part I', plan: 'pro', featured: true },
  { title: "Assassin's Creed Black Flag Resynced" },
  { title: 'Resident Evil Requiem' },
  { title: 'Assassins Creed Shadows', featured: true },
  { title: 'Death Stranding 2' },
  { title: 'Days Gone' },
  { title: "Assassin's Creed Odyssey" },
  { title: 'The Witcher 3: Wild Hunt' },
  { title: '007 First Light', plan: 'premium', featured: true },
  { title: 'God of War Ragnarök', plan: 'pro', featured: true },
  { title: 'Cyberpunk 2077', plan: 'pro' },
  { title: 'Control Resonant' },
  { title: 'EA Sports FC 27' },
  { title: 'Call of Duty MW: 3' },
  { title: 'Forza Horizon 6' },
  { title: 'Black Myth Wukong', plan: 'premium' },
  { title: 'Dying Light The Beast' },
  { title: 'Hogwarts Legacy' },
  { title: 'Horizon Forbidden West' },
  { title: 'The Crew Motorfest' },
  { title: 'Ghost of Tsushima' },
  { title: 'The Blood of Dawnwalker' },
  { title: 'Silent Hill Townfall' },
];

const regions = [
  { id: 'mumbai', name: 'Mumbai', country: 'IN', flag: '🇮🇳', capacity: 120 },
  { id: 'chennai', name: 'Chennai', country: 'IN', flag: '🇮🇳', capacity: 60 },
  { id: 'dubai', name: 'Dubai', country: 'AE', flag: '🇦🇪', capacity: 60 },
  { id: 'singapore', name: 'Singapore', country: 'SG', flag: '🇸🇬', capacity: 80 },
];

const achievements = [
  { id: 'first-steps', title: 'First Steps', description: 'Play your first game', icon: '🏆', tier: 'Gold', goal: 1, xp: 200 },
  { id: 'marathon-player', title: 'Marathon Player', description: 'Play 100+ hours total', icon: '🎮', tier: 'Silver', goal: 100, xp: 1500 },
  { id: 'explorer', title: 'Explorer', description: 'Play 10 different games', icon: '🔥', tier: 'Plat', goal: 10, xp: 1000 },
  { id: 'on-fire', title: 'On Fire', description: 'Keep a 7-day streak', icon: '⚡', tier: 'Bronze', goal: 7, xp: 500 },
];

async function main() {
  for (const g of catalog) {
    const slug = slugify(g.title);
    await prisma.game.upsert({
      where: { slug },
      create: { slug, title: g.title, requiredPlan: g.plan ?? 'basic', featured: g.featured ?? false },
      update: { requiredPlan: g.plan ?? 'basic', featured: g.featured ?? false },
    });
  }
  for (const r of regions) await prisma.region.upsert({ where: { id: r.id }, create: r, update: r });
  for (const a of achievements) await prisma.achievement.upsert({ where: { id: a.id }, create: a, update: a });
  console.log(`Seeded ${catalog.length} games, ${regions.length} regions, ${achievements.length} achievements`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
