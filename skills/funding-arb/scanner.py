#!/usr/bin/env python3
"""funding-arb scanner — long Twilight + split CEX hedge across Binance + Bybit."""
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
SAT_PER_BTC    = 100_000_000


def hedge_split(binance_rate: float, bybit_rate: float, notional_usd: float):
    """Weight CEX hedge by |funding|, capped at 70/30."""
    bin_neg = max(0.0, -binance_rate)
    byb_neg = max(0.0, -bybit_rate)
    total = bin_neg + byb_neg
    if total == 0:
        return notional_usd / 2, notional_usd / 2
    bin_w = bin_neg / total
    bin_w = min(0.7, max(0.3, bin_w))
    return notional_usd * bin_w, notional_usd * (1 - bin_w)


def pick(strategies):
    cats = {"Funding Arb", "Delta-Neutral"}
    risks = {"LOW", "MEDIUM"}
    eligible = [s for s in strategies
                if s.get("category") in cats
                and s.get("risk") in risks
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

        if not (twi_rate > 0 and (bin_rate < 0 or byb_rate < 0)):
            write_noop(tid, "no funding edge"); continue
        if skew >= 0.85:
            write_noop(tid, f"pool skew {skew:.2f} too long-heavy"); continue
        if tick.get("positions"):
            write_noop(tid, "already in position"); continue

        chosen = pick(tick.get("strategies") or [])
        if chosen is None:
            write_noop(tid, f"no strategy >= {MIN_APY}% apy"); continue

        bin_usd, byb_usd = hedge_split(bin_rate, byb_rate, NOTIONAL_USD)
        size_sats = int(NOTIONAL_USD / max(twi_price, 1) * SAT_PER_BTC)

        legs = [
            leg_twilight("long",  size_sats, LEVERAGE),
            leg_binance ("short", round(bin_usd, 2), LEVERAGE),
            leg_bybit   ("short", round(byb_usd, 2), LEVERAGE),
        ]
        thesis = (f"twi {twi_rate*100:.4f}% vs bin {bin_rate*100:.4f}% / byb {byb_rate*100:.4f}% — "
                  f"long twi, hedge split bin/byb {bin_usd:.0f}/{byb_usd:.0f} usd "
                  f"(strategy id={chosen.get('id')} apy={chosen.get('apy')})")
        intent = build_intent(SKILL, tid, thesis, legs, standard_funding_arb_exits(),
                              chosen_strategy_id=chosen.get("id"))
        write_intent(intent)


if __name__ == "__main__":
    main()
