import type { TwilightExec } from "../exec/twilight.js";
import type { CexExec } from "../exec/cex.js";

export interface ReconciledPosition {
  id: string;
  venue: "twilight" | "binance" | "bybit";
  side: "long" | "short";
  size: number;
  entry_price: number;
  mark_price?: number;
  leverage: number;
  unrealized_pnl?: number;
  raw?: unknown;
}

interface CcxtPositionShape {
  symbol?: string;
  side?: "long" | "short";
  contracts?: number;
  contractSize?: number;
  entryPrice?: number;
  markPrice?: number;
  leverage?: number;
  unrealizedPnl?: number;
  notional?: number;
}

export class PositionTracker {
  constructor(private twilight: TwilightExec, private binance: CexExec, private bybit: CexExec) {}

  async all(): Promise<ReconciledPosition[]> {
    const [twi, bin, byb] = await Promise.all([
      this.twilight.portfolioSummary().catch(() => ({})),
      this.binance.fetchPositions().catch(() => []),
      this.bybit.fetchPositions().catch(() => []),
    ]);
    return [
      ...this.normalizeTwilight(twi),
      ...this.normalizeCex("binance", bin as unknown[]),
      ...this.normalizeCex("bybit",   byb as unknown[]),
    ];
  }

  private normalizeTwilight(raw: unknown): ReconciledPosition[] {
    if (!raw || typeof raw !== "object") return [];
    // relayer-cli portfolio summary returns `trader_positions` (not `positions` or `trades`).
    const r = raw as { trader_positions?: unknown[]; positions?: unknown[]; trades?: unknown[] };
    const list = (r.trader_positions ?? r.positions ?? r.trades ?? []) as Array<Record<string, unknown>>;
    return list.map((p, i) => {
      // Twilight relayer uses `position_type` ("LONG"/"SHORT"), not `side`.
      const sideRaw = String(p["position_type"] ?? p["side"] ?? "").toUpperCase();
      const side: "long" | "short" = sideRaw === "SHORT" ? "short" : "long";
      // `position_size` is the leveraged notional in sats (e.g. 8003430000 for
      // ~80 USD). `initial_margin` is the un-leveraged margin in sats.
      const positionSize = Number(p["position_size"] ?? p["size_sats"] ?? p["size"] ?? 0);
      return {
        id: `twi_${(p["account_index"] ?? i)}`,
        venue: "twilight" as const,
        side,
        size: positionSize,
        entry_price: Number(p["entry_price"] ?? 0),
        mark_price: Number(p["current_price"] ?? p["mark_price"] ?? p["entry_price"] ?? 0),
        leverage: Number(p["leverage"] ?? 1),
        unrealized_pnl: Number(p["unrealized_pnl"] ?? 0),
        raw: p,
      };
    });
  }

  private normalizeCex(venue: "binance" | "bybit", raw: unknown[]): ReconciledPosition[] {
    return raw
      .filter((p): p is CcxtPositionShape =>
        typeof p === "object" && p !== null && Number((p as CcxtPositionShape).contracts ?? 0) !== 0,
      )
      .map((p, i) => ({
        id: `${venue}_${p.symbol ?? i}`,
        venue,
        side: p.side ?? "long",
        size: Number(p.notional ?? (p.contracts ?? 0) * (p.contractSize ?? 1)),
        entry_price: Number(p.entryPrice ?? 0),
        mark_price: Number(p.markPrice ?? p.entryPrice ?? 0),
        leverage: Number(p.leverage ?? 1),
        unrealized_pnl: Number(p.unrealizedPnl ?? 0),
        raw: p,
      }));
  }
}
