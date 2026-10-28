import type { Candle, ProductRules, Ticker } from "../types";

const DATA_URL = process.env.COINJAR_DATA_URL ?? "https://data.exchange.coinjar.com";
const TRADING_URL = process.env.COINJAR_TRADING_URL ?? "https://api.exchange.coinjar.com";

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, cache: "no-store" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`CoinJar ${init?.method ?? "GET"} ${new URL(url).pathname} -> ${res.status} ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

/** Public market data (no API key). */
export const coinjarData = {
  /**
   * Closed candles only: CoinJar includes the still-forming candle last, which
   * would make signals flicker, so it's dropped.
   */
  async candles(productId: string, interval: string, fromMs: number, toMs: number = Date.now()): Promise<Candle[]> {
    const url = `${DATA_URL}/products/${productId}/candles?interval=${interval}&after=${Math.floor(fromMs / 1000)}&before=${Math.floor(toMs / 1000)}`;
    const rows = await getJson<[string, string, string, string, string, string][]>(url);
    const candles = rows.map(([t, o, h, l, c, v]) => ({
      time: Date.parse(t),
      open: Number(o),
      high: Number(h),
      low: Number(l),
      close: Number(c),
      volume: Number(v),
    }));
    return candles.filter((c) => c.time + intervalMs(interval) <= toMs);
  },

  async ticker(productId: string): Promise<Ticker> {
    const t = await getJson<{ bid: string; ask: string; last: string; status: string }>(`${DATA_URL}/products/${productId}/ticker`);
    return { bid: Number(t.bid), ask: Number(t.ask), last: Number(t.last), status: t.status };
  },
};

export function intervalMs(interval: string): number {
  const m = /^(\d+)([mhd])$/.exec(interval);
  if (!m) throw new Error(`unsupported interval ${interval}`);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
  return Number(m[1]) * unit;
}

interface RawProduct {
  id: string;
  price_levels: { price_min: string; price_max: string; trade_size: string }[];
}

/** Trading rules (minimum size per price band) for each product. */
export async function fetchProductRules(): Promise<Map<string, ProductRules>> {
  const products = await getJson<RawProduct[]>(`${TRADING_URL}/products`);
  return new Map(products.map((p) => [p.id, rulesFromLevels(p)]));
}

export function rulesFromLevels(p: RawProduct): ProductRules {
  const levels = p.price_levels.map((l) => ({ min: Number(l.price_min), max: Number(l.price_max), size: Number(l.trade_size) }));
  return {
    id: p.id,
    sizeIncrementAt(price: number) {
      // Price bands have gaps at their edges (e.g. 999.9 -> 1000.0), so take the last band starting at or below the price.
      let size = levels[0]?.size ?? Infinity;
      for (const l of levels) if (price >= l.min) size = l.size;
      return size;
    },
  };
}

export interface CoinjarOrder {
  oid: number;
  type: "LMT" | "MKT" | "STL";
  product_id: string;
  side: "buy" | "sell";
  price: string | null;
  size: string;
  filled: string;
  status: string;
  timestamp: string;
}

interface CoinjarFill {
  oid: number;
  price: string;
  size: string;
  estimated_fee: string;
}

/** Authenticated trading API. Only used when TRADING_MODE=live. */
export class CoinjarTradingClient {
  constructor(private readonly apiKey: string) {}

  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return getJson<T>(`${TRADING_URL}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  accounts(): Promise<{ asset_code: string; available: string; balance: string }[]> {
    return this.request("GET", "/accounts");
  }

  marketOrder(productId: string, side: "buy" | "sell", size: number): Promise<CoinjarOrder> {
    return this.request("POST", "/orders", { product_id: productId, type: "MKT", side, size: String(size) });
  }

  /** Exchange-side stop-loss: sells as a limit order at `limitPrice` once the mark price falls to `triggerPrice`. */
  stopLimitSell(productId: string, size: number, triggerPrice: number, limitPrice: number): Promise<CoinjarOrder> {
    return this.request("POST", "/orders", {
      product_id: productId,
      type: "STL",
      side: "sell",
      size: String(size),
      trigger_price: String(triggerPrice),
      price: String(limitPrice),
      time_in_force: "GTC",
    });
  }

  order(oid: string): Promise<CoinjarOrder> {
    return this.request("GET", `/orders/${oid}`);
  }

  cancel(oid: string): Promise<unknown> {
    return this.request("DELETE", `/orders/${oid}`);
  }

  /** Volume-weighted fill price and fees for an order, from the most recent page of fills. */
  async fillsFor(oid: number): Promise<{ size: number; avgPrice: number; fee: number } | null> {
    const fills = (await this.request<CoinjarFill[]>("GET", "/fills")).filter((f) => f.oid === oid);
    if (fills.length === 0) return null;
    const size = fills.reduce((s, f) => s + Number(f.size), 0);
    const value = fills.reduce((s, f) => s + Number(f.size) * Number(f.price), 0);
    const fee = fills.reduce((s, f) => s + Number(f.estimated_fee), 0);
    return { size, avgPrice: value / size, fee };
  }
}
