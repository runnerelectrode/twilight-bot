import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { unlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.js";
import type { DB } from "../state/db.js";
import type { StrategyApi } from "../feeds/strategyApi.js";
import type { Guards } from "../safety/guards.js";
import type { ExecRouter } from "../exec/router.js";
import type { IntentLike } from "../exec/types.js";
import type { ImpactChecker } from "../safety/impactCheck.js";
import type { ClaudeConsult } from "../safety/claudeConsult.js";
import { handleChat, type ChatTurn } from "./chat.js";
import { randomUUID } from "node:crypto";

export interface ApiDeps {
  db: DB;
  strategyApi: StrategyApi;
  guards: Guards;
  impactChecker: ImpactChecker;
  consult: ClaudeConsult;
  exec: ExecRouter;
  fetchPositions(): Promise<unknown[]>;
  midPrice(): Promise<number>;
  cexBalances(): Promise<{ binance: number; bybit: number }>;
  bootEnv: { paper: boolean; liveConfirmed: boolean; dataDir: string };
  bindPublic: boolean;
  apiToken?: string;
  port: number;
  startTs: number;
  lastTickByName: Map<string, string>;
}

function send(res: ServerResponse, code: number, body: unknown): void {
  res.statusCode = code;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", c => chunks.push(c as Buffer));
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8"))); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

export function startApi(deps: ApiDeps): http.Server {
  const server = http.createServer(async (req, res) => {
    const reqId = randomUUID().slice(0, 8);
    const url = new URL(req.url ?? "/", "http://x");
    const method = req.method ?? "GET";
    log.debug("api.req", { req_id: reqId, method, path: url.pathname });

    if (deps.bindPublic) {
      const auth = req.headers["authorization"];
      if (!auth || auth !== `Bearer ${deps.apiToken}`) {
        return send(res, 401, { error: "unauthorized" });
      }
    }

    try {
      await route(deps, method, url, req, res, reqId);
    } catch (e) {
      log.error("api.err", { req_id: reqId, error: String(e) });
      send(res, 500, { error: "internal", detail: String(e) });
    }
  });

  const host = deps.bindPublic ? "0.0.0.0" : "127.0.0.1";
  server.listen(deps.port, host, () => {
    log.info("api.listening", { host, port: deps.port, public: deps.bindPublic });
  });
  return server;
}

async function route(
  d: ApiDeps, method: string, url: URL, req: IncomingMessage, res: ServerResponse, reqId: string,
): Promise<void> {
  const p = url.pathname;

  if (method === "GET" && p === "/healthz") {
    return send(res, 200, {
      ok: true,
      uptime_s: Math.floor((Date.now() - d.startTs) / 1000),
      mode: d.bootEnv.paper ? "paper" : "live",
      last_tick: Object.fromEntries(d.lastTickByName),
    });
  }

  if (method === "GET" && p === "/strategies") {
    const filter = {
      category:   url.searchParams.get("category")   ?? undefined,
      risk:       url.searchParams.get("risk")       ?? undefined,
      profitable: url.searchParams.get("profitable") === "true" ? true : undefined,
      minApy:     url.searchParams.get("minApy") ? Number(url.searchParams.get("minApy")) : undefined,
      limit:      url.searchParams.get("limit")  ? Number(url.searchParams.get("limit"))  : undefined,
    };
    return send(res, 200, await d.strategyApi.strategies(filter));
  }

  if (method === "GET" && p === "/market") {
    return send(res, 200, await d.strategyApi.market());
  }

  if (method === "GET" && p === "/positions") {
    const venue = url.searchParams.get("venue");
    const positions = await d.fetchPositions();
    return send(res, 200, venue
      ? (positions as { venue?: string }[]).filter(x => x.venue === venue)
      : positions);
  }

  let m: RegExpMatchArray | null;
  if (method === "GET" && (m = p.match(/^\/trades\/([^/]+)$/))) {
    const intent_id = m[1]!;
    const intent = d.db.prepare(`SELECT * FROM intents WHERE intent_id = ?`).get(intent_id);
    if (!intent) return send(res, 404, { error: "not_found" });
    const fills = d.db.prepare(`SELECT * FROM fills WHERE intent_id = ? ORDER BY ts ASC`).all(intent_id);
    return send(res, 200, { intent, fills });
  }

  if (method === "GET" && p === "/trades") {
    const q = url.searchParams.get("q");
    const since = Number(url.searchParams.get("since") ?? 0);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 25), 200);
    if (q) {
      const rows = d.db.prepare(
        `SELECT i.* FROM intents_fts f
         JOIN intents i ON i.rowid = f.rowid
         WHERE f.thesis MATCH ? AND i.ts >= ?
         ORDER BY bm25(intents_fts) ASC LIMIT ?`
      ).all(q, since, limit);
      return send(res, 200, { matches: rows });
    }
    const rows = d.db.prepare(
      `SELECT * FROM intents WHERE ts >= ? ORDER BY ts DESC LIMIT ?`
    ).all(since, limit);
    return send(res, 200, { matches: rows });
  }

  if (method === "GET" && p === "/ticks") {
    const skill = url.searchParams.get("skill");
    const since = Number(url.searchParams.get("since") ?? 0);
    const status = url.searchParams.get("status");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 1000);
    let sql = `SELECT * FROM ticks WHERE started_at >= ?`;
    const args: unknown[] = [since];
    if (skill)  { sql += ` AND skill = ?`;  args.push(skill); }
    if (status) { sql += ` AND status = ?`; args.push(status); }
    sql += ` ORDER BY started_at DESC LIMIT ?`;
    args.push(limit);
    return send(res, 200, d.db.prepare(sql).all(...args));
  }

  if (method === "POST" && (p === "/trades/paper" || p === "/trades/live")) {
    const body = await readJson(req) as Partial<IntentLike> & { confirm_live?: boolean };
    const intent: IntentLike = {
      intent_id: randomUUID(),
      skill: "api",
      thesis: body.thesis ?? "operator-issued via api",
      legs: body.legs ?? [],
      exit: body.exit ?? { rules: [] },
    };
    const live = p === "/trades/live";
    const mid = await d.midPrice();
    const balances = await d.cexBalances();
    const decision = d.guards.check(intent, {
      midPrice: mid, binanceBalanceUsd: balances.binance, bybitBalanceUsd: balances.bybit,
    }, { live, confirmLive: body.confirm_live });
    if (!decision.ok) return send(res, 400, { error: "rejected", reason: decision.reason });
    // Pre-trade impact check: would this tip Twilight funding against us?
    // Skipped for paper mode so dry-runs aren't gated on the chain pool state.
    if (live) {
      const impact = await d.impactChecker.check(intent, mid);
      if (!impact.ok) return send(res, 400, { error: "rejected", reason: impact.reason, layer: "impact", details: impact.details });
      // Claude consultation gate — third safety layer before exec.
      const market = await d.strategyApi.market().catch(() => ({}));
      const c = await d.consult.ask({
        intent, midPrice: mid, impact: impact.details ?? null,
        market,
        recentDecisions: d.consult.recent(5),
        recentTrades: d.consult.recentTrades(10),
      });
      if (!c.approve) return send(res, 400, { error: "rejected", reason: `consult: ${c.reason}`, layer: "consult", confidence: c.confidence });
    }

    d.db.prepare(
      `INSERT INTO intents(intent_id, skill, ts, thesis, legs_json, exit_json, status)
       VALUES (?, ?, ?, ?, ?, ?, 'approved')`
    ).run(intent.intent_id, intent.skill, Date.now(), intent.thesis ?? null,
          JSON.stringify(intent.legs), JSON.stringify(intent.exit));

    const result = await d.exec.fanOut(intent);
    d.db.prepare(`UPDATE intents SET status = ? WHERE intent_id = ?`)
        .run(result.status, intent.intent_id);
    return send(res, 200, { intent_id: intent.intent_id, ...result });
  }

  if (method === "POST" && (m = p.match(/^\/positions\/([^/]+)\/close$/))) {
    const position_id = m[1]!;
    const pos = d.db.prepare(`SELECT * FROM positions WHERE position_id = ?`).get(position_id) as { intent_id?: string } | undefined;
    if (!pos?.intent_id) return send(res, 404, { error: "not_found" });
    const intent = d.db.prepare(`SELECT * FROM intents WHERE intent_id = ?`).get(pos.intent_id) as { legs_json?: string } | undefined;
    if (!intent?.legs_json) return send(res, 404, { error: "intent_not_found" });
    const legs = JSON.parse(intent.legs_json) as IntentLike["legs"];
    const fills = await d.exec.closePositionFor({ intent_id: pos.intent_id, skill: "api", legs }, 0);
    d.db.prepare(`UPDATE positions SET closed_at = ? WHERE position_id = ?`)
        .run(Date.now(), position_id);
    return send(res, 200, { position_id, fills });
  }

  if (method === "POST" && (m = p.match(/^\/skills\/([^/]+)\/(enable|disable)$/))) {
    const name = m[1]!;
    const enable = m[2] === "enable";
    const enabled_count = (d.db.prepare(`SELECT COUNT(*) AS n FROM skills WHERE enabled = 1`).get() as { n: number }).n;
    if (enable && enabled_count >= 1) {
      const cur = d.db.prepare(`SELECT name FROM skills WHERE enabled = 1`).get() as { name?: string } | undefined;
      if (cur?.name !== name) return send(res, 409, { error: "single_skill_rule", currently_enabled: cur?.name });
    }
    if (!enable && enabled_count <= 1) {
      return send(res, 409, { error: "single_skill_rule", note: "v1 requires exactly 1 enabled skill" });
    }
    d.db.prepare(`UPDATE skills SET enabled = ? WHERE name = ?`).run(enable ? 1 : 0, name);
    return send(res, 200, { name, enabled: enable, note: "container restart required for the change to take effect" });
  }

  if (method === "GET" && p === "/kill-switch") {
    return send(res, 200, { on: existsSync(join(d.bootEnv.dataDir, "KILL_SWITCH")) });
  }
  if (method === "PUT" && p === "/kill-switch") {
    const body = await readJson(req) as { on?: boolean };
    const path = join(d.bootEnv.dataDir, "KILL_SWITCH");
    if (body.on) writeFileSync(path, String(Date.now()));
    else if (existsSync(path)) unlinkSync(path);
    return send(res, 200, { on: !!body.on });
  }

  if (method === "POST" && p === "/chat") {
    const body = await readJson(req) as { message?: string; history?: ChatTurn[] };
    const result = await handleChat({
      db: d.db,
      strategyApi: d.strategyApi,
      fetchPositions: d.fetchPositions,
      bootEnv: { paper: d.bootEnv.paper, dataDir: d.bootEnv.dataDir },
      startTs: d.startTs,
      lastTickByName: d.lastTickByName,
    }, body);
    return send(res, result.error ? 502 : 200, result);
  }

  if (method === "GET" && p === "/caps") {
    return send(res, 200, {
      MAX_NOTIONAL_USD_PER_INTENT: Number(process.env.MAX_NOTIONAL_USD_PER_INTENT ?? 200),
      MAX_OPEN_POSITIONS:          Number(process.env.MAX_OPEN_POSITIONS ?? 1),
      MAX_LEVERAGE:                Number(process.env.MAX_LEVERAGE ?? 5),
      DAILY_LOSS_STOP_USD:         Number(process.env.DAILY_LOSS_STOP_USD ?? 50),
      MIN_BALANCE_USD_PER_VENUE:   Number(process.env.MIN_BALANCE_USD_PER_VENUE ?? 50),
      _note: "caps are env-driven; PUT /caps applies in-memory only and resets on restart",
    });
  }

  return send(res, 404, { error: "not_found", path: p, req_id: reqId });
}
