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
