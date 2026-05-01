import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { log } from "./log.js";
import { loadSkills, enforceSingleSkill } from "./pluginLoader.js";
import { openDb, upsertSkill, insertIntent, updateIntentStatus } from "./state/db.js";
import { StrategyApi } from "./feeds/strategyApi.js";
import { PythonHost } from "./pythonHost.js";
import { Scheduler, type IntentHandler } from "./scheduler.js";
import { TwilightExec } from "./exec/twilight.js";
import { CexExec } from "./exec/cex.js";
import { ExecRouter } from "./exec/router.js";
import { Guards } from "./safety/guards.js";
import { startApi } from "./api/server.js";
import type { IntentLike } from "./exec/types.js";
import { PositionTracker } from "./feeds/positionTracker.js";
import { evaluate, type ExitRule, type DslMetrics } from "./dsl/engine.js";

interface BootEnv {
  paper: boolean;
  liveConfirmed: boolean;
  bindPublic: boolean;
  apiToken: string | undefined;
  apiPort: number;
  dataDir: string;
  skillsDir: string;
  strategyApiBase: string;
  strategyApiKey: string;
}

function readEnv(): BootEnv {
  const paper = (process.env.PAPER ?? "1") !== "0";
  const liveConfirmed = process.env.LIVE_TRADING_CONFIRMED === "YES";
  const bindPublic = process.env.BIND_PUBLIC === "YES";
  return {
    paper,
    liveConfirmed,
    bindPublic,
    apiToken: process.env.API_TOKEN,
    apiPort: parseInt(process.env.API_PORT ?? "8787", 10),
    dataDir: process.env.DATA_DIR ?? "./data",
    skillsDir: process.env.SKILLS_DIR ?? join(process.cwd(), "skills"),
    strategyApiBase: process.env.STRATEGY_API_BASE ?? "http://134.199.214.129:3000",
    strategyApiKey: process.env.STRATEGY_API_KEY ?? "",
  };
}

function validateBootEnv(env: BootEnv): void {
  if (!env.paper && !env.liveConfirmed) {
    throw new Error("PAPER=0 set without LIVE_TRADING_CONFIRMED=YES (plan §8).");
  }
  if (env.paper && env.liveConfirmed) {
    log.warn("PAPER=1 and LIVE_TRADING_CONFIRMED=YES are both set; runtime stays in paper mode.");
  }
  if (env.bindPublic && !env.apiToken) {
    throw new Error("BIND_PUBLIC=YES set without API_TOKEN (plan §8).");
  }
}

async function main(): Promise<void> {
  const env = readEnv();
  validateBootEnv(env);

  if (!existsSync(env.dataDir)) mkdirSync(env.dataDir, { recursive: true });
  const startTs = Date.now();

  const db = openDb(env.dataDir);
  const allSkills = loadSkills(env.skillsDir);
  const active = enforceSingleSkill(allSkills);
  upsertSkill(db, active.name, active.version, true);

  const strategyApi = new StrategyApi(env.strategyApiBase, env.strategyApiKey);

  const twilight = new TwilightExec({
    paper: env.paper,
    walletId: process.env.NYKS_WALLET_ID,
    password: process.env.NYKS_WALLET_PASSPHRASE,
  });
  const binance = new CexExec("binance", {
    paper: env.paper,
    testnet: process.env.BINANCE_TESTNET === "1",
    apiKey: process.env.BINANCE_API_KEY,
    apiSecret: process.env.BINANCE_API_SECRET,
  });
  const bybit = new CexExec("bybit", {
    paper: env.paper,
    testnet: process.env.BYBIT_TESTNET === "1",
    apiKey: process.env.BYBIT_API_KEY,
    apiSecret: process.env.BYBIT_API_SECRET,
  });

  const lastTickByName = new Map<string, string>();
  let cachedMid = 0;
  const midPrice = async (): Promise<number> => {
    if (cachedMid > 0) return cachedMid;
    try {
      const m = await strategyApi.market();
      cachedMid = m.prices.twilight || m.prices.binanceFutures || 0;
    } catch (e) {
      log.warn("mid_price.fetch_failed", { error: String(e) });
    }
    return cachedMid;
  };
  const cexBalances = async (): Promise<{ binance: number; bybit: number }> => {
    const mid = await midPrice();
    return {
      binance: await binance.fetchBalanceUsd(mid).catch(() => 0),
      bybit:   await bybit.fetchBalanceUsd(mid).catch(() => 0),
    };
  };

  const guards = new Guards(db, {
    paper: env.paper,
    liveConfirmed: env.liveConfirmed,
    dataDir: env.dataDir,
    maxNotionalUsdPerIntent: Number(process.env.MAX_NOTIONAL_USD_PER_INTENT ?? 200),
    maxOpenPositions:        Number(process.env.MAX_OPEN_POSITIONS ?? 1),
    maxLeverage:             Number(process.env.MAX_LEVERAGE ?? 5),
    dailyLossStopUsd:        Number(process.env.DAILY_LOSS_STOP_USD ?? 50),
    minBalancePerVenueUsd:   Number(process.env.MIN_BALANCE_USD_PER_VENUE ?? 50),
  }, active);

  const exec = new ExecRouter({ db, twilight, binance, bybit, midPrice });
  const positionTracker = new PositionTracker(twilight, binance, bybit);

  const fetchPositions = async (): Promise<unknown[]> => positionTracker.all();

  const evaluateExitsForOpenIntents = async (): Promise<void> => {
    const openIntents = db.prepare(
      `SELECT i.intent_id, i.legs_json, i.exit_json, i.ts AS opened_at
       FROM intents i
       WHERE i.status = 'filled'
         AND NOT EXISTS (SELECT 1 FROM positions p WHERE p.intent_id = i.intent_id AND p.closed_at IS NOT NULL)`
    ).all() as { intent_id: string; legs_json: string; exit_json: string; opened_at: number }[];
    if (openIntents.length === 0) return;
    const market = await strategyApi.market().catch(() => null);
    if (!market) return;
    const pool_skew = Number(market.pool?.currentSkew ?? 0);
    for (const i of openIntents) {
      const exitDef = JSON.parse(i.exit_json) as { rules?: ExitRule[] };
      const rules = exitDef.rules ?? [];
      const positions = db.prepare(
        `SELECT * FROM positions WHERE intent_id = ? AND closed_at IS NULL`
      ).all(i.intent_id) as { entry_price: number; size: number; venue: string; side: string }[];
      if (positions.length === 0) continue;
      const time_in_position_hours = (Date.now() - i.opened_at) / 3_600_000;
      const totalEntry = positions.reduce((a, p) => a + p.entry_price * p.size, 0);
      const totalSize  = positions.reduce((a, p) => a + p.size, 0);
      const avgEntry   = totalSize > 0 ? totalEntry / totalSize : 0;
      const mid = await midPrice();
      const unrealized_pct = avgEntry > 0 ? (mid - avgEntry) / avgEntry : 0;
      const metrics: DslMetrics = {
        pnl: { unrealized_pct },
        funding_rates: {
          twilight: { rate: market.fundingRates.twilight.rate },
          binance:  { rate: market.fundingRates.binance.rate },
          bybit:    { rate: market.fundingRates.bybit.rate },
        },
        pool: { skew_pct: pool_skew },
        time_in_position_hours,
      };
      const decision = evaluate(rules, metrics);
      db.prepare(
        `INSERT INTO decisions(ts, position_id, rule_json, fired, metrics_json) VALUES (?, ?, ?, ?, ?)`
      ).run(Date.now(), i.intent_id,
            JSON.stringify(decision.rule ?? null),
            decision.fired ? 1 : 0,
            JSON.stringify(metrics));
      if (decision.fired) {
        const legs = JSON.parse(i.legs_json) as IntentLike["legs"];
        const closeIntent: IntentLike = { intent_id: i.intent_id, skill: active.name, legs };
        await exec.closePositionFor(closeIntent, 0);
        db.prepare(`UPDATE positions SET closed_at = ? WHERE intent_id = ? AND closed_at IS NULL`)
          .run(Date.now(), i.intent_id);
        db.prepare(`UPDATE intents SET status = 'closed' WHERE intent_id = ?`).run(i.intent_id);
        log.info("dsl.fired", { intent_id: i.intent_id, rule: decision.rule });
      }
    }
  };

  const onIntent: IntentHandler = async (reply, _tick_id, ctx) => {
    const skill = active.name;
    const ts = Date.now();
    const intent: IntentLike = {
      intent_id: typeof reply["intent_id"] === "string" ? reply["intent_id"] as string : randomUUID(),
      skill,
      thesis: reply["thesis"] as string | undefined,
      legs: reply["legs"] as IntentLike["legs"],
      exit: reply["exit"] as IntentLike["exit"],
      chosen_strategy_id: reply["chosen_strategy_id"] as number | undefined,
    };

    let chosenName: string | null = null;
    let chosenJson: string | null = null;
    if (intent.chosen_strategy_id !== undefined) {
      const s = (ctx.strategies as Array<{ id?: number; name?: string }>).find(x => x.id === intent.chosen_strategy_id);
      if (!s) {
        insertIntent(db, {
          intent_id: intent.intent_id, skill, ts,
          thesis: intent.thesis ?? null,
          legs_json: JSON.stringify(intent.legs),
          exit_json: JSON.stringify(intent.exit ?? { rules: [] }),
          status: "rejected",
          rejected_reason: "strategy_id_not_in_tick",
          chosen_strategy_id: intent.chosen_strategy_id,
          chosen_strategy_name: null,
          chosen_strategy_json: null,
        });
        return { intent_id: intent.intent_id, status: "rejected" };
      }
      chosenName = s.name ?? null;
      chosenJson = JSON.stringify(s);
    }

    insertIntent(db, {
      intent_id: intent.intent_id, skill, ts,
      thesis: intent.thesis ?? null,
      legs_json: JSON.stringify(intent.legs),
      exit_json: JSON.stringify(intent.exit ?? { rules: [] }),
      status: "pending",
      rejected_reason: null,
      chosen_strategy_id: intent.chosen_strategy_id ?? null,
      chosen_strategy_name: chosenName,
      chosen_strategy_json: chosenJson,
    });

    const mid = await midPrice();
    const balances = await cexBalances();
    const decision = guards.check(intent, {
      midPrice: mid, binanceBalanceUsd: balances.binance, bybitBalanceUsd: balances.bybit,
    }, { live: !env.paper });
    if (!decision.ok) {
      updateIntentStatus(db, intent.intent_id, "rejected", decision.reason);
      log.warn("intent.rejected", { intent_id: intent.intent_id, reason: decision.reason });
      return { intent_id: intent.intent_id, status: "rejected" };
    }
    updateIntentStatus(db, intent.intent_id, "approved");
    const result = await exec.fanOut(intent);
    updateIntentStatus(db, intent.intent_id, result.status);
    log.info("intent.executed", {
      intent_id: intent.intent_id, status: result.status, fills: result.fills.length,
    });
    return { intent_id: intent.intent_id, status: result.status };
  };

  const host = new PythonHost(active);
  host.start();

  const scheduler = new Scheduler({ db, host, strategyApi, fetchPositions, fetchWallet: async () => ({}), onIntent });

  startApi({
    db, strategyApi, guards, exec,
    fetchPositions, midPrice, cexBalances,
    bootEnv: { paper: env.paper, liveConfirmed: env.liveConfirmed, dataDir: env.dataDir },
    bindPublic: env.bindPublic,
    apiToken: env.apiToken,
    port: env.apiPort,
    startTs,
    lastTickByName,
  });

  log.info("boot.ok", {
    mode: env.paper ? "paper" : "live",
    skills_total: allSkills.length,
    skills_active: active.name,
    api_port: env.apiPort,
    bind_public: env.bindPublic,
    data_dir: env.dataDir,
  });

  scheduler.start();

  // DSL evaluation runs on the same cadence as the scheduler; cheap, no harm running every tick.
  const dslTimer = setInterval(() => {
    void evaluateExitsForOpenIntents().catch(e => log.warn("dsl.tick_failed", { error: String(e) }));
  }, active.poll_interval_ms);

  const shutdown = (sig: string): void => {
    log.info("shutdown.signal", { sig });
    clearInterval(dslTimer);
    scheduler.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT",  () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch(err => {
  log.error("boot.failed", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
