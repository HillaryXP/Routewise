// Data layer: official FX, street/P2P rates, and FX history.
// Set ROUTEWISE_OFFLINE=1 to use clearly-labelled fixtures (for local testing without network).

export const CURRENCIES = ["NGN", "GHS", "KES", "ZAR", "ARS", "PHP", "INR", "BRL", "MXN"] as const;
export type Currency = (typeof CURRENCIES)[number];

const OFFLINE = process.env.ROUTEWISE_OFFLINE === "1";

const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

export type OfficialRates = { asOf: string; source: string; perUsd: Record<string, number> };

const FIXTURE_OFFICIAL: Record<string, number> = {
  NGN: 1331.19, GHS: 11.66, KES: 129.75, ZAR: 16.52, ARS: 1513.93, PHP: 63.08, INR: 95.1, BRL: 5.05, MXN: 18.46,
};
// Synthetic street premiums, used ONLY in offline fixture mode.
const FIXTURE_PREMIUM: Record<string, number> = {
  NGN: 1.03, GHS: 1.04, KES: 1.0, ZAR: 0.995, ARS: 1.08, PHP: 0.995, INR: 1.01, BRL: 0.995, MXN: 0.995,
};

export async function getOfficialRates(): Promise<OfficialRates> {
  if (OFFLINE) return { asOf: "fixture", source: "fixture", perUsd: FIXTURE_OFFICIAL };
  return cached("official", 5 * 60_000, async () => {
    const j = await fetchJson("https://open.er-api.com/v6/latest/USD");
    return { asOf: j.time_last_update_utc as string, source: "open.er-api.com", perUsd: j.rates as Record<string, number> };
  });
}

export type StreetRate = {
  currency: string;
  sellUsdtPrice: number; // local currency you receive per 1 USDT when selling to a P2P buyer
  adsSampled: number;
  source: string;
};

// Median of the top ads where merchants BUY USDT for local currency (i.e. you sell).
export async function getStreetRate(currency: string): Promise<StreetRate | null> {
  if (OFFLINE) {
    const off = FIXTURE_OFFICIAL[currency];
    if (!off) return null;
    return { currency, sellUsdtPrice: off * (FIXTURE_PREMIUM[currency] ?? 1), adsSampled: 0, source: "fixture" };
  }
  try {
    return await cached(`street:${currency}`, 60_000, async () => {
      const j = await fetchJson("https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fiat: currency, page: 1, rows: 10, tradeType: "SELL", asset: "USDT",
          countries: [], proMerchantAds: false, shieldMerchantAds: false, publisherType: null, payTypes: [],
        }),
      });
      const prices: number[] = (j?.data ?? []).map((a: any) => Number(a?.adv?.price)).filter((n: number) => n > 0);
      if (prices.length < 3) return null;
      prices.sort((a, b) => a - b);
      const mid = prices[Math.floor(prices.length / 2)];
      return { currency, sellUsdtPrice: mid, adsSampled: prices.length, source: "binance-p2p" };
    });
  } catch {
    return null; // caller degrades gracefully to official-only
  }
}

// Daily USD->currency closes for the last `days` days (oldest first). Skips days that fail.
export async function getHistory(currency: string, days = 14): Promise<{ date: string; rate: number }[]> {
  if (OFFLINE) {
    const base = FIXTURE_OFFICIAL[currency];
    if (!base) return [];
    return Array.from({ length: days }, (_, i) => {
      const d = new Date(Date.now() - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10);
      return { date: d, rate: base * (1 + Math.sin(i / 2.2) * 0.004 + (i - days / 2) * 0.0003) };
    });
  }
  return cached(`hist:${currency}:${days}`, 6 * 3_600_000, async () => {
    const key = currency.toLowerCase();
    const dates = Array.from({ length: days }, (_, i) =>
      new Date(Date.now() - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10));
    const rows = await Promise.all(dates.map(async (date) => {
      try {
        const j = await fetchJson(`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${date}/v1/currencies/usd.json`);
        const rate = Number(j?.usd?.[key]);
        return rate > 0 ? { date, rate } : null;
      } catch { return null; }
    }));
    return rows.filter((r): r is { date: string; rate: number } => r !== null);
  });
}
