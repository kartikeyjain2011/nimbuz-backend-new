// Sends a signed sample inventory report, like a rig would.  node scripts/inventory-test.mjs
import 'dotenv/config';
import { createHmac } from 'node:crypto';

const API = process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
const body = JSON.stringify({
  vm: 'test-rig',
  drive: 'G:',
  full: false,
  games: [
    { launcher: 'steam', id: '1091500', name: 'Cyberpunk 2077', installDir: 'G:\\SteamLibrary\\steamapps\\common\\Cyberpunk 2077', sizeBytes: 70e9 },
    { launcher: 'steam', id: '292030', name: 'The Witcher 3: Wild Hunt', installDir: 'G:\\SteamLibrary\\steamapps\\common\\The Witcher 3', sizeBytes: 50e9 },
    { launcher: 'steam', id: '228980', name: 'Steamworks Common Redistributables' },
  ],
});
const sig = createHmac('sha256', process.env.INVENTORY_SECRET || process.env.STREAM_TOKEN_SECRET).update(body).digest('hex');

const bad = await fetch(`${API}/v1/infra/inventory`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nimbus-Signature': 'sha256=deadbeef' }, body });
console.log('bad signature →', bad.status);

const ok = await fetch(`${API}/v1/infra/inventory`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nimbus-Signature': `sha256=${sig}` }, body });
console.log('signed →', ok.status, await ok.text());

const list = await fetch(`${API}/v1/games?installed=true`).then((r) => r.json());
console.log('installed games →', list.total, list.items.map((g) => `${g.title} [${g.launcher}:${g.launcherId}, ${Math.round(g.installBytes / 1e9)} GB]`));
