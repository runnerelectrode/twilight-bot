/**
 * Tiny DSL evaluator for v1 exit rules (plan §5.4).
 * Grammar: identifier paths, numeric literals, comparison ops, boolean and/or, parens.
 * No arithmetic, no function calls. Adding either requires a runtime version bump.
 */
type Node =
  | { kind: "lit"; value: number }
  | { kind: "ident"; path: string[] }
  | { kind: "binop"; op: "<" | "<=" | ">" | ">=" | "==" | "!="; l: Node; r: Node }
  | { kind: "and"; l: Node; r: Node }
  | { kind: "or";  l: Node; r: Node };

class Parser {
  private i = 0;
  constructor(private toks: string[]) {}
  parse(): Node { const n = this.parseOr(); if (this.i < this.toks.length) throw new Error(`unexpected: ${this.toks[this.i]}`); return n; }
  private peek(): string | undefined { return this.toks[this.i]; }
  private eat(): string { const t = this.toks[this.i++]; if (t === undefined) throw new Error("unexpected end"); return t; }
  private parseOr(): Node {
    let n = this.parseAnd();
    while (this.peek() === "or") { this.eat(); n = { kind: "or", l: n, r: this.parseAnd() }; }
    return n;
  }
  private parseAnd(): Node {
    let n = this.parseCmp();
    while (this.peek() === "and") { this.eat(); n = { kind: "and", l: n, r: this.parseCmp() }; }
    return n;
  }
  private parseCmp(): Node {
    const l = this.parseAtom();
    const op = this.peek();
    if (op === "<" || op === "<=" || op === ">" || op === ">=" || op === "==" || op === "!=") {
      this.eat();
      return { kind: "binop", op, l, r: this.parseAtom() };
    }
    return l;
  }
  private parseAtom(): Node {
    const t = this.eat();
    if (t === "(") { const n = this.parseOr(); if (this.eat() !== ")") throw new Error("missing )"); return n; }
    if (/^-?\d+(\.\d+)?$/.test(t)) return { kind: "lit", value: Number(t) };
    if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(t)) return { kind: "ident", path: t.split(".") };
    throw new Error(`bad token: ${t}`);
  }
}

function tokenize(src: string): string[] {
  const toks: string[] = [];
  const re = /\s*(<=|>=|==|!=|<|>|\(|\)|[A-Za-z_][A-Za-z0-9_.]*|-?\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  let lastEnd = 0;
  while ((m = re.exec(src)) !== null) {
    if (m.index !== lastEnd && src.slice(lastEnd, m.index).trim()) {
      throw new Error(`unexpected near: ${src.slice(lastEnd, m.index + 5)}`);
    }
    toks.push(m[1]!);
    lastEnd = re.lastIndex;
  }
  if (src.slice(lastEnd).trim()) throw new Error(`trailing: ${src.slice(lastEnd)}`);
  return toks;
}

function resolve(path: string[], env: Record<string, unknown>): number {
  let cur: unknown = env;
  for (const p of path) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return NaN;
    }
  }
  return typeof cur === "number" ? cur : NaN;
}

function evalNode(n: Node, env: Record<string, unknown>): boolean | number {
  switch (n.kind) {
    case "lit":   return n.value;
    case "ident": return resolve(n.path, env);
    case "binop": {
      const l = evalNode(n.l, env) as number;
      const r = evalNode(n.r, env) as number;
      switch (n.op) {
        case "<":  return l < r;
        case "<=": return l <= r;
        case ">":  return l > r;
        case ">=": return l >= r;
        case "==": return l === r;
        case "!=": return l !== r;
      }
    }
    case "and": return Boolean(evalNode(n.l, env)) && Boolean(evalNode(n.r, env));
    case "or":  return Boolean(evalNode(n.l, env)) || Boolean(evalNode(n.r, env));
  }
}

export function compile(expr: string): (env: Record<string, unknown>) => boolean {
  const ast = new Parser(tokenize(expr)).parse();
  return env => Boolean(evalNode(ast, env));
}

export interface ExitRule { if: string; do: string }

export interface DslMetrics {
  pnl: { unrealized_pct: number };
  funding_rates: {
    twilight: { rate: number };
    binance:  { rate: number };
    bybit:    { rate: number };
  };
  pool: { skew_pct: number };
  time_in_position_hours: number;
}

export interface DslDecision { fired: boolean; rule?: ExitRule; action?: string }

export function evaluate(rules: ExitRule[], metrics: DslMetrics): DslDecision {
  for (const r of rules) {
    let pred: (env: Record<string, unknown>) => boolean;
    try { pred = compile(r.if); }
    catch { continue; }
    if (pred(metrics as unknown as Record<string, unknown>)) {
      return { fired: true, rule: r, action: r.do };
    }
  }
  return { fired: false };
}
