export type Venue = "twilight" | "binance" | "bybit";
export type Side = "long" | "short";
export type ContractType = "linear" | "inverse";
export type OrderType = "MARKET" | "LIMIT";

export interface TwilightLeg {
  venue: "twilight";
  side: Side;
  size_sats: number;
  leverage: number;
  order_type: OrderType;
  max_slippage_bps?: number;
  /** Which ZkOS account to open this trade on. Default 0. */
  account_index?: number;
  /** Hard stop: adverse price move fraction at which the venue auto-closes.
   *  At 3x leverage, 0.10 means the venue closes when BTC moves 10% the wrong
   *  way ≈ 30% margin loss. Omit to skip the venue-side hard stop (DSL only). */
  stop_loss_pct?: number;
}

export interface CexLeg {
  venue: "binance" | "bybit";
  symbol: string;
  contract_type: ContractType;
  side: Side;
  size_usd: number;
  leverage: number;
  order_type: OrderType;
  post_only?: boolean;
  reduce_only?: boolean;
  /** Same semantics as TwilightLeg.stop_loss_pct — hard exchange-side stop. */
  stop_loss_pct?: number;
}

export type Leg = TwilightLeg | CexLeg;

export interface IntentLike {
  intent_id: string;
  skill: string;
  thesis?: string;
  legs: Leg[];
  exit?: { rules: { if: string; do: string }[] };
  chosen_strategy_id?: number;
}

export interface FillResult {
  venue: Venue;
  side: Side;
  size: number;
  price: number;
  fee: number;
  raw: unknown;
}
