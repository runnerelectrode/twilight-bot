import type { DB } from "./state/db.js";
import { insertTick, finishTick } from "./state/db.js";
import { log } from "./log.js";
import type { PythonHost, TickPayload } from "./pythonHost.js";
import type { StrategyApi } from "./feeds/strategyApi.js";

export type IntentHandler = (
  reply: NonNullable<Awaited<ReturnType<PythonHost["send"]>>["reply"]>,
  tick_id: string,
  ctx: TickContext,
) => Promise<{ intent_id: string | null; status: "approved" | "rejected" | "filled" | "failed" } | null>;

export interface TickContext {
  market: unknown;
  strategies: unknown[];
  positions: unknown[];
  wallet: unknown;
  ts: number;
}

export interface SchedulerDeps {
  db: DB;
  host: PythonHost;
  strategyApi: StrategyApi;
  /** Returns the open positions reconciled across venues. M1 returns []; M3 implements real reconciliation. */
  fetchPositions(): Promise<unknown[]>;
  /** Returns the current wallet snapshot. M1 returns {}; M3 fills it in. */
  fetchWallet(): Promise<unknown>;
  /** Routes intent replies to safety + exec. M2 supplies the real handler. */
  onIntent: IntentHandler;
}

/** Per-skill failure-cascade circuit breaker.
 *  After N consecutive intent failures, pause the skill for cooldown_ms
 *  to stop hammering the venues with the same broken intent (and to stop
 *  the dashboard's recent-intents panel from filling with red rows).
 *  Resets on the first successful fill. */
interface FailureState {
  consecutive: number;
  pausedUntil: number;     // epoch ms; 0 means not paused
  lastError: string;
}
const MAX_CONSECUTIVE_FAILURES = Number(process.env.MAX_CONSECUTIVE_INTENT_FAILURES ?? 3);
const FAILURE_COOLDOWN_MS     = Number(process.env.INTENT_FAILURE_COOLDOWN_MS ?? 5 * 60 * 1000);

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private failures = new Map<string, FailureState>();

  constructor(private deps: SchedulerDeps) {}

  start(): void {
    if (this.timer) return;
    const interval = this.deps.host.skill.poll_interval_ms;
    this.timer = setInterval(() => { void this.tickOnce(); }, interval);
    void this.tickOnce();
    log.info("scheduler.started", { skill: this.deps.host.skill.name, interval_ms: interval });
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.deps.host.stop();
  }

  private async tickOnce(): Promise<void> {
    const skill = this.deps.host.skill.name;
    if (this.deps.host.isDisabled()) return;
    // Circuit-breaker: if the skill has been failing consecutively, skip
    // ticking entirely until cooldown expires. Logs a single skipped tick
    // each interval so the operator sees why nothing is happening.
    const fs = this.failures.get(skill);
    if (fs && fs.pausedUntil > Date.now()) {
      const breaker_id = this.makeId();
      const now = Date.now();
      insertTick(this.deps.db, { tick_id: breaker_id, skill, started_at: now });
      finishTick(this.deps.db, breaker_id, {
        status: "circuit_breaker_open",
        finished_at: now,
        latency_ms: 0,
        error: `${fs.consecutive} consecutive failures, paused ${Math.round((fs.pausedUntil - now) / 1000)}s more — last: ${fs.lastError.slice(0, 200)}`,
      });
      return;
    }
    if (this.deps.host.isInFlight()) {
      const overlap_id = this.makeId();
      const now = Date.now();
      insertTick(this.deps.db, { tick_id: overlap_id, skill, started_at: now });
      finishTick(this.deps.db, overlap_id, {
        status: "dropped_overlap",
        finished_at: now,
        latency_ms: 0,
      });
      log.debug("tick.dropped_overlap", { skill });
      return;
    }

    const ts = Date.now();

    let market: unknown = null;
    let strategies: unknown[] = [];
    try {
      const [m, s] = await Promise.all([
        this.deps.strategyApi.market(),
        this.deps.strategyApi.strategies({ profitable: true, limit: 20 }),
      ]);
      market = m;
      strategies = s.strategies;
    } catch (e) {
      log.warn("feeds.fetch_failed", { skill, error: String(e) });
    }

    const positions = await this.deps.fetchPositions().catch((e: unknown) => {
      log.warn("positions.fetch_failed", { skill, error: String(e) });
      return [];
    });
    const wallet = await this.deps.fetchWallet().catch(() => ({}));

    // Senpi-pattern: skip the python skill entirely if a position is already
    // open. Scanners should never re-evaluate exits (DSL owns that), so
    // calling them when positions exist is wasted IPC + risk of bad re-entry.
    if (this.deps.host.skill.skip_when_position_open && Array.isArray(positions) && positions.length > 0) {
      const skip_id = this.makeId();
      insertTick(this.deps.db, { tick_id: skip_id, skill, started_at: ts });
      finishTick(this.deps.db, skip_id, {
        status: "skip_position_open", finished_at: Date.now(), latency_ms: 0,
      });
      return;
    }

    const tickPayload: Omit<TickPayload, "type" | "tick_id"> = { ts, market, strategies, positions, wallet };
    const tick_id = this.makeId();
    insertTick(this.deps.db, { tick_id, skill, started_at: ts });

    const outcome = await this.deps.host.send(tickPayload);

    if (outcome.status === "noop") {
      finishTick(this.deps.db, tick_id, {
        status: "noop", finished_at: Date.now(), latency_ms: outcome.latency_ms,
      });
      return;
    }
    if (outcome.status === "timeout" || outcome.status === "mismatch" || outcome.status === "crashed") {
      finishTick(this.deps.db, tick_id, {
        status: outcome.status, finished_at: Date.now(), latency_ms: outcome.latency_ms,
        error: outcome.error,
      });
      return;
    }

    // status === "intent"
    const ctx: TickContext = { market, strategies, positions, wallet, ts };
    let intentResult: Awaited<ReturnType<IntentHandler>> = null;
    try {
      intentResult = await this.deps.onIntent(outcome.reply!, tick_id, ctx);
    } catch (e) {
      log.error("intent.handler_threw", { skill, error: String(e) });
    }
    finishTick(this.deps.db, tick_id, {
      status: "intent",
      finished_at: Date.now(),
      latency_ms: outcome.latency_ms,
      intent_id: intentResult?.intent_id ?? null,
    });

    // Update circuit breaker. Reset on filled, increment on failed/rejected,
    // ignore approved (mid-flight). Trip if streak hits the threshold.
    const status = intentResult?.status;
    if (status === "filled") {
      this.failures.delete(skill);
    } else if (status === "failed" || status === "rejected") {
      const cur = this.failures.get(skill) ?? { consecutive: 0, pausedUntil: 0, lastError: "" };
      cur.consecutive += 1;
      cur.lastError = `${status} intent ${intentResult?.intent_id ?? "?"}`;
      if (cur.consecutive >= MAX_CONSECUTIVE_FAILURES && cur.pausedUntil < Date.now()) {
        cur.pausedUntil = Date.now() + FAILURE_COOLDOWN_MS;
        log.warn("scheduler.circuit_breaker_tripped", {
          skill, consecutive: cur.consecutive, cooldown_ms: FAILURE_COOLDOWN_MS,
        });
      }
      this.failures.set(skill, cur);
    }
  }

  private makeId(): string {
    // Tick ids are server-issued so the host owns the correlation key.
    return `tick_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}
