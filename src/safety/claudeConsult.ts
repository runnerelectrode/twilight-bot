/**
 * Claude consultation gate: a third safety layer between impact check and exec.
 *
 * Sends the proposed intent + market context + impact analysis to Claude
 * (via the Agent SDK using OAuth subscription auth — no API key needed
 * if `claude login` was run on this host). Claude returns a JSON
 * { approve, reason, confidence } and the bot proceeds or skips.
 *
 * Per user policy: any error (timeout, parse failure, unreachable, etc.)
 * results in `approve: false` — the bot waits for next cycle rather than
 * fall through. Belt and braces > belt without braces.
 */
import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { IntentLike } from "../exec/types.js";
import { log } from "../log.js";
import type { DB } from "../state/db.js";

export interface ConsultDecision {
  approve: boolean;
  reason: string;
  confidence?: "low" | "medium" | "high";
  raw?: string;
  error?: string;
}

export interface ConsultContext {
  intent: IntentLike;
  midPrice: number;
  impact: unknown;          // /api/impact response shape
  market: unknown;          // /api/market snapshot
  recentDecisions?: { ts: number; approve: boolean; reason: string }[];
  /** Recently-open or recently-closed intents for duplicate detection. */
  recentTrades?: { ts: number; legs_summary: string; status: string; mins_ago: number }[];
}

const CONFIDENCE_RANK: Record<string, number> = { low: 1, medium: 2, high: 3 };

const SYSTEM_PROMPT = `You are a trade-approval gate for an autonomous funding-arb bot trading on Twilight (zkOS inverse perp), Binance USDT-M futures, and Bybit BTC inverse perp.

Your job: review one proposed multi-leg intent and return a JSON decision:
{"approve": true|false, "reason": "short explanation", "confidence": "low"|"medium"|"high"}

REJECT by default if any are true:
- impact.shortImpact.youPay or impact.longImpact.youPay (for the matching leg direction) is true → trade would tip funding against the bot
- impact.source is missing or impact data is "config" (not "chain") — the impact analysis is using stale poolConfig instead of live chain pool
- Any leg has leverage > 5x
- The trade would push concurrent open positions > 4
- The implied funding income < $0.10/day
- Anything looks structurally wrong (mismatched sizes, missing fields, suspicious values)
- DUPLICATE / NEAR-DUPLICATE: a recent-trades entry has overlapping legs (same venue + side + similar size) within the last 4h. This catches the "scanner re-fires the same signal" failure mode.

CONFIDENCE calibration:
- "high" — all hard-skip rules pass cleanly AND impact.source=chain AND funding income > $1/day AND no recent duplicates
- "medium" — passes rules but at least one marginal signal (e.g., funding income $0.10–$1/day, or impact source unclear)
- "low" — passes the hard rules but you have material uncertainty (data quality, edge case in pool state, etc.). The runtime will reject "low" by default.

APPROVE only when conditions are clearly favorable. The bot has hard exchange-side stops at 10% adverse + DSL exits as a backstop, but a wrong "approve" still costs real money. A "reject" only delays — the bot re-evaluates next tick. Bias toward reject when uncertain.

Return ONLY the JSON object. No prose, no code fences, no markdown.`;

const DEFAULT_MODEL = process.env.CLAUDE_CONSULT_MODEL || "claude-opus-4-7";
const DEFAULT_TIMEOUT_MS = Number(process.env.CLAUDE_CONSULT_TIMEOUT_MS || 20_000);
const DEFAULT_MIN_CONFIDENCE = (process.env.CLAUDE_CONSULT_MIN_CONFIDENCE || "medium").toLowerCase();

export class ClaudeConsult {
  constructor(
    private db: DB | null = null,
    private model: string = DEFAULT_MODEL,
    private timeoutMs: number = DEFAULT_TIMEOUT_MS,
    private minConfidence: string = DEFAULT_MIN_CONFIDENCE,
  ) {}

  async ask(ctx: ConsultContext): Promise<ConsultDecision> {
    const userPrompt = this.buildPrompt(ctx);
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeoutMs);
    let text = "";
    let decision: ConsultDecision;
    try {
      const result = query({
        prompt: userPrompt,
        options: {
          model: this.model,
          systemPrompt: SYSTEM_PROMPT,
          maxTurns: 1,
          abortController: ac,
        },
      });
      for await (const msg of result as AsyncIterable<unknown>) {
        const m = msg as { type?: string; message?: { content?: Array<{ type?: string; text?: string }> } };
        if (m.type === "assistant" && m.message?.content) {
          for (const block of m.message.content) {
            if (block.type === "text" && typeof block.text === "string") {
              text += block.text;
            }
          }
        }
      }
      clearTimeout(t);
      decision = this.parseDecision(text);
      // Apply min_confidence floor: if Claude approved but with confidence
      // below the threshold, downgrade to reject. This catches "yeah I guess
      // it's fine" approvals that we'd rather not trade on.
      if (decision.approve) {
        const conf = (decision.confidence ?? "low").toLowerCase();
        const need = CONFIDENCE_RANK[this.minConfidence] ?? 2;
        const got  = CONFIDENCE_RANK[conf] ?? 1;
        if (got < need) {
          decision = {
            ...decision,
            approve: false,
            reason: `confidence_${conf}_below_min_${this.minConfidence}: ${decision.reason}`,
          };
        }
      }
      log.info("consult.decision", {
        intent_id: ctx.intent.intent_id,
        approve: decision.approve,
        reason: decision.reason,
        confidence: decision.confidence,
      });
    } catch (e) {
      clearTimeout(t);
      const err = e instanceof Error ? e.message : String(e);
      log.warn("consult.error", { intent_id: ctx.intent.intent_id, error: err });
      decision = { approve: false, reason: `consult_error: ${err}`, error: err };
    }
    this.persist(ctx.intent.intent_id, decision);
    return decision;
  }

  private persist(intent_id: string, d: ConsultDecision): void {
    if (!this.db) return;
    try {
      this.db.prepare(
        `INSERT INTO consults(consult_id, intent_id, ts, approve, reason, confidence, raw_response, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        randomUUID(), intent_id, Date.now(),
        d.approve ? 1 : 0,
        d.reason ?? null,
        d.confidence ?? null,
        d.raw ?? null,
        d.error ?? null,
      );
    } catch (e) {
      log.warn("consult.persist_failed", { intent_id, error: String(e) });
    }
  }

  private buildPrompt(ctx: ConsultContext): string {
    return [
      "Proposed intent:",
      JSON.stringify(ctx.intent, null, 2),
      "",
      `Mid price (USD): ${ctx.midPrice}`,
      "",
      "Impact-check result (from POST /api/impact):",
      JSON.stringify(ctx.impact, null, 2),
      "",
      "Market snapshot (truncated):",
      JSON.stringify(ctx.market, null, 2),
      "",
      "Recent trades (last 10, for duplicate detection):",
      JSON.stringify(ctx.recentTrades ?? [], null, 2),
      "",
      "Recent consult decisions (last 5):",
      JSON.stringify(ctx.recentDecisions ?? [], null, 2),
      "",
      "Decide. JSON only."
    ].join("\n");
  }

  private parseDecision(raw: string): ConsultDecision {
    // Strip code fences if Claude returned any
    const cleaned = raw.trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    try {
      const obj = JSON.parse(cleaned) as Record<string, unknown>;
      return {
        approve: Boolean(obj.approve),
        reason: String(obj.reason ?? "no reason"),
        confidence: obj.confidence as ConsultDecision["confidence"],
        raw: cleaned,
      };
    } catch {
      return {
        approve: false,
        reason: `unparseable_response: ${raw.slice(0, 100)}`,
        raw,
      };
    }
  }

  /** Fetch the last N consult decisions for the system prompt context. */
  recent(limit = 5): { ts: number; approve: boolean; reason: string }[] {
    if (!this.db) return [];
    return this.db.prepare(
      `SELECT ts, approve, reason FROM consults ORDER BY ts DESC LIMIT ?`
    ).all(limit) as { ts: number; approve: boolean; reason: string }[];
  }

  /** Fetch recent trades (open + closed) for duplicate detection. Window: 4h. */
  recentTrades(limit = 10): { ts: number; legs_summary: string; status: string; mins_ago: number }[] {
    if (!this.db) return [];
    const since = Date.now() - 4 * 60 * 60 * 1000;
    const rows = this.db.prepare(
      `SELECT intent_id, ts, status, legs_json FROM intents
       WHERE ts >= ? AND status IN ('approved','filled','closed')
       ORDER BY ts DESC LIMIT ?`
    ).all(since, limit) as { intent_id: string; ts: number; status: string; legs_json: string }[];
    return rows.map(r => {
      let summary = "";
      try {
        const legs = JSON.parse(r.legs_json) as Array<{ venue: string; side: string; size_usd?: number; size_sats?: number }>;
        summary = legs.map(l => {
          const sz = l.size_usd ?? (l.size_sats ? `${l.size_sats}sats` : "?");
          return `${l.venue}/${l.side}/${sz}`;
        }).join(",");
      } catch { summary = "(unparseable)"; }
      return {
        ts: r.ts, legs_summary: summary, status: r.status,
        mins_ago: Math.round((Date.now() - r.ts) / 60_000),
      };
    });
  }
}
