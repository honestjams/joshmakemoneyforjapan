/** Cached historical candles for research scripts (cache lives in data-cache/, gitignored). */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { coinjarData } from "../../src/lib/exchange/coinjar";
import type { Candle } from "../../src/lib/types";

const CACHE = "data-cache";

async function cached(key: string, load: () => Promise<Candle[]>): Promise<Candle[]> {
  mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, `${key}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const data = await load();
  writeFileSync(file, JSON.stringify(data));
  return data;
}

const DAY = 86_400_000;

/** CoinJar candles, fetched in yearly chunks. `day` = UTC date string used as a cache key. */
export function coinjarHistory(productId: string, interval: string, days: number): Promise<Candle[]> {
  const today = new Date().toISOString().slice(0, 10);
  return cached(`coinjar-${productId}-${interval}-${days}d-${today}`, async () => {
    const end = Date.now();
    const out: Candle[] = [];
    for (let from = end - days * DAY; from < end; from += 365 * DAY) {
      const to = Math.min(end, from + 365 * DAY);
      const chunk = await coinjarData.candles(productId, interval, from, to);
      for (const c of chunk) if (!out.length || c.time > out[out.length - 1].time) out.push(c);
    }
    return out;
  });
}

/** Binance spot klines via the public data mirror (api.binance.com blocks US/AU cloud IPs). */
export function binanceHistory(symbol: string, interval: string, days: number): Promise<Candle[]> {
  const today = new Date().toISOString().slice(0, 10);
  return cached(`binance-${symbol}-${interval}-${days}d-${today}`, async () => {
    const out: Candle[] = [];
    let start = Date.now() - days * DAY;
    for (;;) {
      const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${start}&limit=1000`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`binance ${res.status}`);
      const rows = (await res.json()) as [number, string, string, string, string, string][];
      if (!rows.length) break;
      for (const r of rows) out.push({ time: r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] });
      start = rows[rows.length - 1][0] + 1;
      if (rows.length < 1000) break;
    }
    return out;
  });
}
