"""Helpers for constructing exit-rule objects matching the v1 grammar (plan §5.4)."""
from __future__ import annotations
from typing import Any


def rule(if_expr: str, do: str) -> dict[str, str]:
    return {"if": if_expr, "do": do}


def close_all() -> str:
    return "close_all"


def close_leg(venue: str) -> str:
    return f"close_leg:{venue}"


def standard_funding_arb_exits() -> list[dict[str, Any]]:
    return [
        # Funding flips against us (lost the edge)
        rule("funding_rates.twilight.rate < funding_rates.binance.rate and "
             "funding_rates.twilight.rate < funding_rates.bybit.rate", close_all()),
        # Senpi-inspired Phase-2 tiered ratchet: exit when pnl drops below the
        # locked floor (ratchets up as HWM crosses tiers — see dsl/engine.ts
        # lockedFloorForHwm). Replaces the flat +50% take-profit which would
        # exit at first cross instead of riding tiers.
        rule("pnl.unrealized_pct < pnl.locked_floor_pct", close_all()),
        # Hard stop loss (independent of ratchet)
        rule("pnl.unrealized_pct <= -0.3", close_all()),
        # Time stop (don't hold positions across funding regime changes)
        rule("time_in_position_hours >= 8", close_all()),
        # Pool risk: extreme skew = our short side becomes vulnerable
        rule("pool.skew_pct >= 0.85", close_all()),
    ]
