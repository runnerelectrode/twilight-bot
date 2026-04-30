export interface MarketSnapshot {
  prices: { twilight: number; binanceFutures: number; binanceMarkPrice?: number; bybit: number };
  fundingRates: {
    twilight: { rate: number; ratePct?: string; annualizedAPY?: string };
    binance:  { rate: number; ratePct?: string; annualizedAPY?: string; nextFundingTime?: number };
    bybit:    { rate: number; ratePct?: string; annualizedAPY?: string; nextFundingTime?: number };
  };
  spreads?: Record<string, { usd?: number; pct?: string }>;
  pool?: { currentSkew: number; currentSkewPct?: string; isLongHeavy?: boolean; isShortHeavy?: boolean };
  connections?: Record<string, unknown>;
}

export interface Strategy {
  id: number;
  name: string;
  description?: string;
  category: string;
  risk: string;
  twilightPosition: "LONG" | "SHORT" | null;
  twilightSize: number;
  twilightLeverage: number;
  binancePosition: "LONG" | "SHORT" | null;
  binanceSize: number;
  binanceLeverage: number;
  apy: number;
  dailyPnL?: number;
  monthlyPnL?: number;
  totalMargin?: number;
  totalMaxLoss?: number;
  monthlyFundingPnL?: number;
  twilightLiquidationPrice?: number | null;
  binanceLiquidationPrice?: number | null;
  marketDirection?: string;
  [key: string]: unknown;
}

export interface StrategiesResponse {
  count: number;
  timestamp: string;
  btcPrice: number;
  strategies: Strategy[];
}

export class StrategyApi {
  constructor(private base: string, private apiKey: string) {}

  private async get<T>(path: string): Promise<T> {
    const url = this.base.replace(/\/$/, "") + path;
    const res = await fetch(url, { headers: { "x-api-key": this.apiKey } });
    if (!res.ok) {
      throw new Error(`strategyApi ${path}: ${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<T>;
  }

  market(): Promise<MarketSnapshot> {
    return this.get<MarketSnapshot>("/api/market");
  }

  strategies(opts?: {
    category?: string; risk?: string; profitable?: boolean; minApy?: number; limit?: number;
  }): Promise<StrategiesResponse> {
    const q = new URLSearchParams();
    if (opts?.category)  q.set("category", opts.category);
    if (opts?.risk)      q.set("risk", opts.risk);
    if (opts?.profitable !== undefined) q.set("profitable", String(opts.profitable));
    if (opts?.minApy !== undefined)     q.set("minApy", String(opts.minApy));
    if (opts?.limit !== undefined)      q.set("limit", String(opts.limit));
    const qs = q.toString();
    return this.get<StrategiesResponse>("/api/strategies" + (qs ? `?${qs}` : ""));
  }

  health(): Promise<unknown> {
    return this.get<unknown>("/api/health");
  }
}
