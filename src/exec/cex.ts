import ccxt, { type Exchange } from "ccxt";
import { log } from "../log.js";
import type { CexLeg, FillResult } from "./types.js";

export interface CexEnv {
  paper: boolean;
  testnet: boolean;
  apiKey?: string;
  apiSecret?: string;
}

export class CexExec {
  private client: Exchange;

  constructor(public readonly venue: "binance" | "bybit", private env: CexEnv) {
    const opts = {
      apiKey:    env.apiKey ?? "",
      secret:    env.apiSecret ?? "",
      enableRateLimit: true,
      options: { defaultType: "swap" },
    };
    if (venue === "binance") {
      this.client = new ccxt.binance(opts);
      if (env.testnet) (this.client as unknown as { setSandboxMode: (v: boolean) => void }).setSandboxMode(true);
    } else {
      this.client = new ccxt.bybit(opts);
      if (env.testnet) (this.client as unknown as { setSandboxMode: (v: boolean) => void }).setSandboxMode(true);
    }
  }

  async open(leg: CexLeg, mid_price: number): Promise<FillResult> {
    if (this.env.paper) {
      return {
        venue: this.venue, side: leg.side,
        size: leg.size_usd, price: mid_price, fee: 0,
        raw: { paper: true, leg },
      };
    }
    if (!this.env.apiKey || !this.env.apiSecret) {
      throw new Error(`${this.venue} live: api keys not set`);
    }
    try {
      await this.client.setLeverage(leg.leverage, leg.symbol);
    } catch (e) {
      log.warn("cex.setLeverage_warn", { venue: this.venue, symbol: leg.symbol, err: String(e) });
    }
    const ccxtSide = leg.side === "long" ? "buy" : "sell";
    const ccxtType = leg.order_type === "MARKET" ? "market" : "limit";
    const amount = leg.contract_type === "inverse"
      ? Math.max(1, Math.round(leg.size_usd))      // Bybit inverse: 1 contract = $1
      : leg.size_usd / mid_price;                  // Binance USDT-M: amount in BTC
    const order = await this.client.createOrder(
      leg.symbol, ccxtType, ccxtSide, amount, undefined,
      { reduceOnly: leg.reduce_only ?? false, postOnly: leg.post_only ?? false },
    );
    const filled = Number(order.filled ?? amount);
    const avg    = Number(order.average ?? order.price ?? mid_price);
    return {
      venue: this.venue, side: leg.side,
      size: leg.contract_type === "inverse" ? filled : filled * avg,
      price: avg, fee: Number((order.fee as { cost?: number } | undefined)?.cost ?? 0),
      raw: order,
    };
  }

  async closeReduceOnly(symbol: string, side: "long" | "short", contract_type: "linear" | "inverse", size_usd: number, mid_price: number): Promise<FillResult> {
    if (this.env.paper) {
      return { venue: this.venue, side, size: size_usd, price: mid_price, fee: 0, raw: { paper: true, close: true } };
    }
    const ccxtSide = side === "long" ? "sell" : "buy";
    const amount = contract_type === "inverse"
      ? Math.max(1, Math.round(size_usd))
      : size_usd / mid_price;
    const order = await this.client.createOrder(symbol, "market", ccxtSide, amount, undefined, { reduceOnly: true });
    const filled = Number(order.filled ?? amount);
    const avg    = Number(order.average ?? order.price ?? mid_price);
    return {
      venue: this.venue, side,
      size: contract_type === "inverse" ? filled : filled * avg,
      price: avg, fee: Number((order.fee as { cost?: number } | undefined)?.cost ?? 0),
      raw: order,
    };
  }

  async fetchPositions(): Promise<unknown[]> {
    if (this.env.paper) return [];
    if (!this.env.apiKey || !this.env.apiSecret) return [];
    return this.client.fetchPositions();
  }

  async fetchBalanceUsd(midPriceUsd?: number): Promise<number> {
    if (this.env.paper) return 1000;
    if (!this.env.apiKey || !this.env.apiSecret) return 0;
    const bal = await this.client.fetchBalance();
    const totals = (bal.total ?? {}) as unknown as Record<string, number>;
    // Linear/USDT-margined: balance is in USDT.
    // Inverse-margined (Bybit BTCUSD): balance is in BTC; convert via mid price.
    const usdt = Number(totals["USDT"] ?? totals["USD"] ?? 0);
    const btc  = Number(totals["BTC"] ?? 0);
    const btcInUsd = btc > 0 && midPriceUsd && midPriceUsd > 0 ? btc * midPriceUsd : 0;
    return usdt + btcInUsd;
  }
}
