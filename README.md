# Twilight Tradebot

Two-layer trading runtime for Twilight inverse perps + Binance/Bybit hedge legs.

- **Autonomous loop**: Python skills tick every 10s, emit intents, runtime executes.
- **HTTP API on `127.0.0.1:8787`**: state queries, paper trades, kill-switch — for Claude Code or any HTTP client.

See [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) for the architecture and contracts.

## Quick start (local, paper mode)

```bash
cp .env.example .env
# edit .env — at minimum set NYKS_WALLET_ID + NYKS_WALLET_PASSPHRASE if you
# want the relayer-cli leg to attempt fills. Paper mode does not need keys.

npm install
npm run build
node dist/index.js
```

The runtime boots in `PAPER=1` mode by default. It refuses to boot if more than
one skill is enabled (see §8 in the plan).

## HTTP API

Bound to `127.0.0.1:${API_PORT:-8787}`. No auth in localhost mode.

```bash
curl http://127.0.0.1:8787/healthz
curl http://127.0.0.1:8787/strategies?profitable=true&limit=5
curl http://127.0.0.1:8787/market
curl http://127.0.0.1:8787/positions
curl -X POST http://127.0.0.1:8787/trades/paper \
  -H 'content-type: application/json' \
  -d '{"legs":[...],"exit_rules":[...]}'
```

For the full endpoint list see plan §4.4.

## Going live (paper → mainnet)

Two env vars and a per-call confirm flag, by design:

1. Run paper for at least 24h. Watch `GET /trades` and `GET /ticks?status=timeout`.
2. Provision the Twilight wallet: `relayer-cli wallet create`, register BTC deposit, fund a ZkOS account. (Plan §10.4.)
3. Set `PAPER=0` *and* `LIVE_TRADING_CONFIRMED=YES` on the container.
4. Tighten caps in `.env`: `MAX_NOTIONAL_USD_PER_INTENT=50`, `DAILY_LOSS_STOP_USD=25`.
5. Restart container. The autonomous loop will go live; HTTP `/trades/live` is also enabled but each request still requires `confirm_live: true`.
6. Kill switch: `touch /data/KILL_SWITCH` (or `PUT /kill-switch {on:true}`) halts new intents within one tick.

## Public API exposure (Railway)

Localhost-only by default. To expose:

```
BIND_PUBLIC=YES
API_TOKEN=<random-32-bytes>
```

The runtime refuses to boot if `BIND_PUBLIC=YES` is set without a token.

## Layout

```
src/                  TS host (orchestrator + HTTP API)
python/skill_sdk/     Python helper for skills (stdlib only)
skills/<name>/        scanner.py + runtime.yaml + SKILL.md
data/                 SQLite DB + KILL_SWITCH file (Railway volume)
```
