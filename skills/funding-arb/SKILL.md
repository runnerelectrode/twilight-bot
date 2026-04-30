# funding-arb

**Thesis.** When Twilight's funding rate is high-positive while at least one CEX
is funding-negative, longs on Twilight are paid; shorts on the negative-funding
CEX are paid. Going long Twilight while short-hedging on the CEX captures both
funding payments while staying delta-neutral on price.

**Inputs.** From the per-tick payload (`market`, `strategies`):
- `market.fundingRates.{twilight,binance,bybit}.rate`
- `market.pool.currentSkew` (Twilight pool skew — too long-heavy = unwind risk)
- `strategies` filtered to `category in ("Funding Arb","Delta-Neutral")` and
  `risk` in `{LOW,MEDIUM}`, ranked by `apy`.

**Entry rule.**
- `funding_rates.twilight.rate` > 0
- `funding_rates.binance.rate` < 0 OR `funding_rates.bybit.rate` < 0
- `pool.currentSkew` < 0.85
- Top-ranked surviving strategy `apy` ≥ `MIN_APY` (default 50)
- No existing open position belonging to this skill.

**Three-leg construction (plan §5.1).** Strategy API templates are two-leg
(Twilight + one CEX). This skill splits the modeled CEX hedge across Binance
and Bybit weighted by `|funding_rate|` (the more-negative venue carries more
of the short leg), capped at 70/30.

**Exit rules (DSL).** Standard funding-arb exits — see `skill_sdk.dsl.standard_funding_arb_exits()`.

**Tunables (env, with defaults).**
- `FUNDING_ARB_MIN_APY=50`
- `FUNDING_ARB_NOTIONAL_USD=100`
- `FUNDING_ARB_LEVERAGE=5`
