import Database from "better-sqlite3";
import { join } from "node:path";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS skills (
  name         TEXT PRIMARY KEY,
  version      TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_tick_at INTEGER
);

CREATE TABLE IF NOT EXISTS intents (
  intent_id            TEXT PRIMARY KEY,
  skill                TEXT NOT NULL,
  ts                   INTEGER NOT NULL,
  thesis               TEXT,
  legs_json            TEXT NOT NULL,
  exit_json            TEXT NOT NULL,
  status               TEXT NOT NULL,
  rejected_reason      TEXT,
  chosen_strategy_id   INTEGER,
  chosen_strategy_name TEXT,
  chosen_strategy_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_intents_strategy
  ON intents(chosen_strategy_id) WHERE chosen_strategy_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_intents_skill_ts ON intents(skill, ts DESC);

CREATE TABLE IF NOT EXISTS fills (
  fill_id   TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES intents(intent_id),
  venue     TEXT NOT NULL,
  side      TEXT NOT NULL,
  size      REAL NOT NULL,
  price     REAL NOT NULL,
  fee       REAL NOT NULL DEFAULT 0,
  raw_json  TEXT NOT NULL,
  ts        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fills_intent ON fills(intent_id);

CREATE TABLE IF NOT EXISTS positions (
  position_id   TEXT PRIMARY KEY,
  intent_id     TEXT NOT NULL,
  venue         TEXT NOT NULL,
  side          TEXT NOT NULL,
  size          REAL NOT NULL,
  entry_price   REAL NOT NULL,
  leverage      REAL NOT NULL,
  opened_at     INTEGER NOT NULL,
  closed_at     INTEGER,
  realized_pnl  REAL
);
CREATE INDEX IF NOT EXISTS idx_positions_open
  ON positions(venue) WHERE closed_at IS NULL;

CREATE TABLE IF NOT EXISTS ticks (
  tick_id     TEXT PRIMARY KEY,
  skill       TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  status      TEXT NOT NULL,
  intent_id   TEXT,
  latency_ms  INTEGER,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_ticks_skill_started
  ON ticks(skill, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ticks_status ON ticks(status);

CREATE TABLE IF NOT EXISTS decisions (
  ts            INTEGER NOT NULL,
  position_id   TEXT,
  rule_json     TEXT NOT NULL,
  fired         INTEGER NOT NULL,
  metrics_json  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_position ON decisions(position_id);

CREATE VIRTUAL TABLE IF NOT EXISTS intents_fts USING fts5(
  thesis,
  skill UNINDEXED,
  intent_id UNINDEXED,
  ts UNINDEXED,
  tokenize = 'porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS intents_ai AFTER INSERT ON intents BEGIN
  INSERT INTO intents_fts(rowid, thesis, skill, intent_id, ts)
  VALUES (NEW.rowid, COALESCE(NEW.thesis, ''), NEW.skill, NEW.intent_id, NEW.ts);
END;
CREATE TRIGGER IF NOT EXISTS intents_au AFTER UPDATE ON intents BEGIN
  UPDATE intents_fts SET thesis = COALESCE(NEW.thesis, '') WHERE rowid = NEW.rowid;
END;
`;

export type DB = Database.Database;

export interface IntentRow {
  intent_id: string;
  skill: string;
  ts: number;
  thesis: string | null;
  legs_json: string;
  exit_json: string;
  status: string;
  rejected_reason: string | null;
  chosen_strategy_id: number | null;
  chosen_strategy_name: string | null;
  chosen_strategy_json: string | null;
}

export interface TickRow {
  tick_id: string;
  skill: string;
  started_at: number;
  finished_at: number | null;
  status: string;
  intent_id: string | null;
  latency_ms: number | null;
  error: string | null;
}

export function openDb(dataDir: string): DB {
  const path = join(dataDir, "tradebot.db");
  const db = new Database(path);
  db.exec(SCHEMA);
  return db;
}

export function upsertSkill(db: DB, name: string, version: string, enabled: boolean): void {
  db.prepare(
    `INSERT INTO skills(name, version, enabled) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET version=excluded.version, enabled=excluded.enabled`
  ).run(name, version, enabled ? 1 : 0);
}

export function insertTick(db: DB, t: { tick_id: string; skill: string; started_at: number }): void {
  db.prepare(
    `INSERT INTO ticks(tick_id, skill, started_at, status) VALUES (?, ?, ?, 'pending')`
  ).run(t.tick_id, t.skill, t.started_at);
}

export function finishTick(db: DB, tick_id: string, fields: {
  status: string;
  finished_at: number;
  intent_id?: string | null;
  latency_ms?: number | null;
  error?: string | null;
}): void {
  db.prepare(
    `UPDATE ticks SET status = ?, finished_at = ?, intent_id = ?, latency_ms = ?, error = ?
     WHERE tick_id = ?`
  ).run(
    fields.status,
    fields.finished_at,
    fields.intent_id ?? null,
    fields.latency_ms ?? null,
    fields.error ?? null,
    tick_id,
  );
}

export function insertIntent(db: DB, row: IntentRow): void {
  db.prepare(
    `INSERT INTO intents(intent_id, skill, ts, thesis, legs_json, exit_json, status,
                         rejected_reason, chosen_strategy_id, chosen_strategy_name, chosen_strategy_json)
     VALUES (@intent_id, @skill, @ts, @thesis, @legs_json, @exit_json, @status,
             @rejected_reason, @chosen_strategy_id, @chosen_strategy_name, @chosen_strategy_json)`
  ).run(row);
}

export function updateIntentStatus(db: DB, intent_id: string, status: string, rejected_reason?: string): void {
  db.prepare(
    `UPDATE intents SET status = ?, rejected_reason = ? WHERE intent_id = ?`
  ).run(status, rejected_reason ?? null, intent_id);
}
