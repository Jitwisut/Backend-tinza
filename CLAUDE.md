# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Backend Tinza** is a WebRTC signaling + random matchmaking (Omegle-style) backend built on **Elysia + Bun** with PostgreSQL persistence. It supports anonymous and authenticated users, ICE config delivery for STUN/TURN, like/friend mutual matching, reporting/blocking, interest-tag based matching, and reconnect within a time window.

The project is in **Thai** for code comments, schema documentation, and user-facing messages.

## Commands

```bash
# Install dependencies
bun install

# Setup database (idempotent)
psql "$DATABASE_URL" -f src/lib/schema.sql
# OR use docker-compose for local Postgres
docker compose up -d

# Development (hot reload)
bun run dev

# Production
bun run start

# Type check
bun run typecheck

# End-to-end tests (ต้องมีเซิร์ฟเวอร์รันอยู่ + Postgres พร้อมใช้)
bun run e2e
```

`e2e.test.ts` opens real WebSocket clients against a running server. It covers matching,
chat relay + profanity masking, cooldowns, payload caps, the ban system, and a **regression
test for the queue-eviction bug** (a user skipped for being blocked used to be dropped from
the queue permanently). There is no build step (`"build"` is a no-op for Bun).

Note: `docker compose up -d` only runs `schema.sql` when the volume is created fresh. If a
volume already exists, apply the schema manually — it is idempotent.

## Architecture

The app is a single-process stateful WebSocket server. **It cannot be deployed to Vercel serverless** — all state lives in-memory. Deploy to Railway / Fly.io / Render / VPS instead.

### Layer Structure

- **`src/index.ts`** — Main Elysia app. Defines in-memory state (`users` map, `MatchQueue` doubly-linked list, reconnect requests, per-IP connection counts), WebSocket handler at `/match`, health + metrics endpoints, error handling, graceful shutdown (SIGINT/SIGTERM). Also contains the `MatchQueue` class with O(1) enqueue/dequeue/remove operations.
  - WebSocket limits (`maxPayloadLength`, `idleTimeout`, `backpressureLimit`) are set in the **`new Elysia({ websocket: {...} })` constructor** — putting them in `.ws("/match", {...})` silently does nothing.
- **`src/config/env.ts`** — Centralized env var loading with fail-fast validation. Throws on missing `JWT_SECRET` in production.
- **`src/router/`** — Elysia route modules grouped by domain:
  - `user.ts` — `/auth/signup`, `/auth/signin` (uses `@elysiajs/jwt` plugin)
  - `me.ts` — `/me`, `/me/likes`, `/me/friends`, `/me/calls` (Bearer auth required, uses `.resolve()` to extract `userId`)
  - `ice.ts` — `GET /ice` (returns STUN + TURN credentials, rate limited per IP)
  - `admin.ts` — `/admin/reports`, `/admin/bans` (guarded by `ADMIN_TOKEN` in the `x-admin-token` header; the whole group 404s when the env var is unset)
- **`src/controller/`** — Business logic for routes, separated from WebSocket handler. Returns sanitized public columns (no password hashes).
- **`src/lib/`** — Shared utilities:
  - `connectdb.ts` — pg `Pool` with SSL in production, `closeDb()` for shutdown
  - `jwt.ts` — Manual HS256 JWT verification (constant-time compare, no plugin dependency) — used by WebSocket handler
  - `ice.ts` — TURN REST API credential generation (coturn `use-auth-secret` format)
  - `social.ts` — Like/friend mutual detection, call history (`startCall`/`endCall`), report recording
  - `ratelimit.ts` — In-memory `Cooldown` and `TokenBucket` limiters plus `startSweeper()` to evict stale entries
  - `moderation.ts` — Persistent bans (cached in memory, refreshed every 60s), auto-ban on report threshold, admin queries
  - `password.ts` — `Bun.password` wrappers. **Never reintroduce `bcryptjs`** — it is pure JS and blocks the event loop for ~190ms per hash, freezing every active call
  - `clientip.ts` — Client IP resolution, honouring `X-Forwarded-For` only when `TRUST_PROXY=true`
  - `logger.ts` — Leveled logger (`LOG_LEVEL`); per-connection logs are `debug`
  - `metrics.ts` — Prometheus counters/gauges served at `GET /metrics`
  - `profanity.ts` — Best-effort Thai+English profanity masking for chat relay
  - `schema.sql` — Idempotent DB schema (`users`, `reports`, `likes`, `calls`, `friends` view)

### Key Behaviors

- **Matching** (`tryMatch` in `src/index.ts`): One pass over the waiting queue. A shared interest tag wins immediately; otherwise the first eligible user in FIFO order is used. **Never use `dequeue()` here** — pulling a candidate out and then rejecting them (e.g. mutual block) drops a still-waiting user from the queue forever. Only entries that are genuinely dead (offline or already paired) get removed. `MatchQueue.keys()` captures `node.next` before yielding so callers can `remove()` mid-iteration.
- **No limbo states**: every path that leaves a user without a partner must end in `enqueueWaiting()`. A user who is neither paired nor queued can never be matched again.
- **Reconnect window**: Both peers must send `reconnect` with `peerUserId` + token within `RECONNECT_WINDOW_MS` (default 30s) to be re-paired via `reconnectRequests` map.
- **Like → Friend**: A `like` persists to DB only if both peers are logged in. Mutual like (both directions exist in `likes` table) triggers a `friend` event to both sides.
- **Call history**: Created on match if both peers are logged in, ended on `next`/disconnect/block. Each side gets its own `calls` row with the other as `peer_user_id`.
- **Block**: Symmetric and session-scoped (`blocked` Set, capped at 200 entries). For anything that must survive a reconnect, use the `bans` table via `moderation.ts` instead.
- **Bans**: Persistent, by `user_id` and/or `ip`, with optional expiry. Checked at WS open (IP), after `applyAuth` (user id), and at signin. The active list is cached in memory so the connection hot path never queries the DB.
- **Rate limits**: always **two layers** — per session (`ws.id`) for UX pacing, per IP for the abuse ceiling. Session-only is defeated by reconnecting; IP-only makes users behind one NAT (office, dorm, CGNAT) block each other. `next`/`block`/`report`/`find_partner` all go through `allowAction()`; `block` and `report` used to bypass the cooldown entirely.
- **Chat relay**: Trims, slices to `MAX_CHAT_LEN=500`, runs through `maskProfanity` before forwarding to partner. Server stamps `from` and `ts` to prevent spoofing.

### State Model

```ts
type User = {
  id: string;          // ws.id
  ws: any;             // WebSocket reference
  nickname: string;
  partnerId: string | null;
  userId: number | null;  // null = anonymous
  tags: string[];      // normalized interest tags
  blocked: Set<string>;   // session-level block
  activeCallId: number | null;
};
```

Anonymous users can use the WebSocket without `token`. Auth is only required for `/me/*` REST endpoints and to enable like/call history persistence.

## Environment Variables

Required in production: `JWT_SECRET` (e.g. `openssl rand -hex 32`), `DATABASE_URL` (or `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME`).

Strongly recommended in production: `TRUST_PROXY=true` when behind a reverse proxy (otherwise every rate limit sees one shared proxy IP), `ADMIN_TOKEN` (moderation endpoints), `LOG_LEVEL=info`.

For TURN credentials: `TURN_URLS` + `TURN_SECRET` (must match `static-auth-secret` on coturn). Without `TURN_SECRET`, `/ice` returns STUN only.

See `.env.example` for the full list including `CORS_ORIGINS`, `STUN_URLS`, `TURN_TTL` (default 600s), `RECONNECT_WINDOW_MS`, `BCRYPT_ROUNDS`, `WS_*` limits, `DB_POOL_MAX`, retention and auto-ban settings.

## Breaking change to watch

`src/lib/connectdb.ts` registers `types.setTypeParser(INT8, Number)`. Without it, `node-pg`
returns every `BIGINT` as a **string**, so `id` fields serialised to `"3"` rather than `3` —
which meant a client could not feed an id from `/auth/signin` back into any endpoint whose
schema declares a number (this surfaced as a real e2e failure). Safe here since no id
approaches 2^53, but it changed the response shape of `/auth/signin`, `/me`, `/me/likes`,
`/me/friends`, and `/me/calls`. Any frontend comparing ids with `===` against a string,
or using them as object keys, needs updating.

## Scaling constraints

**Single instance only.** All state lives in this process's memory. Running multiple replicas
behind a load balancer does not increase capacity — it breaks matching, because each instance
has its own isolated pool of users. Scaling out requires moving `users` / `waitingQueue` /
`reconnectRequests` into Redis with pub/sub for cross-instance relay; that is a separate project.

Measured characteristics (on an M-series dev machine), useful when judging what to optimise:

- `bcryptjs` blocked the event loop 193ms per hash (2 loop ticks vs. ~193 expected); `Bun.password`
  does not block and is ~8x faster under 10 concurrent hashes. This is why `password.ts` exists.
- The tag scan in `tryMatch` costs 0.149ms at 10,000 waiting users (~6,700 matches/sec) and
  0.533ms at 50,000. It is **not** the first bottleneck — an inverted tag index was deliberately
  not built, since it adds a desync-prone data structure for no gain at reachable scale.
- DB writes are the real ceiling: 2 INSERTs per match, 2 UPDATEs per `next`, against `DB_POOL_MAX`.
