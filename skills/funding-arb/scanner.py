#!/usr/bin/env python3
"""funding-arb scanner — direction-aware funding capture.

Picks the profitable side based on twi_rate sign + matching CEX legs:

  twi_rate > 0  (longs pay shorts on twilight)  →  SHORT twi  +  LONG  cex (cex_rate < 0)
  twi_rate < 0  (shorts pay longs on twilight)  →  LONG  twi  +  SHORT cex (cex_rate > 0)

Funding rate convention: positive = longs pay shorts (Binance/Bybit/Twilight all align).
The hedge is delta-neutral: equal notional on opposite sides; funding income on both legs.

stop_loss_pct is auto-tightened for high leverage so stops fire before liquidation:
  liquidation ≈ 1/leverage, we want stop at ~60% of liquidation distance.
  20x → 3%, 10x → 6%, 5x → 12% (capped by env FUNDING_ARB_STOP_PCT).
"""
import os

from skill_sdk import (
    read_tick, write_intent, write_noop,
    build_intent, leg_twilight, leg_binance, leg_bybit,
)
from skill_sdk.dsl import standard_funding_arb_exits


SKILL = "funding-arb"
MIN_APY        = float(os.environ.get("FUNDING_ARB_MIN_APY", "50"))
NOTIONAL_USD   = float(os.environ.get("FUNDING_ARB_NOTIONAL_USD", "100"))
LEVERAGE       = int(os.environ.get("FUNDING_ARB_LEVERAGE", "5"))
STOP_PCT_ENV   = float(os.environ.get("FUNDING_ARB_STOP_PCT", "0.05"))
ACCOUNT_INDEX  = int(os.environ.get("FUNDING_ARB_TWILIGHT_ACCOUNT_INDEX", "0"))
# Per-venue minimum notional (USD). Binance Futures BTCUSDT requires
# ≥ 0.001 BTC per order — at $80k that's $80; at $50k it's $50, so we
# leave it overrideable via env. Bybit inverse uses 1-contract = $1 min.
BIN_MIN_USD    = float(os.environ.get("BINANCE_MIN_NOTIONAL_USD", "100"))
BYB_MIN_USD    = float(os.environ.get("BYBIT_MIN_NOTIONAL_USD",   "1"))
SAT_PER_BTC    = 100_000_000


def safe_stop_pct(leverage: int) -> float:
    """Stop must fire before liquidation. Liquidation ≈ 1/leverage; aim for 60% of that."""
    return max(0.015, min(STOP_PCT_ENV, 0.6 / max(leverage, 1)))


def hedge_split(bin_favor: float, byb_favor: float, notional_usd: float):
    """Weight CEX hedge by which venue has more favorable funding for our direction.
    bin_favor / byb_favor are the funding income magnitudes on the cex_side."""
    total = bin_favor + byb_favor
    if total == 0:
        return notional_usd / 2, notional_usd / 2
    bin_w = bin_favor / total
    bin_w = min(0.7, max(0.3, bin_w))
    return notional_usd * bin_w, notional_usd * (1 - bin_w)


def pick(strategies, twi_side):
    """Filter to strategies matching our intended twilight direction at sufficient APY."""
    cats = {"Funding Arb", "Delta-Neutral"}
    risks = {"LOW", "MEDIUM"}
    want = "SHORT" if twi_side == "short" else "LONG"
    eligible = [s for s in strategies
                if s.get("category") in cats
                and s.get("risk") in risks
                and (s.get("twilightPosition") == want)
                and (s.get("apy") or 0) >= MIN_APY]
    eligible.sort(key=lambda s: s.get("apy", 0), reverse=True)
    return eligible[0] if eligible else None


def main():
    for tick in read_tick():
        tid = tick["tick_id"]
        m = tick.get("market") or {}
        fr = (m.get("fundingRates") or {})
        twi_rate = ((fr.get("twilight") or {}).get("rate") or 0)
        bin_rate = ((fr.get("binance")  or {}).get("rate") or 0)
        byb_rate = ((fr.get("bybit")    or {}).get("rate") or 0)
        pool = (m.get("pool") or {})
        skew = pool.get("currentSkew") or 0
        twi_price = ((m.get("prices") or {}).get("twilight") or 0)

        # Direction selection: which side of twilight receives funding?
        if twi_rate > 0:
            twi_side, cex_side = "short", "long"
            # need at least one cex where long receives funding (rate < 0)
            bin_favor = max(0.0, -bin_rate)
            byb_favor = max(0.0, -byb_rate)
        elif twi_rate < 0:
            twi_side, cex_side = "long", "short"
            bin_favor = max(0.0, bin_rate)
            byb_favor = max(0.0, byb_rate)
        else:
            write_noop(tid, "twi rate is zero"); continue

        if bin_favor + byb_favor == 0:
            write_noop(tid, f"no cex hedge with favorable funding for {cex_side}"); continue

        # Skew-aware skip: only reject if our trade WORSENS pool imbalance.
        # twi_side=long  + already long-heavy (skew >= 0.85) → adds to imbalance, reject
        # twi_side=short + already short-heavy (skew <= 0.15) → adds to imbalance, reject
        if twi_side == "long" and skew >= 0.85:
            write_noop(tid, f"pool skew {skew:.2f} too long-heavy for adding longs"); continue
        if twi_side == "short" and skew <= 0.15:
            write_noop(tid, f"pool skew {skew:.2f} too short-heavy for adding shorts"); continue

        if tick.get("positions"):
            write_noop(tid, "already in position"); continue

        chosen = pick(tick.get("strategies") or [], twi_side)
        if chosen is None:
            write_noop(tid, f"no {twi_side}-twi strategy >= {MIN_APY}% apy"); continue

        bin_usd, byb_usd = hedge_split(bin_favor, byb_favor, NOTIONAL_USD)
        size_sats = int(NOTIONAL_USD / max(twi_price, 1) * SAT_PER_BTC)
        stop = safe_stop_pct(LEVERAGE)

        # Per-venue minimum-notional preflight. If the split would put either
        # cex leg under its venue minimum, redistribute the full hedge to the
        # viable venue. If neither venue can hold the full hedge, NOOP — we
        # refuse to open the twilight leg unhedged (that's exactly what bit us
        # last time when binance rejected with "amount < 0.001 BTC" and the
        # router was left holding a directional twilight short).
        bin_ok = bin_usd >= BIN_MIN_USD
        byb_ok = byb_usd >= BYB_MIN_USD
        bin_solo_ok = NOTIONAL_USD >= BIN_MIN_USD   # could route 100% to binance
        byb_solo_ok = NOTIONAL_USD >= BYB_MIN_USD   # could route 100% to bybit

        if bin_ok and byb_ok:
            bin_size, byb_size = bin_usd, byb_usd
        elif byb_solo_ok and not bin_solo_ok:
            bin_size, byb_size = 0.0, NOTIONAL_USD
        elif bin_solo_ok and not byb_solo_ok:
            bin_size, byb_size = NOTIONAL_USD, 0.0
        elif bin_solo_ok and byb_solo_ok:
            # Both can hold solo. Pick the venue with the bigger funding edge.
            if bin_favor >= byb_favor:
                bin_size, byb_size = NOTIONAL_USD, 0.0
            else:
                bin_size, byb_size = 0.0, NOTIONAL_USD
        else:
            write_noop(tid,
                f"hedge legs below venue mins (bin=${bin_usd:.2f} need≥${BIN_MIN_USD:.0f}, "
                f"byb=${byb_usd:.2f} need≥${BYB_MIN_USD:.0f}) — refusing to open twilight unhedged"); continue

        legs = [leg_twilight(twi_side, size_sats, LEVERAGE, stop_loss_pct=stop, account_index=ACCOUNT_INDEX)]
        if bin_size > 0:
            legs.append(leg_binance(cex_side, round(bin_size, 2), LEVERAGE, stop_loss_pct=stop))
        if byb_size > 0:
            legs.append(leg_bybit(cex_side, round(byb_size, 2), LEVERAGE, stop_loss_pct=stop))
        thesis = (f"twi {twi_rate*100:+.4f}% / bin {bin_rate*100:+.4f}% / byb {byb_rate*100:+.4f}% — "
                  f"{twi_side} twi + {cex_side} cex (split bin/byb {bin_size:.0f}/{byb_size:.0f}) "
                  f"@ {LEVERAGE}x lev, stop {stop*100:.1f}% "
                  f"(strategy #{chosen.get('id')} {chosen.get('name')} apy={chosen.get('apy'):.1f}%)")
        intent = build_intent(SKILL, tid, thesis, legs, standard_funding_arb_exits(),
                              chosen_strategy_id=chosen.get("id"))
        write_intent(intent)


if __name__ == "__main__":
    main()
