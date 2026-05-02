import ccxt, { type Exchange, type Order } from "ccxt";
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

  /** Attach a hard SL order at the venue. Closes the position when mark price hits stop_price.
   *  Returns ok:false on failure but does NOT throw — caller decides whether to unwind. */
  async attachStop(leg: CexLeg, entry_price: number, stop_loss_pct: number): Promise<{ ok: boolean; stop_price: number; raw?: unknown; error?: string }> {
    if (this.env.paper) {
      return { ok: true, stop_price: leg.side === "long" ? entry_price * (1 - stop_loss_pct) : entry_price * (1 + stop_loss_pct), raw: { paper: true } };
    }
    if (!this.env.apiKey || !this.env.apiSecret) {
      return { ok: false, stop_price: 0, error: "api keys not set" };
    }
    const stop_price = leg.side === "long"
      ? entry_price * (1 - stop_loss_pct)
      : entry_price * (1 + stop_loss_pct);
    const ccxtSide = leg.side === "long" ? "sell" : "buy"; // close direction
    try {
      let order: unknown;
      const amount = leg.contract_type === "inverse"
        ? Math.max(1, Math.round(leg.size_usd))
        : leg.size_usd / entry_price;
      // ccxt's OrderType union doesn't include venue-specific stop types like
      // STOP_MARKET (Binance) — we cast to bypass the union since the runtime
      // accepts these via the venue-extended createOrder.
      type OT = "market" | "limit" | "STOP_MARKET";
      if (this.venue === "binance") {
        order = await this.client.createOrder(
          leg.symbol, "STOP_MARKET" as OT, ccxtSide, amount, undefined,
          {
            stopPrice: this.client.priceToPrecision(leg.symbol, stop_price),
            closePosition: true,
            workingType: "MARK_PRICE",
            reduceOnly: true,
          },
        );
      } else {
        // Bybit: stop-loss order with triggerPrice + triggerDirection
        // triggerDirection: 1 = price moves UP through trigger, 2 = price moves DOWN through trigger
        const triggerDirection = leg.side === "long" ? 2 : 1;
        order = await this.client.createOrder(
          leg.symbol, "market" as OT, ccxtSide, amount, undefined,
          {
            triggerPrice: this.client.priceToPrecision(leg.symbol, stop_price),
            triggerDirection,
            reduceOnly: true,
            orderFilter: "StopOrder",
          },
        );
      }
      return { ok: true, stop_price, raw: order };
    } catch (e) {
      return { ok: false, stop_price, error: e instanceof Error ? e.message : String(e) };
    }
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

  /** Senpi-inspired FEE_OPTIMIZED_LIMIT close: maker-first limit slightly
   *  inside the spread, poll up to 60s, cancel + market-fallback if unfilled.
   *  Saves ~0.05% × notional × 2 round-trip on Bybit/Binance vs taker-always.
   *  Use for take-profit / time-stop closes where speed isn't critical;
   *  stays on closeReduceOnly for stop-loss closes where speed > fee.
   */
  async closeOptimized(symbol: string, side: "long" | "short", contract_type: "linear" | "inverse", size_usd: number, mid_price: number): Promise<FillResult> {
    if (this.env.paper) {
      return { venue: this.venue, side, size: size_usd, price: mid_price, fee: 0, raw: { paper: true, close: true, mode: "optimized" } };
    }
    const ccxtSide = side === "long" ? "sell" : "buy";
    const amount = contract_type === "inverse"
      ? Math.max(1, Math.round(size_usd))
      : size_usd / mid_price;

    // Place limit ~5 bps inside the spread on the side that closes us:
    //   closing a long → sell at mid + 5bps (maker on the ask)
    //   closing a short → buy at mid - 5bps (maker on the bid)
    const offsetBps = 5;
    const limitPrice = side === "long"
      ? mid_price * (1 + offsetBps / 10000)
      : mid_price * (1 - offsetBps / 10000);
    const priceStr = this.client.priceToPrecision(symbol, limitPrice);

    let limitOrder: Order;
    try {
      limitOrder = await this.client.createOrder(
        symbol, "limit", ccxtSide, amount, Number(priceStr),
        { reduceOnly: true, postOnly: true },
      );
    } catch (e) {
      // Maker-only rejection or other err — fall straight to market.
      log.warn("cex.closeOptimized.limit_reject_market_fallback", { venue: this.venue, err: String(e) });
      return this.closeReduceOnly(symbol, side, contract_type, size_usd, mid_price);
    }

    // Poll up to 60s for the limit to fill.
    const deadline = Date.now() + 60_000;
    let last: Order = limitOrder;
    while (Date.now() < deadline) {
      await new Promise(res => setTimeout(res, 3_000));
      try {
        last = await this.client.fetchOrder(limitOrder.id, symbol);
      } catch (e) {
        log.warn("cex.closeOptimized.fetchOrder_err", { venue: this.venue, err: String(e) });
      }
      if (last.status === "closed" || Number(last.filled) >= amount) break;
    }

    if (last.status !== "closed") {
      // Cancel, market-fallback for the unfilled remainder.
      try { await this.client.cancelOrder(limitOrder.id, symbol); } catch (e) {
        log.warn("cex.closeOptimized.cancel_err", { venue: this.venue, err: String(e) });
      }
      const partFilled = Number(last.filled ?? 0);
      const remaining = Math.max(amount - partFilled, contract_type === "inverse" ? 1 : amount * 0.001);
      log.info("cex.closeOptimized.market_fallback", { venue: this.venue, filled: partFilled, remaining });
      const market = await this.client.createOrder(symbol, "market", ccxtSide, remaining, undefined, { reduceOnly: true });
      // Combine fills for accounting (best-effort; only the market leg's avg is honest)
      const filled = Number(market.filled ?? remaining) + partFilled;
      const avg = Number(market.average ?? market.price ?? mid_price);
      return {
        venue: this.venue, side,
        size: contract_type === "inverse" ? filled : filled * avg,
        price: avg, fee: Number((market.fee as { cost?: number } | undefined)?.cost ?? 0),
        raw: { mode: "optimized_market_fallback", limit: last, market },
      };
    }

    const filled = Number(last.filled ?? amount);
    const avg = Number(last.average ?? last.price ?? Number(priceStr));
    return {
      venue: this.venue, side,
      size: contract_type === "inverse" ? filled : filled * avg,
      price: avg, fee: Number((last.fee as { cost?: number } | undefined)?.cost ?? 0),
      raw: { mode: "optimized_filled", order: last },
    };
  }

  async fetchPositions(): Promise<unknown[]> {
    if (this.env.paper) return [];
    if (!this.env.apiKey || !this.env.apiSecret) return [];
    // Bybit inverse requires an explicit symbol filter; without one, fetchPositions
    // returns empty even with open positions. Pass the symbols we trade on.
    const symbols = this.venue === "bybit" ? ["BTC/USD:BTC"] : ["BTC/USDT:USDT"];
    return this.client.fetchPositions(symbols);
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
