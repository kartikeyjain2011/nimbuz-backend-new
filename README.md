# Nimbus API

NestJS + PostgreSQL (Prisma 7) backend for the Nimbus cloud-gaming website.
Auth is Clerk (same instance as the website), billing is Razorpay Subscriptions, game data comes from RAWG + Steam, keys from Kinguin.

## Setup

```bash
npm install
cp .env.example .env          # fill in keys (see below)

# Postgres — pick one
docker compose up -d          # local, matches DATABASE_URL in .env.example
# …or paste a Neon / Supabase / RDS connection string into DATABASE_URL

npm run db:migrate -- --name init   # create tables
npm run db:seed                     # 23 catalog games, 4 regions, achievements
npm run start:dev                   # http://localhost:4000  ·  docs at /docs
```

## Environment

| Variable | Where it comes from |
| --- | --- |
| `DATABASE_URL` | Your Postgres |
| `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` | Clerk → API Keys (same as the website) |
| `CLERK_WEBHOOK_SECRET` | Clerk → Webhooks → endpoint `https://<api>/v1/webhooks/clerk` (user.created/updated/deleted) |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Razorpay → API Keys |
| `RAZORPAY_WEBHOOK_SECRET` | Razorpay → Webhooks → `https://<api>/v1/webhooks/razorpay`, events `subscription.*`, `payment.captured`, `payment.failed` |
| `RAWG_API_KEY` | rawg.io/apidocs |
| `KINGUIN_API_KEY` | Kinguin Integration → API key (optional; falls back to search links) |
| `ADMIN_USER_IDS` | Clerk user ids allowed to call admin routes |
| `CORS_ORIGINS` | Website origin(s), comma-separated |

## Auth

Every `/v1/*` route needs `Authorization: Bearer <Clerk session token>` unless marked public.
On the website:

```ts
const { getToken } = useAuth();
await fetch(`${API}/v1/library`, { headers: { Authorization: `Bearer ${await getToken()}` } });
```

## API

| Method & path | What it does |
| --- | --- |
| `GET /health` | Liveness + DB check |
| **Users** | |
| `GET /v1/me` | Profile, subscription, stats, devices (creates the row on first call) |
| `PATCH /v1/me` | name, username (synced to Clerk), phone, dateOfBirth |
| `POST /v1/webhooks/clerk` | Clerk user sync (Svix-signed) |
| **Games** (public) | |
| `GET /v1/games?search=&genre=&featured=&take=&skip=` | Catalog |
| `GET /v1/games/feed/:kind` | `popular` · `new` · `top` · `upcoming` from RAWG, imported into the catalog |
| `GET /v1/games/:slug` | Full detail; refreshed from RAWG/Steam daily; unknown RAWG slugs are imported |
| `GET /v1/games/:slug/buy` | Kinguin keys for your own Steam/Epic account |
| `POST /v1/games/sync` | Admin: re-sync every game |
| **Library** | |
| `GET /v1/library?filter=all\|favorites\|recent` | Saved games |
| `PUT /v1/library/:slug` | Add |
| `PATCH /v1/library/:slug` | `{ favorite?, hidden? }` |
| `DELETE /v1/library/:slug` | Remove |
| **Subscription** | |
| `GET /v1/subscription` | Current plan |
| `GET /v1/subscription/payments` | Payment history |
| `POST /v1/subscription/checkout` | `{ plan, months }` → `subscriptionId` for Razorpay Checkout (new or upgrade) |
| `POST /v1/subscription/verify` | Checkout success handler payload → activates plan, cancels the old one |
| `POST /v1/subscription/downgrade` | `{ plan }` — takes effect at cycle end (card mandates only) |
| `POST /v1/subscription/cancel` | Stop renewals; access until period end |
| `POST /v1/webhooks/razorpay` | Renewals, halts, cancellations, payments (HMAC-signed, idempotent) |
| **Cloud gaming** | |
| `GET /v1/regions` | Regions with live load (available / busy / full) |
| `POST /v1/queue` | `{ game, region }` — checks the plan covers the game (403 `NO_PLAN` / `UPGRADE_REQUIRED`); higher plans get priority |
| `GET /v1/queue/:id` | Position, ETA, `ready` when a rig frees up |
| `DELETE /v1/queue/:id` | Leave the queue |
| `POST /v1/sessions` | `{ queueId, launcher?, resolution?, fps?, device? }` → running session (caps resolution/FPS to the plan) |
| `POST /v1/sessions/:id/end` | Ends; updates playtime, library, XP, streak, achievements |
| `GET /v1/sessions` · `GET /v1/sessions/recent` | History · Recently played |
| **Stats** | |
| `GET /v1/stats` | Level/XP, hours, games played, streak week, achievements, badges, devices |

## Cloud rigs (KubeVirt + NVMesh)

Sessions run on real VMs from a **pre-warmed pool** managed through the Kubernetes API.

```
POST /v1/queue ─▶ ready ─▶ POST /v1/sessions ─▶ status "starting"
                                   │  lease a stopped pool VM (tier ≥ plan, exact tier first)
                                   │  start it, wait for the VMI IP (≤ 3 min)
                                   ▼
GET /v1/sessions/:id ─▶ status "running" + { stream: { url, token } }   ← browser connects to the agent
POST /v1/sessions/:id/end ─▶ VM stopped and returned to the pool
```

- **Pool** — `VM_POOL` sets how many stopped VMs to keep per region/tier. A reconciler (every 60 s) creates missing ones and frees leases older than 12 h. `GET /v1/infra/pool` (admin) shows free/running per region & tier plus node GPUs.
- **VMs** — labels `nimbus.io/pool=gaming`, `nimbus.io/region`, `nimbus.io/tier`; leased via the `nimbus.io/lease` annotation with optimistic concurrency, so two sessions can never grab the same VM.
- **GPU** — each tier uses the `nimbus-<tier>` cluster instancetype (`deploy/k8s/10-instancetypes.yaml`): RTX 3060 → 4070 Ti → 4090.
- **Storage (NVMesh)** — boot disk is a CDI clone of the golden image; the shared **game library** PVC is mounted read-only into every VM (`deploy/k8s/20-storage.yaml`).
- Without `K8S_API_URL` the API runs in dev mode: sessions go straight to `running` with no VM.

### One-time cluster setup

```bash
kubectl apply -f deploy/k8s/00-namespace-rbac.yaml
kubectl apply -f deploy/k8s/10-instancetypes.yaml      # fix GPU deviceNames first
kubectl apply -f deploy/k8s/20-storage.yaml            # fix storageClassName + golden image URL
kubectl -n nimbus get secret nimbus-api-token -o jsonpath='{.data.token}' | base64 -d   # → K8S_TOKEN
kubectl -n nimbus get secret nimbus-api-token -o jsonpath='{.data.ca\.crt}'            # → K8S_CA_B64
```

### Streaming agent contract (runs inside the golden image)

1. Listen on `wss://0.0.0.0:8443/stream` (or sit behind the gateway in `STREAM_URL_TEMPLATE`).
2. The browser connects with `?token=<stream.token>`. Token = `base64url(json).base64url(HMAC-SHA256(STREAM_TOKEN_SECRET, part1))`, claims `{ sid, uid, vm, res, fps, exp }`, valid 120 s.
3. Verify offline with the shared secret, or call `POST /v1/infra/stream/verify { token }`.
4. Cap encode to `res` / `fps`, then negotiate WebRTC over the socket.

Plans mirror the website (`src/common/plans.ts`): the subscription is also written to Clerk `publicMetadata.subscription`, so the website's play-gate keeps working without an extra request.
