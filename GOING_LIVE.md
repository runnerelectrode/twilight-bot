# Going live — mainnet runbook

Read this end-to-end before flipping any switch. Live mode trades real BTC.

## Pre-flight checklist

- [ ] Plan §10.4 wallet provisioning is **done**:
  - [ ] `relayer-cli wallet create` (mainnet wallet id + passphrase recorded in your password manager)
  - [ ] BTC deposit address registered: `relayer-cli wallet register-btc`
  - [ ] BTC sent to the registered reserve address; deposit confirmed on-chain
  - [ ] At least one ZkOS account funded: `relayer-cli zkaccount fund --amount <sats>`
  - [ ] `relayer-cli portfolio summary --json` shows the funded account in `Coin` state
- [ ] CEX accounts are mainnet, not testnet:
  - [ ] Binance Futures API key + secret (USDT-M permission, no withdraw)
  - [ ] Bybit API key + secret (Inverse perp permission, no withdraw)
  - [ ] At least `MIN_BALANCE_USD_PER_VENUE` deposited on each
- [ ] `MAX_NOTIONAL_USD_PER_INTENT=50` and `DAILY_LOSS_STOP_USD=25` for the first week. You can raise them later.
- [ ] Container ran in PAPER mode for **24h+** with no `status='timeout'` or `status='crashed'` rows in the `ticks` table for the active skill.
- [ ] Kill-switch tested: `touch /data/KILL_SWITCH` halted new intents within one tick, and removing the file resumed them.
- [ ] DSL `close_all` exit fired at least once in paper, closed all three legs, persisted realized PnL.

## The flip

Live mode requires **all of the following**:

1. `PAPER=0` — env var set on the container
2. `LIVE_TRADING_CONFIRMED=YES` — env var set on the container
3. (Public API only) `BIND_PUBLIC=YES` + `API_TOKEN=<random>` — env vars set on the container
4. Container restart so the new env takes effect

If any one of (1)/(2) is missing the runtime refuses to boot.
If `BIND_PUBLIC=YES` is set without `API_TOKEN`, the runtime refuses to boot.

The autonomous python loop will go live on the next tick.
HTTP `POST /trades/live` is also enabled but each request still requires `confirm_live: true` in the body.

## Day-1 monitoring

```bash
# tail the structured logs — bot is verbose by design
docker logs -f <container>

# heartbeat: any timeouts or overlaps in the last 5 minutes?
curl -s http://127.0.0.1:8787/ticks?since=$(($(date +%s%3N)-300000))&status=timeout

# every intent placed today
curl -s http://127.0.0.1:8787/trades?since=$(date -u +%s000 -d 'today 00:00')

# real fills + DSL decisions for an intent
curl -s http://127.0.0.1:8787/trades/<intent_id>

# kill switch
curl -X PUT http://127.0.0.1:8787/kill-switch -d '{"on":true}' -H 'content-type: application/json'
```

## Rolling back

Live → paper does **not** require a code change:

1. `touch /data/KILL_SWITCH` (or `PUT /kill-switch {on:true}`) — halts new intents immediately.
2. Wait for any open position to close (DSL or manual `POST /positions/:id/close`).
3. Set `PAPER=1`, restart container.

`LIVE_TRADING_CONFIRMED=YES` is a permission, not a directive. With `PAPER=1` it is a no-op.

## Cap-raising schedule

Suggested ramp once paper soak is clean:

| Day | `MAX_NOTIONAL_USD_PER_INTENT` | `MAX_LEVERAGE` | `DAILY_LOSS_STOP_USD` |
|---|---|---|---|
| 1–7   | 50  | 3 | 25  |
| 8–14  | 100 | 5 | 50  |
| 15+   | 200 | 5 | 100 |

Cap changes require an env update and a container restart. There's no in-runtime cap-edit endpoint that survives a restart by design — env-as-source-of-truth keeps "what the runtime is enforcing right now" trivially auditable.

## What v1 does NOT protect against

- Bad funding-rate data from the Strategy API. The bot trusts what `/api/market` says.
- `relayer-cli` install drift. The Dockerfile pins what gets installed at build time; verify after every `docker build`.
- A skill bug that emits the same intent every tick. Only the in-flight gate + single-skill rule + max-open-positions cap stop runaway repetition.
- CEX API outage during a partial fill. The unwind path tries reduce-only market closes; if those also fail, you have an open one-leg position and need to close it manually.

## Wallet hygiene

- Don't keep more sats in the funded ZkOS account than you're willing to lose this week.
- Rotate the relayer-cli wallet passphrase if it has ever been pasted into a chat, terminal history that's synced, or a screenshot.
- After every settled trade the account address is spent — `safety/guards` blocks the next intent until `relayer-cli zkaccount transfer` rotates it. Keep an eye on logs for `address-rotation precondition` rejections.
