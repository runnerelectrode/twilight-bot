import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export interface SkillConfig {
  name: string;
  version: string;
  enabled: boolean;
  poll_interval_ms: number;
  timeout_ratio: number;
  budget: number;
  slots: number;
  margin_per_slot: number;
  env: string[];
  dir: string;
  scanner_path: string;
}

interface RawRuntimeYaml {
  name?: string;
  version?: string;
  enabled?: boolean;
  poll_interval?: string | number;
  timeout_ratio?: number;
  budget?: number;
  slots?: number;
  margin_per_slot?: number;
  env?: string[];
}

function parseInterval(value: string | number | undefined): number {
  if (typeof value === "number") return value;
  if (!value) return 10_000;
  const m = /^(\d+)\s*(ms|s|m)?$/.exec(String(value).trim());
  if (!m) throw new Error(`invalid poll_interval: ${value}`);
  const n = parseInt(m[1]!, 10);
  switch (m[2] ?? "s") {
    case "ms": return n;
    case "s":  return n * 1000;
    case "m":  return n * 60_000;
    default:   throw new Error(`invalid poll_interval unit: ${value}`);
  }
}

export function loadSkills(skillsRoot: string): SkillConfig[] {
  if (!existsSync(skillsRoot)) {
    throw new Error(`skills directory not found: ${skillsRoot}`);
  }
  const out: SkillConfig[] = [];
  for (const entry of readdirSync(skillsRoot)) {
    const dir = join(skillsRoot, entry);
    if (!statSync(dir).isDirectory()) continue;
    const yamlPath = join(dir, "runtime.yaml");
    const scannerPath = join(dir, "scanner.py");
    if (!existsSync(yamlPath) || !existsSync(scannerPath)) continue;

    const raw = parseYaml(readFileSync(yamlPath, "utf-8")) as RawRuntimeYaml;
    if (!raw.name) throw new Error(`${yamlPath}: missing name`);
    if (!raw.version) throw new Error(`${yamlPath}: missing version`);
    out.push({
      name: raw.name,
      version: raw.version,
      enabled: raw.enabled === true,
      poll_interval_ms: parseInterval(raw.poll_interval),
      timeout_ratio: raw.timeout_ratio ?? 0.8,
      budget: raw.budget ?? 0,
      slots: raw.slots ?? 1,
      margin_per_slot: raw.margin_per_slot ?? 0,
      env: raw.env ?? [],
      dir,
      scanner_path: scannerPath,
    });
  }
  return out;
}

export function enforceSingleSkill(skills: SkillConfig[]): SkillConfig {
  const enabled = skills.filter(s => s.enabled);
  if (enabled.length === 0) {
    throw new Error(
      "no skill is enabled — exactly one skill must have `enabled: true` in its runtime.yaml (v1 single-skill rule, see plan §8)"
    );
  }
  if (enabled.length > 1) {
    const names = enabled.map(s => s.name).join(", ");
    throw new Error(
      `${enabled.length} skills are enabled (${names}) — v1 hard rule allows exactly one (plan §8). Multi-skill is v2.`
    );
  }
  return enabled[0]!;
}
