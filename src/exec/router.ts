import { randomUUID } from "node:crypto";
import { log } from "../log.js";
import type { DB } from "../state/db.js";
import type { IntentLike, Leg, FillResult } from "./types.js";
import type { TwilightExec } from "./twilight.js";
import type { CexExec } from "./cex.js";

export interface ExecDeps {
  db: DB;
  twilight: TwilightExec;
  binance: CexExec;
  bybit: CexExec;
  midPrice(): Promise<number>;
}

export interface ExecResult {
  status: "filled" | "failed";
  fills: FillResult[];
  failed_leg_index?: number;
  unwind?: FillResult[];
  error?: string;
}

export class ExecRouter {
  constructor(private deps: ExecDeps) {}

  async fanOut(intent: IntentLike): Promise<ExecResult> {
    const fills: FillResult[] = [];
    const mid = await this.deps.midPrice();

    for (let i = 0; i < intent.legs.length; i++) {
      const leg = intent.legs[i]!;
      try {
        const fill = await this.openLeg(leg, mid);
        fills.push(fill);
        this.persistFill(intent.intent_id, fill);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        log.error("exec.leg_failed", { intent_id: intent.intent_id, leg_index: i, venue: leg.venue, error });
        const unwind = await this.unwind(fills, mid);
        return { status: "failed", fills, failed_leg_index: i, unwind, error };
      }
    }
    return { status: "filled", fills };
  }

  async closePositionFor(intent: IntentLike, account_index = 0): Promise<FillResult[]> {
    const mid = await this.deps.midPrice();
    const out: FillResult[] = [];
    for (const leg of intent.legs) {
      try {
        const f = await this.closeLeg(leg, mid, account_index);
        out.push(f);
        this.persistFill(intent.intent_id, f);
      } catch (e) {
        log.error("exec.close_failed", { intent_id: intent.intent_id, venue: leg.venue, err: String(e) });
      }
    }
    return out;
  }

  private openLeg(leg: Leg, mid: number): Promise<FillResult> {
    if (leg.venue === "twilight") return this.deps.twilight.open(leg, mid);
    if (leg.venue === "binance")  return this.deps.binance.open(leg, mid);
    return this.deps.bybit.open(leg, mid);
  }

  private async closeLeg(leg: Leg, mid: number, account_index: number): Promise<FillResult> {
    if (leg.venue === "twilight") return this.deps.twilight.close(account_index);
    const cex = leg.venue === "binance" ? this.deps.binance : this.deps.bybit;
    return cex.closeReduceOnly(leg.symbol, leg.side, leg.contract_type, leg.size_usd, mid);
  }

  private async unwind(fills: FillResult[], mid: number): Promise<FillResult[]> {
    const out: FillResult[] = [];
    for (const f of fills.slice().reverse()) {
      try {
        if (f.venue === "twilight") {
          out.push(await this.deps.twilight.close(0));
        } else {
          // closeReduceOnly needs the leg's contract metadata; fall back to assumed defaults.
          const cex = f.venue === "binance" ? this.deps.binance : this.deps.bybit;
          const symbol = f.venue === "binance" ? "BTCUSDT" : "BTCUSD";
          const ct: "linear" | "inverse" = f.venue === "binance" ? "linear" : "inverse";
          out.push(await cex.closeReduceOnly(symbol, f.side, ct, f.size, mid));
        }
      } catch (e) {
        log.error("exec.unwind_leg_failed", { venue: f.venue, err: String(e) });
      }
    }
    return out;
  }

  private persistFill(intent_id: string, f: FillResult): void {
    this.deps.db.prepare(
      `INSERT INTO fills(fill_id, intent_id, venue, side, size, price, fee, raw_json, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(), intent_id, f.venue, f.side, f.size, f.price, f.fee,
      JSON.stringify(f.raw), Date.now(),
    );
  }
}
