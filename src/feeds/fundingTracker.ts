import type { MarketSnapshot } from "./strategyApi.js";

export interface FundingSnapshot {
  twilight: { rate: number; nextFundingTime?: number };
  binance:  { rate: number; nextFundingTime?: number };
  bybit:    { rate: number; nextFundingTime?: number };
  capturedAt: number;
}

export function fundingFromMarket(m: MarketSnapshot): FundingSnapshot {
  return {
    twilight: { rate: m.fundingRates.twilight.rate },
    binance:  { rate: m.fundingRates.binance.rate,  nextFundingTime: m.fundingRates.binance.nextFundingTime },
    bybit:    { rate: m.fundingRates.bybit.rate,    nextFundingTime: m.fundingRates.bybit.nextFundingTime },
    capturedAt: Date.now(),
  };
}
