import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DB } from "../state/db.js";
import type { IntentLike, Leg } from "../exec/types.js";
import type { SkillConfig } from "../pluginLoader.js";

export interface GuardEnv {
  paper: boolean;
  liveConfirmed: boolean;
  dataDir: string;
  maxNotionalUsdPerIntent: number;
  maxOpenPositions: number;
  maxLeverage: number;
  dailyLossStopUsd: number;
  minBalancePerVenueUsd: number;
}

export interface GuardCtx {
  midPrice: number;
  binanceBalanceUsd: number;
  bybitBalanceUsd: number;
}

export interface GuardDecision {
  ok: boolean;
  reason?: string;
}

export class Guards {
  constructor(private db: DB, private env: GuardEnv, private skill: SkillConfig) {}

  /** Returns the kill-switch state without making any decision. */
  killSwitch(): boolean { return existsSync(join(this.env.dataDir, "KILL_SWITCH")); }

  /** Pre-flight every intent. Returns ok=true or {ok:false, reason}. */
  check(intent: IntentLike, ctx: GuardCtx, opts: { live: boolean; confirmLive?: boolean }): GuardDecision {
    if (this.killSwitch()) return { ok: false, reason: "kill_switch_active" };

    if (opts.live) {
      if (this.env.paper) return { ok: false, reason: "paper_mode_active" };
      if (!this.env.liveConfirmed) return { ok: false, reason: "live_trading_not_confirmed" };
      if (opts.confirmLive !== true) return { ok: false, reason: "confirm_live_required" };
    }

    if (intent.legs.some(l => l.leverage > this.env.maxLeverage)) {
      return { ok: false, reason: `leverage_exceeds_${this.env.maxLeverage}` };
    }

    const notional = this.notionalUsd(intent.legs, ctx.midPrice);
    if (notional > this.env.maxNotionalUsdPerIntent) {
      return { ok: false, reason: `notional_${notional.toFixed(0)}_exceeds_${this.env.maxNotionalUsdPerIntent}` };
    }

    const open = this.db.prepare(
      `SELECT COUNT(*) AS n FROM positions WHERE closed_at IS NULL`
    ).get() as { n: number };
    if (open.n >= this.env.maxOpenPositions) {
      return { ok: false, reason: `max_open_positions_${this.env.maxOpenPositions}_reached` };
    }

    if (this.skill.budget > 0) {
      const skillOpen = this.db.prepare(
        `SELECT COALESCE(SUM(size), 0) AS s FROM positions
         WHERE closed_at IS NULL AND intent_id IN (SELECT intent_id FROM intents WHERE skill = ?)`
      ).get(this.skill.name) as { s: number };
      if (skillOpen.s + notional > this.skill.budget) {
        return { ok: false, reason: `skill_budget_exceeded_${this.skill.name}` };
      }
      if (this.skill.margin_per_slot > 0) {
        const maxLev = Math.max(...intent.legs.map(l => l.leverage));
        if (maxLev > 0 && notional / maxLev > this.skill.margin_per_slot * 1.1) {
          return { ok: false, reason: `margin_per_slot_exceeded` };
        }
      }
    }

    if (this.env.minBalancePerVenueUsd > 0) {
      if (intent.legs.some(l => l.venue === "binance") && ctx.binanceBalanceUsd < this.env.minBalancePerVenueUsd) {
        return { ok: false, reason: "binance_balance_below_min" };
      }
      if (intent.legs.some(l => l.venue === "bybit") && ctx.bybitBalanceUsd < this.env.minBalancePerVenueUsd) {
        return { ok: false, reason: "bybit_balance_below_min" };
      }
    }

    if (this.env.dailyLossStopUsd > 0) {
      const since = startOfUtcDayMs();
      const realized = this.db.prepare(
        `SELECT COALESCE(SUM(realized_pnl), 0) AS p FROM positions WHERE closed_at >= ?`
      ).get(since) as { p: number };
      if (realized.p <= -this.env.dailyLossStopUsd) {
        return { ok: false, reason: `daily_loss_stop_${this.env.dailyLossStopUsd}_hit` };
      }
    }

    // Per-skill cooldown: block re-entry within N minutes of any prior intent
    // for this skill (open or closed). Senpi-inspired (Scorpion v4.1
    // per_asset_cooldown_minutes: 120). Default 120 min via runtime.yaml.
    if (this.skill.cooldown_minutes > 0) {
      const since = Date.now() - this.skill.cooldown_minutes * 60_000;
      const recent = this.db.prepare(
        `SELECT MAX(ts) AS ts FROM intents WHERE skill = ? AND status IN ('approved','filled','closed') AND ts >= ?`
      ).get(this.skill.name, since) as { ts: number | null };
      if (recent.ts) {
        const minsSince = Math.round((Date.now() - recent.ts) / 60_000);
        return { ok: false, reason: `cooldown_${this.skill.cooldown_minutes}min_active_last_intent_${minsSince}min_ago` };
      }
    }

    return { ok: true };
  }

  private notionalUsd(legs: Leg[], mid: number): number {
    let total = 0;
    for (const l of legs) {
      if (l.venue === "twilight") total += (l.size_sats / 1e8) * mid;
      else                        total += l.size_usd;
    }
    return total;
  }
}

function startOfUtcDayMs(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
