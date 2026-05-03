# Twilight Tradebot — Implementation Plan v0.1

Status: **DRAFT — awaiting review.** No code is written yet. Sign off on this doc before scaffolding begins.

---

## 1. Goal

Build a **two-layer trading system**: a Senpi-shaped autonomous runtime that ticks every 10s on its own, *plus* an HTTP API that exposes the same state and execution surface to Claude Code (or any HTTP client) as the operator/strategist layer. The two layers share one SQLite database; either can read state, but execution responsibilities differ (see §4.4).

Concretely:

1. Continuously consume the Twilight Strategy API (`https://strategy.lunarpunk.xyz`) for live, ranked trading strategies across Twilight, Binance, and Bybit.
2. Execute profitable strategies as multi-leg trades: Twilight via `relayer-cli`, Binance + Bybit via `ccxt`. Autonomous python skills issue intents on their 10s tick; Claude Code can issue intents on demand via the HTTP API.
3. Track live positions, funding rates, and pool skew, and exit via a DSL rule engine.
4. Expose the runtime as a small HTTP API (JSON in/out, **localhost-bound by default with no auth**; public exposure is opt-in and requires a token — see §8). Endpoints cover state queries, paper trading, position management, kill-switch, and cap controls. Live execution from the API is gated by the same two-key opt-in as the autonomous loop *plus* a per-call `confirm_live: true` field. Claude Code calls these endpoints via `WebFetch` or `Bash + curl` — no MCP layer.
5. Ship as a single Railway container with persistent state on a `/data` volume.
6. Let new strategies be added as drop-in Python skill folders without touching the runtime.

**Success criteria for v1:**
- One `funding-arb` skill emits a **three-leg** intent (Twilight long + Binance short + Bybit short, hedge size split between the two CEXs by funding-rate weight) end-to-end and the runtime fills all three legs in PAPER mode. Mainnet behind a two-key opt-in.
- Exec router's partial-fill unwind path is exercised by an injected fault test (one CEX leg deliberately rejected) and the already-filled legs market-close cleanly.
- Position tracker reconciles fills across all three exchanges within one polling tick.
- DSL closes a three-leg position when an exit rule fires (single `close_all` action issues three closes).
- Kill-switch file halts new intents within one tick.
- Container boots clean on Railway with `/data` mounted, refusing to boot if >1 skill is enabled.
- Claude Code can hit the running container's HTTP API on `127.0.0.1`, list strategies, read positions, place a paper trade, and search past trade theses by full-text query — all without touching the autonomous loop, and using only `WebFetch` or `curl`. Public exposure is opt-in and requires a token (§8).

---

## 2. Non-goals (v1)

- WebSocket streaming. Strategy API is REST; we poll.
- Custom matching engine, order book reconstruction, or market making.
- Portfolio optimization across many concurrent skills. v1 runs one skill at a time per slot.
- Telegram, OpenClaw gateway, web UI. (Senpi's hyperclaw layer is deferred. We ship the runtime; UI/notifications come in v2.)
- Multi-account, multi-wallet orchestration. One Twilight wallet, one Binance account, one Bybit account.
- Backtesting framework.
- Auto-discovery / hot reload of skills. Restart container to load a new skill.
- Vector store / embeddings (lancedb, pgvector, faiss, etc.). Even with Claude Code as the agent layer, v1 doesn't pull weight from a vector store: trade-thesis search uses **SQLite FTS5** (virtual table over `intents.thesis` + `intents.skill`), doc retrieval uses Claude Code's built-in `WebFetch` + file reads, and conversational memory uses Claude Code's existing file-based memory system. Reconsider only when (a) skill count grows past ~10 and thesis-matched skill selection becomes a real query, (b) we ingest unstructured news/sentiment, or (c) FTS5 BM25 ranking proves insufficient for trade-postmortem retrieval. Until any of those, no new vector dep.

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  AGENT LAYER — Claude Code (on demand, operator/strategist)      │
│   ├── /twilight-trader, /twilight-strategies (existing skills)   │
│   ├── reads MEMORY.md, WebFetches docs, reads project files      │
│   └── calls Tradebot HTTP API via WebFetch or `curl`             │
└──────────────────────────────┬───────────────────────────────────┘
                               │ HTTP + Bearer auth
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│  RUNTIME LAYER — single Railway container                        │
│                                                                  │
│  ┌──────────────────────────┐    ┌────────────────────────────┐  │
│  │  TS host (orchestrator)  │◀──▶│  HTTP API (node:http)      │  │
│  │  scheduler + exec router │    │  GET  /strategies, /market │  │
│  │  pluginLoader, safety    │    │  GET  /positions, /trades  │  │
│  │  feeds, dsl/engine       │    │  POST /trades/paper, /live │  │
│  └────────┬─────────────────┘    │  POST /positions/:id/close │  │
│           │                      │  POST /skills/:n/enable    │  │
│           ▼                      │  GET/PUT /kill-switch,/caps│  │
│  ┌──────────────────┐    ┌───────┴──────────────────┬───────┐    │
│  │  Python skills   │    │  SQLite (/data)          │       │    │
│  │  funding-arb     │    │  intents/fills/...       │◀──────┘    │
│  │  (autonomous     │    │  + ticks + decisions     │            │
│  │   10s tick loop) │    │  + FTS5 on thesis        │            │
│  └────────┬─────────┘    └──────────────────────────┘            │
└───────────┼──────────────────────────────────────────────────────┘
            │
            ▼
   relayer-cli, ccxt(binance), ccxt(bybit), Strategy API
```

```
┌───────────────────────────────┐
│  PYTHON SKILL (one per slot)  │
│                               │
│  scanner.py                   │
│   ├── reads stdin (JSON tick) │
│   ├── runs strategy logic     │
│   └── writes stdout (intent)  │
│                               │
│  runtime.yaml — config        │
│  SKILL.md     — agent prompt  │
└───────────────────────────────┘
```

**Why this shape:**
- **Two layers, one state.** The autonomous python loop runs every 10s for fast-path trigger response (funding flips, DSL exits). Claude Code is the slow-path: ad-hoc queries, strategy authoring, postmortems. Both read/write the same SQLite DB; the HTTP API is a thin endpoints-over-state layer.
- **TS owns long-lived stuff**: process supervision, state, exec, scheduling, HTTP API. Typed, async-native, matches the workspace.
- **Python owns short-lived per-tick decision logic.** Strategies turn over fastest; Python keeps them readable and hot-swappable, matches Senpi's contributor expectations.
- **Stdio JSON for the python boundary, plain HTTP for the agent boundary.** Stdio is the cleanest contract for spawned children; HTTP is the cleanest contract for everything else and Claude Code already speaks it via `WebFetch` and `Bash + curl`. No MCP layer to introduce or maintain.
- **No vector store.** SQLite FTS5 covers thesis search; Claude Code handles doc retrieval directly via WebFetch and file reads.

---

## 4. Component responsibilities

### 4.1 TS host (`src/`)

| Module | Responsibility |
|---|---|
| `index.ts` | Boot: load env, init db, start scheduler, register signal handlers. |
| `pluginLoader.ts` | Walk `skills/*/`, parse `runtime.yaml`, register each skill's poll interval and entrypoint. **v1 hard rule**: refuses to boot if more than one `enabled: true` skill is present (see §8). Multi-skill is v2. |
| `pythonHost.ts` | Spawn `python3 scanner.py` per skill with persistent stdio. Frame messages as newline-delimited JSON. Maintains a per-skill `inFlight: tick_id \| null` flag and a per-skill `consecutiveTimeouts` counter. Restart on crash with exponential backoff. |
| `scheduler.ts` | Per-skill `setInterval`. **One in-flight tick per skill**: if `inFlight` is set when the timer fires, the new tick is dropped (logged, not retried). Each accepted tick: gather feed snapshot → send to skill stdin with `tick_id` → race response against `poll_interval × 0.8` timeout → on reply, validate `tick_id` matches; mismatched/late replies are discarded → hand intent to safety → hand to exec router → persist outcome → clear `inFlight`. After 3 consecutive timeouts the skill is auto-disabled. |
| `feeds/strategyApi.ts` | GET `/api/strategies`, `/api/market`, `/api/categories`. Cache for 1 tick. Auth via `x-api-key`. |
| `feeds/positionTracker.ts` | Periodic `relayer-cli portfolio summary --json` + `ccxt.fetchPositions()` for Binance + Bybit. Reconciles to a flat position list. |
| `feeds/fundingTracker.ts` | Pulls funding rates from `/api/market`. Emits `nextFundingTime` per venue so DSL can roll positions before settlement. |
| `exec/router.ts` | Receives validated intent. Splits legs by venue, fans out to executors, awaits all, returns aggregate result. |
| `exec/twilight.ts` | Wraps `relayer-cli` as `child_process.spawn`. Handles `--json` parsing, account-rotation rule (`zkaccount transfer` after settle), error mapping. |
| `exec/binance.ts` / `exec/bybit.ts` | `ccxt` perp futures clients. Margin mode, leverage, post-only, reduce-only flags. |
| `dsl/engine.ts` | Evaluates exit rules per tick against the position + market snapshot. On match, emits a CLOSE intent. |
| `state/db.ts` | `better-sqlite3` schema for skills, intents, fills, positions, ticks, decisions. Plus an FTS5 virtual table `intents_fts(thesis, skill UNINDEXED, content='intents')` rebuilt on each `intents` insert. |
| `safety/guards.ts` | Pre-flight every intent: paper mode, kill switch, daily P&L stop, max notional, max open positions, address-rotation precondition, **per-skill budget** (§4.3). Same code path used by autonomous skills *and* the HTTP `POST /trades/paper` and `POST /trades/live` endpoints. |
| `api/server.ts` | HTTP API server using `node:http` (zero deps). Endpoints defined in §4.4. **Binds `127.0.0.1` by default — no auth.** Public exposure requires `BIND_PUBLIC=YES` *and* `API_TOKEN=...`; if `BIND_PUBLIC=YES` is set without a token, runtime refuses to boot. Reuses feeds, state/db, exec/router, safety/guards — does *not* re-implement them. |
| `log.ts` | Structured JSON logs to stdout. Include tick id, skill name, intent id, request id. |

### 4.2 Python skill SDK (`python/skill_sdk/`)

| Module | Responsibility |
|---|---|
| `io.py` | Read JSON line from stdin, write JSON line to stdout. Auto-flush. Convert `noop` shorthand. |
| `dsl.py` | Helpers for constructing exit-rule objects (so skills don't hand-write JSON). |
| `intents.py` | Helpers for building multi-leg intents with sane defaults. |

Skills must run with **stdlib only** for portability. The SDK is also stdlib.

### 4.3 Skill contract (`skills/<name>/`)

Each skill folder contains:
- `runtime.yaml` — name, version, enabled, poll_interval, **budget**, **slots**, **margin_per_slot**, env requirements (see schema below). Inspired by Senpi.
- `SKILL.md` — agent-readable description (thesis, params, expected behavior). Also human docs.
- `scanner.py` — `main()` reads stdin in a loop, writes intents.

**`runtime.yaml` schema:**

```yaml
name: funding-arb
version: 0.1.0
enabled: true                    # only one skill may be enabled in v1 (§8)
poll_interval: 10s
timeout_ratio: 0.8               # tick timeout = poll_interval × this (§6)
budget: 1000                     # USD notional cap for this skill's open exposure
slots: 1                         # number of concurrent positions this skill may hold
margin_per_slot: 400             # USD margin posted per slot — sanity-checks intent sizing
env:                             # env vars this skill expects on the host
  - STRATEGY_API_BASE
  - STRATEGY_API_KEY
```

**Per-skill budget enforcement (v1).** `safety/guards` reads `budget`/`slots`/`margin_per_slot` from each enabled skill's `runtime.yaml` at boot. For any intent emitted by a skill, the guard layer rejects if:
- `sum(open_intent.notional_usd for skill) + intent.notional_usd > budget`, or
- `count(open_positions for skill) >= slots`, or
- `intent.notional_usd / intent.leverage > margin_per_slot × 1.1` (10% headroom).

In v1 with one skill, this is parallel insurance to the global `MAX_NOTIONAL_USD_PER_INTENT` / `MAX_OPEN_POSITIONS` env caps. **Whichever cap is tighter wins.** The point is to declare per-skill caps at the skill level so v2 multi-skill doesn't need a schema change.

### 4.4 HTTP API surface

JSON in, JSON out. Bound to `127.0.0.1:${API_PORT:-8787}` by default — no auth. Public binding (`BIND_PUBLIC=YES`) requires `API_TOKEN` (Bearer) and refuses to boot otherwise. All endpoints share the runtime's safety and state code paths; the API layer must not own its own copies of guards or DB writes.

| Method + Path | Purpose | Live? |
|---|---|---|
| `GET /strategies?category=&risk=&profitable=&minApy=&limit=` | Proxies `/api/strategies` upstream. | read-only |
| `GET /market` | Cached `/api/market` snapshot from the most recent tick. | read-only |
| `GET /positions?venue=` | Open positions across all venues, reconciled from positionTracker. | read-only |
| `GET /trades/:intent_id` | Full intent + legs + fills + DSL decisions. | read-only |
| `GET /trades?q=&since=&limit=` | FTS5 BM25 query over `intents.thesis`. Empty `q` → recent intents. | read-only |
| `GET /ticks?skill=&since=&status=` | Heartbeat rows from the `ticks` table for debugging. | read-only |
| `POST /trades/paper` body `{legs, exit_rules}` | Issue a multi-leg intent in PAPER mode. Bypasses python skills entirely; routed through `safety/guards` and `exec/router`. | paper-only |
| `POST /trades/live` body `{legs, exit_rules, confirm_live: true}` | Same path, live mode. **Requires both** `LIVE_TRADING_CONFIRMED=YES` env on the container *and* `confirm_live: true` in body. Either missing → 400. | live (gated) |
| `POST /positions/:position_id/close` | Reduce-only market close. Mode (paper/live) inherits from the position's intent. | mirrors intent |
| `POST /skills/:name/enable` / `POST /skills/:name/disable` | Toggle a skill's `enabled` flag. Subject to v1 single-skill-enabled rule (refuses if it would result in 0 or >1 enabled). | mutating |
| `GET /kill-switch` / `PUT /kill-switch` body `{on: bool}` | Read or set `/data/KILL_SWITCH` file. | mutating |
| `GET /caps` / `PUT /caps` body `{max_notional_usd?, max_leverage?, daily_loss_stop_usd?}` | Read or write the runtime caps. Cap *increases* in live mode require `confirm_live: true`. | mutating |
| `GET /healthz` | Liveness probe — returns process uptime, last tick id per skill, db open status. | read-only |

**Out of API surface (deliberately):**
- Process shutdown/restart — out-of-band only via container ops.
- Direct `relayer-cli` shell — clients can't bypass `safety/guards`.
- Skill code editing — skills ship with the container; edit in repo, not at runtime.

**Public exposure:** if you set `BIND_PUBLIC=YES`, the runtime requires `API_TOKEN` and enforces `Authorization: Bearer ${API_TOKEN}` on every endpoint. Without `BIND_PUBLIC`, the API listens on `127.0.0.1` only and the token is ignored. This keeps the local-dev / `railway shell` path zero-friction while making public exposure explicit.

---

## 5. Data contracts

### 5.1 Strategy API responses (already live, verified)

`/api/market` snapshot (verified at deploy time):
```json
{
  "prices": {"twilight": 74478, "binanceFutures": 74478, "bybit": 76275},
  "fundingRates": {
    "binance": {"rate": -0.00005464, "annualizedAPY": "5.98%", "nextFundingTime": 1776643200000},
    "twilight": {"rate": 0.0001125,  "annualizedAPY": "12.32%"},
    "bybit":   {"rate": -0.0000544,  "annualizedAPY": "5.96%", "nextFundingTime": 1777564800000}
  },
  "spreads": {"twilightVsBinance": {"pct": "0.0000%"}, "twilightVsBybit": {"pct": "-2.3559%"}},
  "pool":    {"currentSkewPct": "65.0%", "isLongHeavy": true}
}
```

Categories available (verified): `Directional`, `CEX Only`, `Delta-Neutral`, `Funding Arb`, `Conservative`, `Capital Efficient`, `Funding Harvest`, `Dual Arb`, `Bybit Inverse`.

`/api/strategies` returns **all 38 strategies as a ranked list** (not a single best pick), wrapped as `{count, timestamp, btcPrice, strategies: [...]}` and freshly recomputed against current market data every call. `?profitable=true&limit=N` returns the top-N by APY descending. Each strategy is a parameterized template carrying live `apy`, `dailyPnL`, `monthlyPnL`, liquidation prices, `totalMaxLoss`, and stress-PnL at ±5%/±10% price moves.

**Two-leg-API constraint (load-bearing for skill design).** Strategy templates are **two-leg**: Twilight + exactly one CEX (`binancePosition`/`binanceSize`/`binanceLeverage` *or* the Bybit-inverse equivalent on `Bybit Inverse` strategies). Our v1 success criteria require **three legs** (Twilight + Binance + Bybit). Therefore the **funding-arb skill is responsible for deriving the third leg** by splitting the modeled CEX hedge across Binance and Bybit per the runtime's hedge-weighting rule (currently: weight by `|funding_rate|`, capped at 70/30). The Strategy API does not model this split; it never will be in a single template. Skills that map an API template to an intent must declare the split explicitly in their `legs` array.

### 5.2 Stdio protocol — Host → Skill (per tick)

```json
{
  "type": "tick",
  "tick_id": "uuid",
  "ts": 1714493000000,
  "market": { /* /api/market */ },
  "strategies": [ /* /api/strategies?profitable=true&limit=20 */ ],
  "positions": [
    {
      "id": "pos_uuid",
      "venue": "twilight",
      "side": "long",
      "size_sats": 12500000,
      "entry_price": 74000,
      "leverage": 5,
      "opened_at": 1714400000000,
      "skill": "funding-arb"
    }
  ],
  "wallet": {"twilight_sats": 50000000, "binance_usdt": 1000.0, "bybit_usdt": 1000.0}
}
```

### 5.3 Stdio protocol — Skill → Host

```json
{
  "type": "intent",
  "intent_id": "uuid",
  "tick_id": "uuid",
  "skill": "funding-arb",
  "thesis": "twilight 12.3% vs binance -5.98% vs bybit -5.96% → long twilight, hedge split short binance/bybit weighted by |funding|",
  "chosen_strategy_id": 18,
  "legs": [
    {
      "venue": "twilight",
      "side": "long",
      "size_sats": 5000000,
      "leverage": 5,
      "order_type": "MARKET",
      "max_slippage_bps": 50
    },
    {
      "venue": "binance",
      "symbol": "BTCUSDT",
      "contract_type": "linear",
      "side": "short",
      "size_usd": 1850,
      "leverage": 5,
      "order_type": "MARKET",
      "post_only": false,
      "reduce_only": false
    },
    {
      "venue": "bybit",
      "symbol": "BTCUSD",
      "contract_type": "inverse",
      "side": "short",
      "size_usd": 1850,
      "leverage": 5,
      "order_type": "MARKET",
      "post_only": false,
      "reduce_only": false
    }
  ],
  "exit": {
    "rules": [
      {"if": "funding_rates.twilight.rate < funding_rates.binance.rate and funding_rates.twilight.rate < funding_rates.bybit.rate", "do": "close_all"},
      {"if": "pnl.unrealized_pct >= 0.5", "do": "close_all"},
      {"if": "pnl.unrealized_pct <= -0.3", "do": "close_all"},
      {"if": "time_in_position_hours >= 8", "do": "close_all"},
      {"if": "pool.skew_pct >= 0.85", "do": "close_all"}
    ]
  }
}
```

Or:
```json
{ "type": "noop", "tick_id": "uuid", "reason": "spread below threshold" }
```

**`chosen_strategy_id` (optional, integer).** When the skill's intent maps to a specific Strategy API template, the skill emits `chosen_strategy_id` referencing the `id` field from the `strategies` array delivered in that tick's payload. The **host enriches** the persisted intent row by:
1. Validating that `chosen_strategy_id` was present in the strategies list it sent on `tick_id`. If not, the intent is rejected with `reason='strategy_id_not_in_tick'`.
2. Looking up the matching strategy object from the cached tick payload and persisting its `name` to `intents.chosen_strategy_name` and the full strategy JSON to `intents.chosen_strategy_json`.

If the skill builds a custom intent that doesn't correspond to any API template (e.g., a hand-shaped multi-leg construction), it omits `chosen_strategy_id` and all three columns are `NULL`. This keeps the field optional without losing traceability when it *is* used. Snapshot persistence at decision time is the point — rankings drift between ticks, so a postmortem days later needs the exact `apy` / `monthlyPnL` / liquidation prices the skill saw.

### 5.4 DSL rule grammar (v1, intentionally tiny)

A rule is `{if: <expr>, do: <action>}`.
- `<expr>` — a string parsed into a small AST: identifier paths (`pnl.unrealized_pct`, `funding_rates.twilight.rate`, `time_in_position_hours`, `pool.skew_pct`), numeric literals, comparison ops (`<`, `<=`, `>`, `>=`, `==`), boolean `and`/`or`, parens.
- `<action>` — one of `close_all`, `close_leg:<venue>`, `flip_direction`. v1 supports `close_all` only; others stubbed.

No arithmetic, no function calls. Adding either requires a runtime version bump and a new test.

### 5.5 SQLite schema (state/db.ts)

```sql
CREATE TABLE skills (
  name TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_tick_at INTEGER
);

CREATE TABLE intents (
  intent_id TEXT PRIMARY KEY,
  skill TEXT NOT NULL,
  ts INTEGER NOT NULL,
  thesis TEXT,
  legs_json TEXT NOT NULL,
  exit_json TEXT NOT NULL,
  status TEXT NOT NULL,           -- 'pending'|'approved'|'rejected'|'filled'|'failed'|'closed'
  rejected_reason TEXT,
  chosen_strategy_id INTEGER,     -- /api/strategies id at decision time, NULL for custom intents
  chosen_strategy_name TEXT,      -- enriched from the tick's cached strategies list
  chosen_strategy_json TEXT       -- full strategy snapshot at decision time (apy, pnl, liq, stress)
);
CREATE INDEX idx_intents_strategy ON intents(chosen_strategy_id) WHERE chosen_strategy_id IS NOT NULL;

CREATE TABLE fills (
  fill_id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES intents(intent_id),
  venue TEXT NOT NULL,
  side TEXT NOT NULL,
  size REAL NOT NULL,
  price REAL NOT NULL,
  fee REAL NOT NULL DEFAULT 0,
  raw_json TEXT NOT NULL,
  ts INTEGER NOT NULL
);

CREATE TABLE positions (
  position_id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  venue TEXT NOT NULL,
  side TEXT NOT NULL,
  size REAL NOT NULL,
  entry_price REAL NOT NULL,
  leverage REAL NOT NULL,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  realized_pnl REAL
);

CREATE TABLE ticks (            -- per-skill heartbeat, populated from M1 onward
  tick_id TEXT PRIMARY KEY,
  skill TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,           -- 'noop'|'intent'|'timeout'|'mismatch'|'crashed'|'dropped_overlap'
  intent_id TEXT,                 -- nullable; set when status='intent'
  latency_ms INTEGER,
  error TEXT
);
CREATE INDEX idx_ticks_skill_started ON ticks(skill, started_at DESC);

CREATE TABLE decisions (        -- DSL evaluations, even non-firing, for debugging (M3+)
  ts INTEGER NOT NULL,
  position_id TEXT,
  rule_json TEXT NOT NULL,
  fired INTEGER NOT NULL,
  metrics_json TEXT NOT NULL
);

-- FTS5 over intent theses, served by GET /trades?q=... (§4.4).
-- Maintained by AFTER INSERT / AFTER UPDATE triggers on intents.
CREATE VIRTUAL TABLE intents_fts USING fts5(
  thesis,
  skill UNINDEXED,
  intent_id UNINDEXED,
  ts UNINDEXED,
  tokenize = 'porter unicode61'
);
```

---

## 6. Control flow per tick

```
1. scheduler fires (skill = funding-arb, interval = 10s)
   ├─ if pythonHost[skill].inFlight is set:
   │     log status='dropped_overlap' to ticks table; return.   <-- NEW
   └─ else: tick_id = uuid(); pythonHost[skill].inFlight = tick_id; ticks.insert(started_at)
2. feeds.snapshot()
   └─ in parallel: strategyApi.market(), strategyApi.strategies(), positionTracker.all(), wallet.balances()
3. dsl.engine.evaluate(open_positions, snapshot)
   └─ if any rule fires: build CLOSE intent, jump to 6
4. pythonHost.send({type:"tick", tick_id, ...snapshot})
5. race: skill stdout reply  vs  setTimeout(poll_interval × 0.8)
   ├─ on reply with matching tick_id: status='intent' or 'noop' → continue
   ├─ on reply with mismatched tick_id (late from a prior tick): discard, log status='mismatch', return
   ├─ on timeout: ticks.update(status='timeout'); inFlight cleared; consecutiveTimeouts++
   │              if consecutiveTimeouts >= 3: skill auto-disabled, alert logged.   <-- NEW
   └─ on skill crash mid-tick: status='crashed'; pythonHost restarts with backoff.
6. safety.guards.check(intent)
   ├─ paper mode? mark "paper", continue with simulator
   ├─ kill switch? reject
   ├─ over caps? reject
   └─ ok → continue
7. exec.router.fanOut(intent.legs)
   ├─ twilight: relayer-cli order open-trade ... --json
   ├─ binance:  ccxt.binance.createOrder(...)
   └─ bybit:    ccxt.bybit.createOrder(...)
8. persist intent + fills + positions; ticks.update(finished_at, intent_id)
9. log structured event
10. clear pythonHost[skill].inFlight
```

**Tick-overlap policy (locked):**
- One in-flight tick per skill, ever. New ticks fired while one is in flight are dropped (logged, not queued, not retried).
- Hard timeout = `poll_interval × 0.8` (8s for default 10s interval). Configurable per skill via `runtime.yaml`.
- Late replies are detected by `tick_id` mismatch and discarded; they cannot affect state.
- 3 consecutive timeouts auto-disables the skill until container restart. (No silent backoff-and-pray.)

If any exec leg fails after another leg already filled, exec.router triggers an **unwind** of the filled legs (best-effort market-close with `reduceOnly=true`) and marks the intent `failed`. This is where most of the realistic risk lives — see §8.

---

## 7. Repo layout (final v1)

```
tradebot/
├── IMPLEMENTATION_PLAN.md         (this file)
├── README.md                      (deploy + dev instructions)
├── package.json
├── tsconfig.json
├── Dockerfile                     (multi-stage: node + python + relayer-cli)
├── railway.toml
├── .env.example
├── .gitignore
├── src/
│   ├── index.ts
│   ├── pluginLoader.ts
│   ├── pythonHost.ts
│   ├── scheduler.ts
│   ├── log.ts
│   ├── feeds/
│   │   ├── strategyApi.ts
│   │   ├── positionTracker.ts
│   │   └── fundingTracker.ts
│   ├── exec/
│   │   ├── router.ts
│   │   ├── twilight.ts
│   │   ├── binance.ts
│   │   └── bybit.ts
│   ├── dsl/
│   │   └── engine.ts
│   ├── state/
│   │   └── db.ts
│   └── safety/
│       └── guards.ts
├── python/
│   ├── requirements.txt           (empty in v1; stdlib only)
│   └── skill_sdk/
│       ├── __init__.py
│       ├── io.py
│       ├── dsl.py
│       └── intents.py
└── skills/
    └── funding-arb/
        ├── runtime.yaml
        ├── SKILL.md
        └── scanner.py
```

---

## 8. Safety model

**Default mode is paper.** Going live requires **both**:
- `PAPER=0`
- `LIVE_TRADING_CONFIRMED=YES`

If only one is set, runtime refuses to boot and logs a clear error. Two keys, by design — single env vars get flipped accidentally.

**Kill switch.** On every tick the runtime stats `/data/KILL_SWITCH`. If present, `safety.guards.check` rejects all new intents (existing positions still close on DSL rules; `KILL_HARD` halts all activity).

**Caps (env-configured, hard rejects):**
- `MAX_NOTIONAL_USD_PER_INTENT` (default 200)
- `MAX_OPEN_POSITIONS` (default 1 in v1 — single-slot)
- `DAILY_LOSS_STOP_USD` — once realized + unrealized P&L crosses below this, halt new intents until `date_changed`
- `MAX_LEVERAGE` (default 5)
- `MIN_BALANCE_USD_PER_VENUE` (default 50)

**Single-skill load rule (v1).** `pluginLoader` enumerates `skills/*/runtime.yaml` and counts entries with `enabled: true`. If the count is anything other than 1, the runtime refuses to boot with a clear error. This is the only race-free way to honor `MAX_OPEN_POSITIONS=1` without a slot lease. Multi-skill orchestration is deferred to v2 (see below).

**API binding rule (v1).** The HTTP API binds `127.0.0.1` by default — no auth, no token, no exposure. To bind a public interface, both env vars must be set: `BIND_PUBLIC=YES` *and* `API_TOKEN=<random>`. Setting `BIND_PUBLIC=YES` without a token causes the runtime to refuse to boot. This keeps the local-dev path frictionless and forces a deliberate two-step before the wallet can be drained from the open internet, which matters because `/trades/live` exists.

**Tick-overlap and timeout (v1).** Codified in §6 control flow — one in-flight tick per skill, hard timeout `poll_interval × 0.8`, late replies discarded by `tick_id`, 3-strike auto-disable. These properties are tested in M1.

**Slot lease (v2 design, NOT in v1).** When v2 raises `MAX_SLOTS > 1`, a transactional slot lease replaces the single-skill rule:
- `intents` gains a generated column `slot_active INTEGER GENERATED ALWAYS AS (CASE WHEN status IN ('approved','filled') THEN 1 END) VIRTUAL`.
- A partial unique index `CREATE UNIQUE INDEX one_active_per_slot ON intents(skill, slot_active) WHERE slot_active IS NOT NULL` makes the second concurrent approval fail at the DB layer rather than the guard layer.
- `safety.guards.check` runs inside `BEGIN IMMEDIATE; INSERT INTO intents (...) status='approved'; COMMIT;` — concurrent inserts losing the race get `SQLITE_CONSTRAINT` and are rejected with `reason='lost_slot_race'`.
This design is recorded here so v2 doesn't reinvent it; v1 does not implement it.

**Address-rotation precondition.** On Twilight, `safety.guards` blocks any `open-trade` intent on an account that is in `Memo` state or has not been transferred since last settle. This is the one Twilight-specific rule that, if violated, hard-locks an account.

**Unwind on partial fill failure.** If leg N+1 fails after legs 1..N filled, exec.router issues market-close on legs 1..N and marks intent `failed`. The DSL is *not* used for unwind — too slow and too policy-driven. This is dedicated logic.

**Reduce-only on close.** All closes go out with `reduceOnly=true` so a stale signal can't accidentally open opposite positions.

---

## 9. Phases

Each phase ships a working, runnable, verifiable artifact. Don't start phase N+1 until N is green.

### M0 — scaffold compiles, container boots  *(target: half-day)*
- Repo structure, `package.json`, `tsconfig.json`, `Dockerfile`, `railway.toml`, `.env.example`.
- `src/index.ts` boots, reads env, prints "ok", waits.
- `python/skill_sdk` empty stubs.
- One `skills/noop` skill (the only one with `enabled: true`) that prints `noop` on every tick.
- `pluginLoader` enforces single-skill rule (refuses boot if >1 enabled).
- `npx tsc` clean. Container builds locally.

### M1 — feeds + python host loop  *(target: 1–2 days)*
- `feeds/strategyApi.ts`: `GET /api/market`, `GET /api/strategies` working with auth.
- `pythonHost.ts`: spawn skill, send tick with `tick_id`, validate reply matches, log roundtrip latency.
- `scheduler.ts`: in-flight gate, `poll_interval × 0.8` timeout, late-reply discard, 3-strike auto-disable.
- SQLite schema applied on boot. `ticks` heartbeat table populated unconditionally.
- Verification: container running locally writes **one row per skill per tick to `ticks`** with `status='noop'`. Inject a synthetic 30s sleep into the noop skill once → verify `status='timeout'` and that the skill is auto-disabled after 3 such ticks. Inject a delayed reply with stale `tick_id` → verify `status='mismatch'` and no spurious intent.

### M2 — exec layer, paper mode end-to-end  *(target: 2–3 days)*
- `exec/twilight.ts`: wraps `relayer-cli`, parses `--json`, mocks fills in PAPER mode by reading `/api/market` price.
- `exec/binance.ts`: `ccxt` linear-USDT-M client (`BTCUSDT`), createOrder/setLeverage/fetchPositions/reduceOnly closes, paper-mode simulator path.
- `exec/bybit.ts`: `ccxt` **inverse** client (`BTCUSD`, contract size 1 USD), createOrder/setLeverage/fetchPositions/reduceOnly closes, paper-mode simulator path. Both Binance and Bybit must reach paper-fill in M2 — three-leg sign-off is the v1 success bar (§1).
- `exec/router.ts`: fan-out + unwind path.
- `safety/guards.ts`: all caps, kill switch, two-key opt-in, single-skill enforcement reused from `pluginLoader`.
- `funding-arb` skill emits the three-leg intent in §5.3 (Twilight long + Binance short + Bybit short, hedge weighted).
- Verification: PAPER funding-arb skill emits an intent, three legs simulate-fill, positions table populated, `ticks` row links to `intent_id`, kill switch halts the next intent. **Plus injected-fault test**: force binance leg reject → verify twilight + bybit unwind fires and intent is `failed` with no orphan positions.

### M3 — DSL exit + position tracker  *(target: 2 days)*
- `feeds/positionTracker.ts`: real position reconciliation across all three venues.
- `dsl/engine.ts`: AST parser + evaluator for the v1 grammar. **`decisions` table starts populating here.**
- Verification: open paper position, set funding-rate flip in mock, DSL fires close, three-leg `close_all` issues three reduceOnly closes, `positions` rows closed with realized PnL, `decisions` rows show the firing rule and metrics snapshot.

### M4 — first mainnet flip  *(target: 1 day after M3 is solid for >24h in paper)*
- `LIVE_TRADING_CONFIRMED=YES` documented but unset by default.
- Mainnet caps tightened to `MAX_NOTIONAL_USD_PER_INTENT=50`.
- Run on Railway with real keys for at least 24h paper before any live flip.

### Out of v1 (parking lot)
- Multi-skill orchestration / portfolio caps across slots.
- Telegram + OpenClaw gateway.
- Web UI.
- Streaming feeds.
- Backtest harness.
- Skill marketplace / catalog.json.

---

## 10. Open questions (need user input)

1. ~~**CEX hedge symbol mapping (Binance)**~~ **Resolved:** Binance v1 = linear USDT-M `BTCUSDT`. Reasoning kept for cross-ref: liquidity wins over apples-to-apples PnL with Twilight; PnL reconciliation handled at intent-shape level via `contract_type: "linear"` (§5.3) and a USD↔sats conversion in `feeds/positionTracker`.
2. **Bybit symbol.** **Resolved:** use inverse perp on Bybit in v1 (`BTCUSD`, subject to exact ccxt market id at implementation time). Binance remains a separate decision (§10.1).
3. **Strategy API key.** Loaded from env (`STRATEGY_API_KEY`). No default in code — operator provides their own.
4. **Mainnet wallet provisioning.** Plan assumes you already have a `relayer-cli` mainnet wallet, BTC deposit registered, and ZkOS account funded. Confirm — this is *not* automated by v1.
5. ~~**Single concurrent slot or per-skill?**~~ **Resolved:** v1 hard rule — `pluginLoader` refuses boot if >1 skill is `enabled: true`. Lease design captured in §8 for v2. (Kept here numbered for cross-refs.)
6. **`relayer-cli` install path in container.** The `install.sh` may put the binary at `~/.cargo/bin/relayer-cli` or `~/.local/bin/relayer-cli` depending on env. Plan is to handle both at Docker build time. If you have a known-good binary URL or pre-built tarball, point me at it — building from source in the image is slow.
7. **What model/host for the OpenClaw layer if/when v2 happens?** Senpi's hyperclaw expects an `AI_PROVIDER` + `AI_API_KEY`. Out of scope for v1 but informs API surface decisions.

---

## 11. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Twilight `relayer-cli` binary fails to install in slim Debian image | Medium | Fall back to building from source in stage 1; pin commit. |
| Partial fill: Twilight leg fills, Binance rejects | High | exec.router unwind path with reduce-only market close; alert-on-fail. |
| Funding-rate flip happens between feed snapshot and exec | Medium | DSL re-evaluates every tick; close on first re-eval after flip. Acceptable given v1 latency budget. |
| Address-rotation rule violated → ZkOS account locked | Medium | `safety.guards` precondition; rotate eagerly on settle. |
| Pool skew flips against us mid-trade | Medium | DSL rule `pool.skew_pct >= 0.85 → close_all`. |
| Strategy API down | Low | Skip tick, log, keep DSL evaluating existing positions on cached funding rates. |
| `ccxt` version drift breaks symbol/endpoint expectations | Medium | Pin major version; smoke-test on container build. |
| Mainnet enabled by accident | Low (with two-key opt-in) | Refuse boot if exactly one of `PAPER=0` / `LIVE_TRADING_CONFIRMED=YES` is set. |
| State db corruption on volume | Low | WAL mode + nightly `.backup` to `/data/backups/`. |
| Skill scanner crashes mid-tick | Medium | `pythonHost` exponential backoff restart, tick logged as `crashed`. |
| Skill takes longer than its tick interval (overlap → mis-correlated stdin/stdout) | High without policy | One in-flight tick per skill, hard timeout `poll_interval × 0.8`, `tick_id` correlation, late-reply discard, 3-strike auto-disable (§6). Verified in M1. |
| Two skills race past `MAX_OPEN_POSITIONS=1` guard before either persists | Medium without policy | v1 single-skill load rule — `pluginLoader` refuses boot if >1 enabled (§8). v2 will use a transactional slot lease (§8). |
| API exposed publicly with no auth → wallet drain via `/trades/live` | High without policy | Default bind `127.0.0.1`. Public bind requires `BIND_PUBLIC=YES` + `API_TOKEN`; runtime refuses boot otherwise. Live trades additionally require `LIVE_TRADING_CONFIRMED=YES` env *and* `confirm_live: true` in request body (§4.4, §8). |
| v2 multi-skill arrives and per-skill capital caps weren't declared upfront | Medium | `runtime.yaml` already declares `budget`/`slots`/`margin_per_slot` per skill in v1; safety guard enforces them alongside global env caps (§4.3). Schema is forward-compatible. |

---

## 12. References

- `/Users/gauravshukla/Downloads/demotrade/` — local nyks-wallet copy with relayer-cli (build from there if install.sh fails in Docker).
- `/Users/gauravshukla/Downloads/trade/agentskill/` — current Claude Code skills (`/twilight-trader`, `/twilight-strategies`).
- `https://github.com/Senpi-ai/senpi-skills` — runtime shape we're cloning.
- `https://github.com/Senpi-ai/senpi-hyperclaw-railway-template` — Railway packaging shape (deferred to v2).
- `https://github.com/twilight-project/nyks-wallet/blob/v0.1.2-relayer-cli/docs/agent-skill-relayer-cli.md` — relayer-cli reference.
- Strategy API: `https://strategy.lunarpunk.xyz` — auth header `x-api-key: $STRATEGY_API_KEY`.

---

## 13. Sign-off checklist

Before scaffolding:
- [x] **Binance** hedge symbol — locked to linear `BTCUSDT` (USDT-M). (§10.1)
- [x] **Bybit** hedge symbol — locked to inverse `BTCUSD`; exact ccxt market id TBD at implementation time. (§10.2)
- [ ] Mainnet wallet provisioning confirmed (§10.4)
- [x] Single-skill v1 rule resolved (§10.5 → §8) — assumed green; reopen if you disagree
- [x] Tick-overlap policy resolved (§6) — assumed green
- [x] Bybit/three-leg consistency resolved (§1, §5.3) — assumed green
- [x] M1 verification uses `ticks` not `decisions` (§5.5, §9) — assumed green
- [x] No vector store in v1 (§2 — explicit non-goal)
- [x] HTTP API instead of MCP, localhost-default with token-only public exposure (§4.4, §8)
- [x] Per-skill `budget`/`slots`/`margin_per_slot` declared in `runtime.yaml` and enforced by `safety/guards` (§4.3) — Senpi parity
- [ ] Phase order acceptable (§9)
- [ ] Safety defaults acceptable (§8)
- [ ] No additions to v1 scope (§2 holds)

Once those are green, M0 starts.

---

## 14. Changelog

- **v0.6** — Strategy API shape made explicit: returns ranked list of all 38 templates, not a single best pick (§5.1). Two-leg-API constraint documented as load-bearing for skill design — Strategy templates are Twilight + one CEX, so the funding-arb skill is responsible for splitting the modeled CEX hedge across Binance + Bybit (§5.1, §5.3). Intents table gains `chosen_strategy_id` + `chosen_strategy_name` + `chosen_strategy_json` columns; skill emits the id, host validates against the tick's cached strategies list and enriches name + full snapshot at persist time so postmortems survive ranking drift (§5.3, §5.5).
- **v0.5** — Doc-cleanup pass and last v1 trading decisions. `safety/guards` no longer references "MCP open_*_trade tools" (§4.1). Bybit leg in sample intent corrected to inverse `BTCUSD` with `contract_type: "inverse"`; Binance leg tagged `contract_type: "linear"` (§5.3). FTS5 comment updated to point at `GET /trades?q=` (§5.5). M2 phase reconciled with §1: both Binance and Bybit must paper-fill in M2 — three-leg is the v1 success bar (§9). Per-skill `budget`/`slots`/`margin_per_slot` declared in `runtime.yaml` and enforced by `safety/guards` for Senpi parity (§4.3, §11). Binance locked to linear `BTCUSDT` (§10.1, §13).
- **v0.4** — Two-layer architecture made explicit: autonomous python tick loop *plus* an HTTP API for Claude Code as operator (§1, §3, §4.1, §4.4). MCP rejected; plain HTTP wins for zero deps and Claude-Code-native `WebFetch`/`curl` use. API binds `127.0.0.1` by default with no auth; public binding requires `BIND_PUBLIC=YES` + `API_TOKEN` and refuses boot otherwise (§4.4, §8, §11). FTS5 virtual table on `intents.thesis` added for trade-rationale search via SQL only (§5.5). Sign-off updated (§13).
- **v0.3** — Bybit locked to inverse `BTCUSD` for v1 (intentional edit upstream, captured here). Vector store / embeddings recorded as explicit non-goal (§2). Sign-off checklist split per-CEX with Bybit marked resolved (§13).
- **v0.2** — Resolved 4 review issues: tick-overlap policy + timeout + late-reply discard (§4.1, §6, §11); Bybit included as a real third leg in v1 (§1, §5.3); `ticks` heartbeat table added so M1 has a real verification target (§5.5, §9); single-skill v1 hard rule replaces the implied guard-check race (§4.1, §8, §10.5, §11). Slot-lease design captured for v2 (§8). Sign-off checklist updated (§13).
- **v0.1** — Initial draft.
