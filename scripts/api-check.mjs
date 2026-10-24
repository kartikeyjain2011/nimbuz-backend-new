// End-to-end API check against a running backend.
//   node scripts/api-check.mjs [user-email]
// Creates a Clerk session for a dev user (development instance only), gets a session token,
// then calls every endpoint with and without it. Prints the token for Swagger "Authorize".
import 'dotenv/config';
import { createClerkClient } from '@clerk/backend';

const API = process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

const { data: users } = await clerk.users.getUserList({ limit: 50, ...(process.argv[2] && { emailAddress: [process.argv[2]] }) });
if (!users.length) {
  console.log('No Clerk users found — sign up on the website first');
  process.exit(1);
}
const user = users[0];
const session = await clerk.sessions.createSession({ userId: user.id });
const { jwt: token } = await clerk.sessions.getToken(session.id);
console.log(`User: ${user.primaryEmailAddress?.emailAddress ?? user.id}\nToken (valid ~60s, paste into /docs → Authorize):\n${token}\n`);

const call = async (method, path, body, auth = true) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth && { Authorization: `Bearer ${token}` }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
};

const row = (label, r, expect) => {
  const ok = expect.includes(r.status);
  const msg = typeof r.json === 'object' ? (r.json?.message ?? r.json?.error ?? '') : String(r.json).slice(0, 80);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(r.status).padEnd(4)} ${label}${ok ? '' : `  → ${JSON.stringify(msg).slice(0, 160)}`}`);
  return r;
};

console.log('— public —');
row('GET  /health', await call('GET', '/health', null, false), [200]);
row('GET  /v1/games', await call('GET', '/v1/games?take=5', null, false), [200]);
row('GET  /v1/games/:slug', await call('GET', '/v1/games/cyberpunk-2077', null, false), [200]);
row('GET  /v1/games/:slug/buy', await call('GET', '/v1/games/cyberpunk-2077/buy', null, false), [200]);
row('GET  /v1/games/feed/popular', await call('GET', '/v1/games/feed/popular', null, false), [200]);
row('GET  /v1/regions', await call('GET', '/v1/regions', null, false), [200]);

console.log('— auth required: no token → 401 —');
row('GET  /v1/me (no token)', await call('GET', '/v1/me', null, false), [401]);

console.log('— authenticated —');
row('GET  /v1/me', await call('GET', '/v1/me'), [200]);
row('PATCH /v1/me', await call('PATCH', '/v1/me', { phone: '+91 98765 43210' }), [200]);
row('PUT  /v1/library/:slug', await call('PUT', '/v1/library/cyberpunk-2077'), [200]);
row('PATCH /v1/library/:slug', await call('PATCH', '/v1/library/cyberpunk-2077', { favorite: true }), [200]);
row('GET  /v1/library', await call('GET', '/v1/library'), [200]);
row('GET  /v1/subscription', await call('GET', '/v1/subscription'), [200]);
row('GET  /v1/subscription/payments', await call('GET', '/v1/subscription/payments'), [200]);
row('POST /v1/subscription/checkout', await call('POST', '/v1/subscription/checkout', { plan: 'pro', months: 1 }), [201, 400]);
row('GET  /v1/stats', await call('GET', '/v1/stats'), [200]);
row('GET  /v1/sessions', await call('GET', '/v1/sessions'), [200]);
row('GET  /v1/sessions/recent', await call('GET', '/v1/sessions/recent'), [200]);
const q = row('POST /v1/queue (needs a plan)', await call('POST', '/v1/queue', { game: 'days-gone', region: 'mumbai' }), [201, 403]);
if (q.status === 201) {
  row('GET  /v1/queue/:id', await call('GET', `/v1/queue/${q.json.id}`), [200]);
  row('DELETE /v1/queue/:id', await call('DELETE', `/v1/queue/${q.json.id}`), [204]);
}
row('DELETE /v1/library/:slug', await call('DELETE', '/v1/library/cyberpunk-2077'), [204]);
row('GET  /v1/infra/pool (admin)', await call('GET', '/v1/infra/pool'), [200, 403]);

await clerk.sessions.revokeSession(session.id).catch(() => {});
