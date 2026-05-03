# Twilight Tradebot

Autonomous funding-rate arbitrage runtime across **Twilight** (zkOS inverse perp) + **Binance** USDT-M futures + **Bybit** BTC inverse perp.

Plugin-style skills tick continuously; each profitable signal goes through five
independent safety layers before any capital moves; an operator dashboard +
Claude copilot give read-only oversight without putting a human in the hot
path. Inspired by Senpi's architecture, adapted for our three-leg topology and
Twilight's on-chain settlement.

See [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) for deeper specs.

---

## Architecture

```
                      ┌──────────────────────────────────────┐
                      │         OPERATOR (browser)           │
                      │   dashboard (private endpoint, IP-   │
                      │   gated, Bearer-token auth, no DNS)  │
                      └────────────┬─────────────────────────┘
                                   │ http
                  ┌────────────────▼──────────────────┐
                  │  nginx (private port, token-gated)│
                  │   ↓ proxy /bot/* to bot           │
                  └────────────────┬──────────────────┘
                                   │
┌──────────────────────────────────▼─────────────────────────────────┐
│                    TS HOST (orchestrator, this repo)               │
│                                                                    │
│   Scheduler ──► Skill (Python subprocess) ──► Intent JSON          │
│        │              │                            │               │
│        │              ↑ stdin: tick                ▼               │
│        │              ↓ stdout: intent     ┌───────────────┐       │
│        │                                   │ SAFETY STACK  │       │
│        │   per-skill cooldown / slot       │ 1 guards      │       │
│        │   skip-when-position-open         │ 2 impact      │       │
│        │                                   │ 3 consult     │       │
│        │                                   │ 4 dsl exits   │       │
│        │                                   │ 5 hard stops  │       │
│        │                                   └──────┬────────┘       │
│        │                                          ▼                │
│        │                              ┌─────────────────────┐      │
│        │                              │  Exec router        │      │
│        │                              │  fan-out three legs │      │
│        │                              └──┬─────┬─────┬──────┘      │
│        │                                 ▼     ▼     ▼             │
│        ▼                            twilight binance bybit         │
│   SQLite (intents, fills, positions, ticks, decisions, consults,   │
│            intent_hwm, intents_fts)                                │
│                                                                    │
│   HTTP API (127.0.0.1:8787): /healthz /positions /ticks /trades    │
│                              /chat (Claude copilot, read-only)     │
│                              /kill-switch (PUT to halt)            │
└────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
                    ┌─────────────────────────────┐
                    │  Strategy API (separate     │
                    │  service, mainnet feed)     │
                    │  /market /strategies /impact│
                    └─────────────────────────────┘
```

### Two-layer model

- **Autonomous loop**: Scheduler runs each enabled skill on its own interval (default 10s). Skills are stdin/stdout subprocesses; the Python skill SDK handles ticks, deduplication, and serialization. One enabled skill at a time (v1 hard rule) — multi-skill coordination, slot accounting, and cross-skill ratcheting are out of scope until v2.
- **HTTP API**: same process, separate concern. Operator queries (`/healthz`, `/positions`, `/ticks`, `/trades`), copilot chat (`/chat`), and break-glass actions (`/kill-switch`, `/trades/live`). Bound to `127.0.0.1` by default; expose only behind a token-gated reverse proxy.

### Safety stack (five independent layers)

Each layer is a hard "no" — failing any one rejects the intent. The bot pauses until next tick rather than "approve with caveats."

1. **Guards** (`src/safety/guards.ts`): static caps. Notional, leverage, open-position count, daily-loss stop, per-venue minimum balance, per-skill cooldown, skip-when-position-open. All env-driven.
2. **Impact check** (`src/safety/impactCheck.ts`): calls strategy-api `/api/impact` with each Twilight leg's notional + direction. Rejects if the trade would tip the on-chain pool such that funding flips against us (`youPay: true`).
3. **Claude consult gate** (`src/safety/claudeConsult.ts`): sends intent + market context + impact analysis to Claude via the Agent SDK. Returns JSON `{approve, reason, confidence}`. Subscription auth (no API key). Min-confidence floor configurable; "low" is rejected by default. Any error → reject.
4. **DSL exits** (`src/dsl/engine.ts`): a tiny rule grammar evaluated each tick against open positions. Funding-flip exit, hard stop-loss, time stop, pool-skew stop, and a Senpi-inspired Phase-2 tiered ratchet ([+5/lock 25%, +10/45, +15/65, +20/80, +30/90, +50/94]) — the high-water mark drives a locked floor that exits when PnL drops below it.
5. **Hard exchange stops** (`src/exec/cex.ts` + `twilight.ts`): every fill attaches a venue-side stop-loss (Binance `STOP_MARKET` + `closePosition`, Bybit `triggerPrice` + `reduceOnly`, Twilight relayer-cli `--stop-loss-price`). Independent of the runtime — even if the orchestrator dies, the stop fires.

If you change one layer, the others still hold. That's the whole point.

### Plugin / skill model

A skill lives at `skills/<name>/`:

- `scanner.py` — reads ticks from stdin, emits intent JSON or `noop` to stdout.
- `runtime.yaml` — interval, budget, slots, margin per slot, cooldown, `skip_when_position_open`.
- `SKILL.md` — operator notes; not parsed.

The Python skill SDK (`python/skill_sdk/`) is stdlib-only: `io.py` (read_tick / emit_intent), `intents.py` (leg helpers with default `stop_loss_pct=0.10`), `dsl.py` (`standard_funding_arb_exits()` returns the canonical exit-rule list with the ratchet rule pre-wired).

### Why Claude in the loop?

The consult gate catches the "looks fine but it's the same trade we did 30 min ago" failure mode that pure rule-based guards miss. Claude sees recent intents (FTS5 search), recent decisions, and the impact snapshot — it acts as a duplicate detector + structural sanity check, not a directional oracle. The `/chat` endpoint is the operator-facing complement: read-only state inspection in plain English.

---

## Quick start (local, paper mode)

```bash
cp .env.example .env
# edit .env if you want live wallet/CEX integration; paper mode runs without.

npm install
npm run build
node dist/index.js
```

Runtime boots `PAPER=1` by default. Refuses to boot if more than one skill is enabled.

```bash
curl http://127.0.0.1:8787/healthz
curl 'http://127.0.0.1:8787/strategies?profitable=true&limit=5'
curl http://127.0.0.1:8787/positions
curl http://127.0.0.1:8787/ticks?limit=15
```

---

## HTTP API

Bound to `127.0.0.1:${API_PORT:-8787}`. No auth in localhost mode; expose via reverse-proxy with bearer token.

| Method | Path                              | Notes                                                              |
|--------|-----------------------------------|--------------------------------------------------------------------|
| GET    | `/healthz`                        | mode, uptime, last tick id per skill                               |
| GET    | `/strategies`                     | proxy strategy-api ranked strategies (filter: category/risk/apy)   |
| GET    | `/market`                         | proxy strategy-api market snapshot (funding rates, prices, skew)   |
| GET    | `/positions[?venue=]`             | open positions across all venues                                   |
| GET    | `/trades[?q=&since=&limit=]`      | intent history, with FTS5 thesis search                            |
| GET    | `/trades/<intent_id>`             | one intent + its fills                                             |
| POST   | `/trades/paper`                   | submit an operator-driven intent in paper mode                     |
| POST   | `/trades/live`                    | same, requires `confirm_live: true` + `LIVE_TRADING_CONFIRMED=YES` |
| GET    | `/ticks[?skill=&status=&limit=]`  | scheduler tick log; status ∈ {noop, intent, timeout, crashed, mismatch, skip_position_open} |
| POST   | `/positions/<id>/close`           | close a single position                                            |
| POST   | `/skills/<name>/{enable,disable}` | flip skill state (enforces single-skill rule)                      |
| GET    | `/kill-switch`                    | `{on: bool}`                                                       |
| PUT    | `/kill-switch`                    | `{on: true}` halts new intents within one tick                     |
| GET    | `/caps`                           | current guards (env-driven)                                        |
| **POST** | **`/chat`**                     | **Claude copilot — see below**                                     |

### `/chat` — Claude copilot

Read-only operator chat backed by the Claude Agent SDK with subscription OAuth.

```
POST /chat
{ "message": "why is funding-arb noop'ing?", "history": [{role,content}, ...] }
→ { "reply": "..." }   or   { "reply": "", "error": "..." }
```

Each turn snapshots current bot state (positions, last 10 ticks, last 10 intents, last 5 consults, fresh strategy-api market) and feeds it as context. The assistant cannot take actions — for kill switch / position close / skill toggle it points the operator at the dashboard or relevant API.

Auth on the host: run `claude auth login` once. Subscription credentials live at `~/.claude/`. If `claude` was installed via npm rather than the native installer, set `CLAUDE_CLI_PATH=/usr/bin/claude` (or wherever `which claude` points) so the SDK can find the binary.

---

## Deploying

The runtime is a standalone Node process. Any Linux VM works — Railway, DigitalOcean, Fly, etc.

```bash
# on host:
git clone <this-repo> /opt/tradebot && cd /opt/tradebot
npm install --production && npm run build
cp .env.example .env  # fill in secrets

# install Claude Code CLI for the consult gate + chat endpoint
npm install -g @anthropic-ai/claude-code
claude auth login   # OAuth via Anthropic subscription

# start with pm2
pm2 start dist/index.js --name twilight-bot
pm2 save
```

Front the bot with nginx (or any reverse proxy) using a token-gated location block. Pattern:

```nginx
server {
    listen <port>;
    location / {
        try_files $uri $uri/ =404;     # serves a static dashboard
    }
    location /bot/ {
        # Bearer token check — keeps the bot endpoints private
        if ($http_authorization != "Bearer <your-token>") { return 401; }
        proxy_pass http://127.0.0.1:8787/;
        # nginx swaps the operator's token for the bot's internal API_TOKEN
        proxy_set_header Authorization "Bearer <bot-internal-token>";
    }
}
```

A reference dashboard is in `deploy/` — vanilla HTML, no build step, polls `/bot/*` and renders status, positions, ticks, intents, kill-switch, and the chat panel.

### Going live

1. Run paper for ≥ 24h; watch `GET /trades` and `GET /ticks?status=timeout`.
2. Provision the Twilight wallet (`relayer-cli wallet create`, register BTC deposit, fund a ZkOS account — see plan §10.4).
3. Set `PAPER=0` and `LIVE_TRADING_CONFIRMED=YES`. Tighten caps in `.env` (`MAX_NOTIONAL_USD_PER_INTENT=50`, `DAILY_LOSS_STOP_USD=25` to start).
4. Restart. Autonomous loop goes live; `/trades/live` requires `confirm_live: true` per call.
5. Kill switch: `touch $DATA_DIR/KILL_SWITCH` or `PUT /kill-switch {on:true}` halts new intents within one tick.

---

## Configuration

All env-driven. Sensible defaults; required vars depend on mode.

| var                          | required when      | default                               |
|------------------------------|--------------------|---------------------------------------|
| `PAPER`                      | always             | `1` (paper)                           |
| `LIVE_TRADING_CONFIRMED`     | live mode          | unset (must be `YES` to fill)         |
| `BIND_PUBLIC`                | exposing publicly  | `NO`                                  |
| `API_TOKEN`                  | `BIND_PUBLIC=YES`  | (refuses to boot without)             |
| `API_PORT`                   | always             | `8787`                                |
| `DATA_DIR`                   | always             | `./data`                              |
| `STRATEGY_API_BASE`          | always             | (set in .env.example)                 |
| `STRATEGY_API_KEY`           | strategy-api gated | (set in .env.example)                 |
| `MAX_NOTIONAL_USD_PER_INTENT`| always             | `200`                                 |
| `MAX_OPEN_POSITIONS`         | always             | `1`                                   |
| `MAX_LEVERAGE`               | always             | `5`                                   |
| `DAILY_LOSS_STOP_USD`        | always             | `50`                                  |
| `MIN_BALANCE_USD_PER_VENUE`  | live mode          | `50`                                  |
| `NYKS_WALLET_ID`             | Twilight live      | unset (paper noop)                    |
| `NYKS_WALLET_PASSPHRASE`     | Twilight live      | unset                                 |
| `BINANCE_API_KEY/SECRET`     | Binance live       | unset                                 |
| `BYBIT_API_KEY/SECRET`       | Bybit live         | unset                                 |
| `CLAUDE_CLI_PATH`            | npm-installed CLI  | unset (SDK auto-discovers)            |
| `CLAUDE_CHAT_MODEL`          | optional           | `claude-opus-4-7`                     |
| `CLAUDE_CONSULT_DISABLED`    | optional           | unset (gate runs in live mode)        |

Never commit `.env`. The repo's `.gitignore` covers it; `.env.example` and `.env.live.example` are the templates.

---

## Layout

```
src/
  index.ts              orchestrator entry, scheduler wiring, safety chain
  scheduler.ts          tick loop, in-flight gate, mismatch/timeout/3-strike
  pluginLoader.ts       skill discovery + runtime.yaml parsing
  api/
    server.ts           HTTP routes
    chat.ts             /chat — Claude copilot with state snapshot
  safety/
    guards.ts           layer 1 (caps, cooldown, skip-when-open)
    impactCheck.ts      layer 2 (pre-trade pool impact)
    claudeConsult.ts    layer 3 (Claude approval gate)
  dsl/
    engine.ts           layer 4 (exit rules + Phase-2 ratchet)
  exec/
    router.ts           three-leg fan-out + persistence
    twilight.ts         relayer-cli wrapper + SLTP retry
    cex.ts              ccxt wrapper (Binance + Bybit, attachStop, closeOptimized)
  feeds/
    strategyApi.ts      strategy-api client
    positionTracker.ts  cross-venue open-position fetcher

python/
  skill_sdk/            stdlib-only helpers (io, intents, dsl)

skills/
  funding-arb/          scanner.py + runtime.yaml + SKILL.md (only enabled skill)

deploy/
  bot-dashboard.html    private monitor (vanilla JS, Bearer-token gated)
  bot-monitor.nginx     reference reverse-proxy config
```

---

## Status

- ✅ M0–M4 complete. Single-skill funding-arb scanner shipping intents through the full safety stack.
- ✅ Strategy-api as canonical source for funding/skew/strategies (no local re-derivation).
- ✅ Senpi-inspired patches landed: cooldown, claudeConsult min_confidence, Phase-2 ratchet, FEE_OPTIMIZED_LIMIT close.
- ✅ Pre-trade `/api/impact` check + side-aware DSL `unrealized_pct`.
- ✅ Hard exchange-side stops on all three legs.
- ✅ Operator dashboard + `/chat` copilot deployed behind a private Bearer-token-gated proxy.
- ⏳ Multi-skill v2: slot accounting, per-skill margin, cross-skill ratcheting.
- ⏳ Tool-using `/chat`: upgrade from snapshot-context to MCP tools so the copilot can act (kill switch, close position, enable skill) on operator confirmation.
