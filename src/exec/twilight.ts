import { spawn } from "node:child_process";
import { log } from "../log.js";
import type { TwilightLeg, FillResult } from "./types.js";

interface RelayerEnv {
  paper: boolean;
  walletId?: string;
  password?: string;
}

const RELAYER_BIN = process.env.RELAYER_CLI_BIN ?? "relayer-cli";

function runRelayer(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(RELAYER_BIN, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", d => { stdout += d; });
    child.stderr.on("data", d => { stderr += d; });
    child.on("error", reject);
    child.on("close", code => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}

export class TwilightExec {
  constructor(private env: RelayerEnv) {}

  async open(leg: TwilightLeg, mid_price: number, account_index = 0): Promise<FillResult> {
    if (this.env.paper) {
      return {
        venue: "twilight", side: leg.side,
        size: leg.size_sats, price: mid_price, fee: 0,
        raw: { paper: true, leg },
      };
    }
    if (!this.env.walletId || !this.env.password) {
      throw new Error("twilight live: NYKS_WALLET_ID / NYKS_WALLET_PASSPHRASE not set");
    }
    const args = [
      "order", "open-trade",
      "--wallet-id", this.env.walletId,
      "--password",  this.env.password,
      "--account-index", String(account_index),
      "--side", leg.side.toUpperCase(),         // v0.1.2 expects "LONG"/"SHORT"
      "--entry-price", String(Math.round(mid_price)),
      "--leverage", String(leg.leverage),
      "--json",
    ];
    const r = await runRelayer(args);
    if (r.code !== 0) throw new Error(`relayer-cli open-trade failed (${r.code}): ${r.stderr}`);
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    return {
      venue: "twilight", side: leg.side,
      size: leg.size_sats,
      price: Number(parsed["entry_price"] ?? mid_price),
      fee: 0,
      raw: parsed,
    };
  }

  async close(account_index: number): Promise<FillResult> {
    if (this.env.paper) {
      return { venue: "twilight", side: "long", size: 0, price: 0, fee: 0, raw: { paper: true, closed: true } };
    }
    if (!this.env.walletId || !this.env.password) {
      throw new Error("twilight live: wallet env not set");
    }
    const r = await runRelayer([
      "order", "close-trade",
      "--wallet-id", this.env.walletId,
      "--password",  this.env.password,
      "--account-index", String(account_index),
      "--json",
    ]);
    if (r.code !== 0) throw new Error(`relayer-cli close-trade failed: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    return { venue: "twilight", side: "long", size: 0, price: Number(parsed["exit_price"] ?? 0), fee: 0, raw: parsed };
  }

  /** Attach a hard SL trigger on a Twilight position via close-trade SLTP mode.
   *  Position stays open; relayer auto-closes when mark price hits stop_price.
   *
   *  Retries on the "Order may be in the queue, try again later" race that
   *  happens when SLTP is submitted before the open-trade has settled on chain.
   *  Total wait budget ~30s (5 attempts × ~6s spacing). */
  async attachStop(account_index: number, side: "long" | "short", entry_price: number, stop_loss_pct: number): Promise<{ ok: boolean; stop_price: number; raw?: unknown; error?: string }> {
    if (this.env.paper) {
      return { ok: true, stop_price: side === "long" ? entry_price * (1 - stop_loss_pct) : entry_price * (1 + stop_loss_pct), raw: { paper: true } };
    }
    if (!this.env.walletId || !this.env.password) {
      return { ok: false, stop_price: 0, error: "wallet env not set" };
    }
    const stop_price = Math.round(side === "long" ? entry_price * (1 - stop_loss_pct) : entry_price * (1 + stop_loss_pct));
    const args = [
      "order", "close-trade",
      "--wallet-id", this.env.walletId,
      "--password",  this.env.password,
      "--account-index", String(account_index),
      "--order-type", "MARKET",
      "--execution-price", "0",
      "--stop-loss", String(stop_price),
      "--json",
    ];

    const maxAttempts = 5;
    const initialDelayMs = 4_000;
    let lastErr = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // wait BEFORE first attempt too — the open's tx needs ~3-5s to settle.
      await new Promise(res => setTimeout(res, initialDelayMs + (attempt - 1) * 2_000));
      const r = await runRelayer(args);
      if (r.code === 0) {
        let parsed: unknown = {};
        try { parsed = JSON.parse(r.stdout); } catch { /* tolerated */ }
        return { ok: true, stop_price, raw: parsed };
      }
      lastErr = r.stderr || `rc=${r.code}`;
      // If the error isn't the queue-race pattern, no point retrying.
      const isRetryable = /queue|try again|not (yet )?settled|memo state/i.test(lastErr);
      log.warn("twilight.attachStop_retry", { account_index, attempt, retryable: isRetryable, err: lastErr.slice(0, 200) });
      if (!isRetryable) break;
    }
    return { ok: false, stop_price, error: `attachStop failed after ${maxAttempts} attempts: ${lastErr}` };
  }

  async portfolioSummary(): Promise<unknown> {
    if (this.env.paper) return { paper: true, positions: [] };
    if (!this.env.walletId || !this.env.password) return { error: "wallet env not set" };
    const r = await runRelayer([
      "portfolio", "summary",
      "--wallet-id", this.env.walletId,
      "--password",  this.env.password,
      "--json",
    ]);
    if (r.code !== 0) {
      log.warn("twilight.portfolio.failed", { stderr: r.stderr });
      return { error: r.stderr };
    }
    return JSON.parse(r.stdout);
  }
}
