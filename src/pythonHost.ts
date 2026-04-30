import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { log } from "./log.js";
import type { SkillConfig } from "./pluginLoader.js";

export interface TickPayload {
  type: "tick";
  tick_id: string;
  ts: number;
  market: unknown;
  strategies: unknown[];
  positions: unknown[];
  wallet: unknown;
}

export interface SkillReply {
  type: "intent" | "noop";
  tick_id: string;
  [key: string]: unknown;
}

export interface SendOutcome {
  status: "intent" | "noop" | "timeout" | "mismatch" | "crashed";
  reply?: SkillReply;
  error?: string;
  latency_ms: number;
}

const MAX_CONSECUTIVE_TIMEOUTS = 3;

export class PythonHost {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private inFlight: { tick_id: string; resolve: (v: SkillReply | null) => void } | null = null;
  private consecutiveTimeouts = 0;
  private disabled = false;

  constructor(public readonly skill: SkillConfig) {}

  start(): void {
    if (this.disabled) throw new Error(`skill ${this.skill.name} is disabled`);
    if (this.child) return;
    const projectPython = `${process.cwd()}/python`;
    const env = { ...process.env, PYTHONPATH: `${projectPython}:${process.env.PYTHONPATH ?? ""}` };
    const child = spawn("python3", [this.skill.scanner_path], { env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.buffer = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", chunk => this.onStdout(chunk as string));
    child.stderr.on("data", chunk => log.warn("skill.stderr", { skill: this.skill.name, line: String(chunk).trim() }));
    child.on("exit", (code, signal) => {
      log.warn("skill.exit", { skill: this.skill.name, code, signal });
      this.child = null;
      const inFlight = this.inFlight;
      this.inFlight = null;
      if (inFlight) inFlight.resolve(null);
    });
  }

  isInFlight(): boolean { return this.inFlight !== null; }
  isDisabled(): boolean { return this.disabled; }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: SkillReply;
      try {
        msg = JSON.parse(line) as SkillReply;
      } catch (e) {
        log.warn("skill.bad_json", { skill: this.skill.name, line });
        continue;
      }
      const inFlight = this.inFlight;
      if (!inFlight) {
        log.warn("skill.unsolicited_reply", { skill: this.skill.name, tick_id: msg.tick_id });
        continue;
      }
      if (msg.tick_id !== inFlight.tick_id) {
        log.warn("skill.tick_id_mismatch", {
          skill: this.skill.name,
          expected: inFlight.tick_id,
          received: msg.tick_id,
        });
        continue;
      }
      this.inFlight = null;
      inFlight.resolve(msg);
    }
  }

  /** Send a tick and race its reply against the per-skill timeout. */
  async send(tick: Omit<TickPayload, "type" | "tick_id">): Promise<SendOutcome> {
    if (this.disabled) return { status: "crashed", error: "skill disabled", latency_ms: 0 };
    if (this.inFlight) {
      // Caller (scheduler) is responsible for the in-flight gate; if we get here it's a bug.
      return { status: "crashed", error: "in-flight gate violated", latency_ms: 0 };
    }
    if (!this.child) this.start();
    const child = this.child;
    if (!child) return { status: "crashed", error: "no child process", latency_ms: 0 };

    const tick_id = randomUUID();
    const payload: TickPayload = { type: "tick", tick_id, ...tick };
    const started = Date.now();
    const timeoutMs = Math.floor(this.skill.poll_interval_ms * this.skill.timeout_ratio);

    const replyPromise = new Promise<SkillReply | null>(resolve => {
      this.inFlight = { tick_id, resolve };
    });

    try {
      child.stdin.write(JSON.stringify(payload) + "\n");
    } catch (e) {
      this.inFlight = null;
      return { status: "crashed", error: String(e), latency_ms: 0 };
    }

    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<"timeout">(resolve => {
      timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
    });

    const winner = await Promise.race([replyPromise, timeoutPromise]);
    if (timeoutHandle) clearTimeout(timeoutHandle);

    const latency_ms = Date.now() - started;

    if (winner === "timeout") {
      this.inFlight = null;
      this.consecutiveTimeouts++;
      if (this.consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
        log.error("skill.auto_disabled", {
          skill: this.skill.name,
          consecutive_timeouts: this.consecutiveTimeouts,
        });
        this.disabled = true;
        this.stop();
      }
      return { status: "timeout", latency_ms };
    }

    if (winner === null) {
      this.consecutiveTimeouts++;
      return { status: "crashed", error: "child exited mid-tick", latency_ms };
    }

    this.consecutiveTimeouts = 0;
    if (winner.type === "intent")  return { status: "intent", reply: winner, latency_ms };
    if (winner.type === "noop")    return { status: "noop",   reply: winner, latency_ms };
    return { status: "crashed", error: `unknown reply type: ${winner.type}`, latency_ms };
  }

  stop(): void {
    if (this.child) {
      this.child.kill("SIGTERM");
      this.child = null;
    }
  }
}
