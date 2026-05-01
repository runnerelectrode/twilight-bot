"""Intent / leg builders. Skills should prefer these over hand-rolled JSON
to stay aligned with the contract in plan §5.3.
"""
from __future__ import annotations
import uuid
from typing import Any


def leg_twilight(side: str, size_sats: int, leverage: int,
                 order_type: str = "MARKET", max_slippage_bps: int = 50,
                 account_index: int = 0, stop_loss_pct: float | None = 0.10) -> dict[str, Any]:
    leg = {
        "venue": "twilight",
        "side": side,
        "size_sats": size_sats,
        "leverage": leverage,
        "order_type": order_type,
        "max_slippage_bps": max_slippage_bps,
        "account_index": account_index,
    }
    if stop_loss_pct is not None and stop_loss_pct > 0:
        leg["stop_loss_pct"] = stop_loss_pct
    return leg


def leg_binance(side: str, size_usd: float, leverage: int,
                order_type: str = "MARKET",
                post_only: bool = False, reduce_only: bool = False,
                stop_loss_pct: float | None = 0.10) -> dict[str, Any]:
    leg = {
        "venue": "binance",
        "symbol": "BTCUSDT",
        "contract_type": "linear",
        "side": side,
        "size_usd": size_usd,
        "leverage": leverage,
        "order_type": order_type,
        "post_only": post_only,
        "reduce_only": reduce_only,
    }
    if stop_loss_pct is not None and stop_loss_pct > 0:
        leg["stop_loss_pct"] = stop_loss_pct
    return leg


def leg_bybit(side: str, size_usd: float, leverage: int,
              order_type: str = "MARKET",
              post_only: bool = False, reduce_only: bool = False,
              stop_loss_pct: float | None = 0.10) -> dict[str, Any]:
    leg = {
        "venue": "bybit",
        "symbol": "BTCUSD",
        "contract_type": "inverse",
        "side": side,
        "size_usd": size_usd,
        "leverage": leverage,
        "order_type": order_type,
        "post_only": post_only,
        "reduce_only": reduce_only,
    }
    if stop_loss_pct is not None and stop_loss_pct > 0:
        leg["stop_loss_pct"] = stop_loss_pct
    return leg


def build_intent(skill: str, tick_id: str, thesis: str,
                 legs: list[dict[str, Any]], exit_rules: list[dict[str, Any]],
                 chosen_strategy_id: int | None = None,
                 intent_id: str | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {
        "type": "intent",
        "intent_id": intent_id or str(uuid.uuid4()),
        "tick_id": tick_id,
        "skill": skill,
        "thesis": thesis,
        "legs": legs,
        "exit": {"rules": exit_rules},
    }
    if chosen_strategy_id is not None:
        out["chosen_strategy_id"] = chosen_strategy_id
    return out
