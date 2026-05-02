/**
 * Pre-trade impact check.
 *
 * For each Twilight leg in an intent, calls POST /api/impact on the
 * strategy-api with the leg's notional and direction. If the resulting
 * post-trade pool state would put OUR position on the funding-paying side
 * (`youPay === true`), the intent is rejected.
 *
 * Catches the "self-defeating trade" failure mode where our own size is
 * large enough relative to the chain pool to flip funding against us.
 * Real example: opened a $80 short on a 4040/4040 BTC pool, tipped it to
 * 4040/106040 (96% short), funding flipped from +0.0022%/8h to −10.86%/8h
 * with us on the wrong side.
 */
import type { IntentLike } from "../exec/types.js";
import type { StrategyApi } from "../feeds/strategyApi.js";
import { log } from "../log.js";

interface ImpactResponse {
  source?: "chain" | "config";
  poolUsed?: { twilightLongSize: number; twilightShortSize: number };
  currentSkew?: number;
  longImpact?:  { newSkew: number; newFundingRate: number; annualizedAPY: number; youPay: boolean; youEarn: boolean };
  shortImpact?: { newSkew: number; newFundingRate: number; annualizedAPY: number; youPay: boolean; youEarn: boolean };
}

export interface ImpactDecision { ok: boolean; reason?: string; details?: unknown }

export class ImpactChecker {
  constructor(
    private apiBase: string,
    private apiKey: string,
  ) {}

  async check(intent: IntentLike, midPrice: number): Promise<ImpactDecision> {
    const twiLegs = intent.legs.filter(l => l.venue === "twilight");
    if (twiLegs.length === 0) return { ok: true };

    for (const leg of twiLegs) {
      if (leg.venue !== "twilight") continue;            // narrow type
      const notionalUsd = (leg.size_sats / 1e8) * midPrice;
      const direction = leg.side.toUpperCase();          // "LONG" | "SHORT"

      let resp: ImpactResponse;
      try {
        const r = await fetch(`${this.apiBase.replace(/\/$/, "")}/api/impact`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": this.apiKey },
          body: JSON.stringify({ tradeSize: Math.round(notionalUsd), direction }),
        });
        if (!r.ok) {
          // API down or transient. Soft-fail: allow trade but log loudly.
          // The on-chain hard stops still protect us against catastrophe.
          log.warn("impact_check.api_error", { status: r.status, leg_side: leg.side, notional_usd: notionalUsd });
          return { ok: true, details: { warning: `impact api ${r.status} — proceeding` } };
        }
        resp = await r.json() as ImpactResponse;
      } catch (e) {
        log.warn("impact_check.network_error", { error: String(e) });
        return { ok: true, details: { warning: `impact api network err — proceeding` } };
      }

      // Pick the impact side that matches our position direction.
      const sideImpact = direction === "LONG" ? resp.longImpact : resp.shortImpact;
      if (!sideImpact) {
        log.warn("impact_check.no_side_impact", { direction, resp });
        continue;
      }

      if (sideImpact.youPay) {
        const reason = `impact_youpay_${direction.toLowerCase()}_skew_${(sideImpact.newSkew ?? 0).toFixed(3)}_rate_${(sideImpact.newFundingRate ?? 0).toFixed(6)}`;
        log.warn("impact_check.reject", {
          leg_side: leg.side, notional_usd: notionalUsd,
          source: resp.source, current_skew: resp.currentSkew,
          new_skew: sideImpact.newSkew, new_funding_rate: sideImpact.newFundingRate,
          new_apy: sideImpact.annualizedAPY,
        });
        return { ok: false, reason, details: { leg, sideImpact, source: resp.source } };
      }

      log.info("impact_check.ok", {
        leg_side: leg.side, notional_usd: notionalUsd,
        new_skew: sideImpact.newSkew, new_funding_rate: sideImpact.newFundingRate,
        new_apy: sideImpact.annualizedAPY,
      });
    }
    return { ok: true };
  }
}

/** Tiny helper for the strategy-api base + key shape. */
export function makeImpactChecker(strategyApi: StrategyApi, apiKey: string): ImpactChecker {
  // StrategyApi keeps its base url private; reconstruct from env to keep this loose.
  const base = process.env.STRATEGY_API_BASE || "http://127.0.0.1:3000";
  return new ImpactChecker(base, apiKey);
  void strategyApi;
}
