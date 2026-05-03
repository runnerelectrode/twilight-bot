/**
 * /bot/chat: operator copilot.
 *
 * Server-side: snapshot bot state (positions, ticks, intents, consults,
 * market) on every turn and feed it as context to the Claude Agent SDK.
 * Auth = Claude OAuth subscription on the host (`claude login` once).
 *
 * v1 is read-only: the assistant cannot trigger actions. If the operator
 * asks it to flip the kill switch or close a position, it must point them
 * at the dashboard buttons / endpoints. Tool-calling can come later.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { log } from "../log.js";
import type { DB } from "../state/db.js";
import type { StrategyApi } from "../feeds/strategyApi.js";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ChatDeps {
  db: DB;
  strategyApi: StrategyApi;
  fetchPositions(): Promise<unknown[]>;
  bootEnv: { paper: boolean; dataDir: string };
  startTs: number;
  lastTickByName: Map<string, string>;
}

const MODEL  = process.env.CLAUDE_CHAT_MODEL ?? "claude-opus-4-7";
const MAX_HISTORY  = 12;
const MAX_MESSAGE  = 2_000;
const TIMEOUT_MS   = 60_000;
// On hosts where claude was installed via npm (not the native installer),
// the SDK can't auto-discover the binary. Set CLAUDE_CLI_PATH=/usr/bin/claude
// (or wherever `which claude` points) to override.
const CLAUDE_CLI_PATH = process.env.CLAUDE_CLI_PATH;

const SYSTEM_PROMPT = `You are the operator's copilot for an autonomous trading bot. The bot trades funding-rate arbitrage on Twilight (zkOS inverse perp), Binance USDT-M futures, and Bybit BTC inverse perp.

You receive a SNAPSHOT of current bot state on every turn. Answer the operator's questions concisely, factually, and based ONLY on the snapshot.

Rules:
- If the data isn't in the snapshot, say so plainly. Don't guess or fabricate numbers.
- If asked to take an action (kill switch, close position, enable/disable skill), DO NOT pretend to do it. Tell the operator to use the dashboard's kill switch toggle, or the close button on the position row, or the relevant API endpoint. You are read-only.
- Reply in 1-4 short sentences unless detail is asked for. Match the snapshot's units.
- No preamble ("Sure!", "Here's..."), no emojis, no sycophantic phrases.
- If you spot something concerning in the snapshot (stuck tick, repeated reject, feed gap > 5min, large drawdown), surface it even if not asked.`;

async function buildSnapshot(d: ChatDeps): Promise<string> {
  const positions = await d.fetchPositions().catch(() => []);
  const ticks   = d.db.prepare(`SELECT tick_id, skill, started_at, finished_at, status, intent_id, latency_ms, error FROM ticks ORDER BY started_at DESC LIMIT 10`).all();
  const intents = d.db.prepare(`SELECT intent_id, skill, ts, status, rejected_reason, thesis FROM intents ORDER BY ts DESC LIMIT 10`).all();
  const consults = d.db.prepare(`SELECT ts, approve, reason, confidence FROM consults ORDER BY ts DESC LIMIT 5`).all();
  let market: unknown = null;
  try { market = await d.strategyApi.market(); } catch (e) {
    market = { error: `strategy-api unreachable: ${e instanceof Error ? e.message : String(e)}` };
  }
  const killSwitch = existsSync(join(d.bootEnv.dataDir, "KILL_SWITCH"));
  const snapshot = {
    bot: {
      mode: d.bootEnv.paper ? "paper" : "live",
      uptime_s: Math.floor((Date.now() - d.startTs) / 1000),
      kill_switch: killSwitch,
      last_tick_per_skill: Object.fromEntries(d.lastTickByName),
    },
    open_positions: positions,
    recent_ticks: ticks,
    recent_intents: intents,
    recent_consults: consults,
    market_snapshot: market,
    snapshot_taken_at: new Date().toISOString(),
  };
  return JSON.stringify(snapshot, null, 2);
}

export async function handleChat(d: ChatDeps, body: { message?: string; history?: ChatTurn[] }): Promise<{ reply: string; error?: string }> {
  const message = String(body.message ?? "").slice(0, MAX_MESSAGE).trim();
  if (!message) return { reply: "", error: "empty_message" };
  const history = (body.history ?? [])
    .filter(t => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string")
    .slice(-MAX_HISTORY);

  const snapshot = await buildSnapshot(d);
  const historyText = history.length === 0 ? "(start of conversation)"
    : history.map(t => `${t.role === "user" ? "OPERATOR" : "YOU"}: ${t.content}`).join("\n\n");

  const fullPrompt = `=== BOT STATE SNAPSHOT (taken just now) ===
${snapshot}

=== CONVERSATION SO FAR ===
${historyText}

=== OPERATOR (new message) ===
${message}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const result = query({
      prompt: fullPrompt,
      options: {
        model: MODEL,
        systemPrompt: SYSTEM_PROMPT,
        maxTurns: 1,
        abortController: ac,
        ...(CLAUDE_CLI_PATH ? { pathToClaudeCodeExecutable: CLAUDE_CLI_PATH } : {}),
      },
    });
    let assistantText = "";
    for await (const msg of result) {
      // The SDK emits assistant messages first then a result message.
      // We collect text from assistant messages so we get the full reply
      // even if the SDK yields multiple text blocks.
      if (msg.type === "assistant") {
        const content = (msg as { message?: { content?: Array<{ type?: string; text?: string }> } }).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && typeof block.text === "string") {
              assistantText += block.text;
            }
          }
        }
      } else if (msg.type === "result") {
        const r = msg as { result?: string };
        if (r.result && !assistantText) assistantText = r.result;
      }
    }
    clearTimeout(timer);
    if (!assistantText) return { reply: "", error: "no_assistant_text" };
    return { reply: assistantText };
  } catch (e) {
    clearTimeout(timer);
    const msg = e instanceof Error ? e.message : String(e);
    log.error("chat.err", { err: msg });
    return { reply: "", error: msg };
  }
}
