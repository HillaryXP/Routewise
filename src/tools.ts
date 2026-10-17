import { z } from "zod/v4";
import { CURRENCIES, getHistory, getOfficialRates, getStreetRate } from "./data.js";

const currencyEnum = z.enum(CURRENCIES);

export const ratesInput = z.object({
  currency: currencyEnum.describe("Local currency to cash out into (ISO 4217)"),
});
export const routeInput = z.object({
  currency: currencyEnum.describe("Local currency to cash out into (ISO 4217)"),
  amount_usd: z.number().positive().max(1_000_000).describe("Amount of USDC/USD to convert"),
});
export const timingInput = z.object({
  currency: currencyEnum.describe("Local currency to cash out into (ISO 4217)"),
});

// All fees are ESTIMATES, labelled as such in every response. Tune per corridor.
const FEE_ASSUMPTIONS = {
  bank_offramp_pct: 1.5, // typical exchange/bank off-ramp spread + fee at the official rate
  p2p_haircut_pct: 0.3, // counterparty spread/slippage allowance when selling on P2P
};

const round = (n: number, d = 2) => Number(n.toFixed(d));

export async function rates(input: z.infer<typeof ratesInput>) {
  const official = await getOfficialRates();
  const officialRate = official.perUsd[input.currency];
  if (!officialRate) throw new Error(`No official rate for ${input.currency}`);
  const street = await getStreetRate(input.currency);
  const out: Record<string, unknown> = {
    currency: input.currency,
    official: { rate_per_usd: round(officialRate, 4), as_of: official.asOf, source: official.source },
  };
  if (street) {
    const gapPct = ((street.sellUsdtPrice - officialRate) / officialRate) * 100;
    out.street = {
      rate_per_usd: round(street.sellUsdtPrice, 4),
      source: street.source,
      ads_sampled: street.adsSampled,
    };
    out.spread_pct = round(gapPct, 2);
    out.headline =
      Math.abs(gapPct) < 0.5
        ? `Street and official rates are within ${round(Math.abs(gapPct), 2)}% for ${input.currency}.`
        : gapPct > 0
          ? `Street rate beats the official rate by ${round(gapPct, 2)}% for ${input.currency}.`
          : `Official rate beats the street rate by ${round(-gapPct, 2)}% for ${input.currency}.`;
  } else {
    out.street = null;
    out.headline = "Street rate unavailable right now; showing official rate only.";
  }
  return out;
}

export async function route(input: z.infer<typeof routeInput>) {
  const official = await getOfficialRates();
  const officialRate = official.perUsd[input.currency];
  if (!officialRate) throw new Error(`No official rate for ${input.currency}`);
  const street = await getStreetRate(input.currency);

  const options: {
    route: string;
    you_receive: number;
    effective_rate: number;
    est_fee_pct: number;
    note: string;
    estimate: true;
  }[] = [];

  const bankNet = input.amount_usd * officialRate * (1 - FEE_ASSUMPTIONS.bank_offramp_pct / 100);
  options.push({
    route: "Bank / exchange off-ramp (official rate)",
    you_receive: round(bankNet),
    effective_rate: round(bankNet / input.amount_usd, 4),
    est_fee_pct: FEE_ASSUMPTIONS.bank_offramp_pct,
    note: "Fast and simple. Priced at the official rate minus an estimated fee.",
    estimate: true,
  });

  if (street) {
    const p2pNet = input.amount_usd * street.sellUsdtPrice * (1 - FEE_ASSUMPTIONS.p2p_haircut_pct / 100);
    options.push({
      route: "P2P sell (street rate)",
      you_receive: round(p2pNet),
      effective_rate: round(p2pNet / input.amount_usd, 4),
      est_fee_pct: FEE_ASSUMPTIONS.p2p_haircut_pct,
      note: "Median of top buyer ads. Needs a counterparty; allow more time and verify the buyer.",
      estimate: true,
    });
  }

  options.sort((a, b) => b.you_receive - a.you_receive);
  const best = options[0];
  const worst = options[options.length - 1];
  const extra = best.you_receive - worst.you_receive;
  return {
    currency: input.currency,
    amount_usd: input.amount_usd,
    ranked: options,
    recommendation: best.route,
    advantage: options.length > 1
      ? `${best.route} nets you ${round(extra)} ${input.currency} more (${round((extra / worst.you_receive) * 100, 2)}%) than the next best route.`
      : "Only one route available right now (street rate unavailable).",
    warning: "Fees are estimates, not live execution quotes. Verify before sending funds.",
  };
}

export async function timing(input: z.infer<typeof timingInput>) {
  const hist = await getHistory(input.currency, 14);
  if (hist.length < 6) throw new Error(`Not enough history for ${input.currency}`);
  const official = await getOfficialRates();
  const current = official.perUsd[input.currency] ?? hist[hist.length - 1].rate;

  const rs = hist.map((h) => h.rate);
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  const sd = Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / rs.length) || 1e-9;
  const z = (current - mean) / sd;
  // Least-squares slope, as % of mean per day.
  const n = rs.length;
  const xm = (n - 1) / 2;
  const slope = rs.reduce((s, y, i) => s + (i - xm) * (y - mean), 0) / rs.reduce((s, _, i) => s + (i - xm) ** 2, 0);
  const slopePctDay = (slope / mean) * 100;

  // You SELL USDC for local currency, so a higher rate (more local per USD) is better for you.
  let action: "convert_now" | "consider_waiting";
  let reason: string;
  if (slopePctDay < -0.03) {
    action = "convert_now";
    reason = `${input.currency} is strengthening vs USD (${round(slopePctDay, 3)}%/day); each day waiting buys you less.`;
  } else if (slopePctDay > 0.05 && z < 1.5) {
    action = "consider_waiting";
    reason = `${input.currency} has been weakening vs USD (+${round(slopePctDay, 3)}%/day), so USDC buys more each day, but trends can reverse.`;
  } else {
    action = "convert_now";
    reason = "No clear trend; no strong reason to wait.";
  }
  return {
    currency: input.currency,
    action,
    reason,
    stats: {
      current_rate: round(current, 4),
      mean_14d: round(mean, 4),
      z_score: round(z, 2),
      trend_pct_per_day: round(slopePctDay, 3),
      days_of_history: n,
    },
    disclaimer: "Heuristic from 14 days of daily rates. Not financial advice.",
  };
}

export const TOOLS = [
  {
    name: "routewise_rates",
    description:
      "Official vs street (P2P) exchange rate for USD/USDC into a local currency, plus the spread. Supported: " +
      CURRENCIES.join(", "),
    schema: ratesInput,
    run: rates,
  },
  {
    name: "routewise_route",
    description:
      "Rank the ways to cash out an amount of USDC into a local currency by what you actually receive after estimated fees, with a recommendation.",
    schema: routeInput,
    run: route,
  },
  {
    name: "routewise_timing",
    description: "Should you convert USDC to a local currency now or wait? Heuristic trend and volatility read over 14 days.",
    schema: timingInput,
    run: timing,
  },
] as const;
