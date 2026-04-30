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
        rule("funding_rates.twilight.rate < funding_rates.binance.rate and "
             "funding_rates.twilight.rate < funding_rates.bybit.rate", close_all()),
        rule("pnl.unrealized_pct >= 0.5", close_all()),
        rule("pnl.unrealized_pct <= -0.3", close_all()),
        rule("time_in_position_hours >= 8", close_all()),
        rule("pool.skew_pct >= 0.85", close_all()),
    ]
