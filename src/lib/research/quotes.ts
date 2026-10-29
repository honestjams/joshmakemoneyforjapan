import { MARKETS } from "@/config/settings";
import { coinjarData } from "../exchange/coinjar";
import { supabaseAdmin } from "../store/supabase";

/** CoinJar market -> Binance USDT market used as the global reference price. */
const REFERENCE: Record<string, string> = {
  BTCAUD: "BTCUSDT",
  ETHAUD: "ETHUSDT",
  SOLAUD: "SOLUSDT",
  XRPAUD: "XRPUSDT",
  "DOGE-AUD": "DOGEUSDT",
};

/**
 * Research data, not trading: saves CoinJar's bid/ask next to Binance's price
 * converted to AUD, every run. CoinJar keeps no quote history, and this is what
 * testing "CoinJar lags global prices" needs. Binance's main API blocks
 * Australian and US servers; its public data mirror doesn't.
 */
export async function recordQuotes(now = Date.now()): Promise<number> {
  const products = MARKETS.products.filter((p) => REFERENCE[p]);
  const symbols = encodeURIComponent(JSON.stringify(products.map((p) => REFERENCE[p])));
  const [coinjar, usdtAud, binance] = await Promise.all([
    Promise.all(products.map((p) => coinjarData.ticker(p))),
    coinjarData.ticker("USDT-AUD"),
    fetch(`https://data-api.binance.vision/api/v3/ticker/bookTicker?symbols=${symbols}`, { cache: "no-store" }).then(async (r) => {
      if (!r.ok) throw new Error(`binance ${r.status}`);
      return (await r.json()) as { symbol: string; bidPrice: string; askPrice: string }[];
    }),
  ]);
  const usdtToAud = (usdtAud.bid + usdtAud.ask) / 2;
  const bySymbol = new Map(binance.map((b) => [b.symbol, (Number(b.bidPrice) + Number(b.askPrice)) / 2]));
  const rows = products.map((p, i) => ({
    at: new Date(now).toISOString(),
    product_id: p,
    bid: coinjar[i].bid,
    ask: coinjar[i].ask,
    last: coinjar[i].last,
    reference_aud: (bySymbol.get(REFERENCE[p]) ?? NaN) * usdtToAud,
  }));
  const { error } = await supabaseAdmin().from("quotes").insert(rows);
  if (error) throw new Error(`supabase quotes: ${error.message}`);
  return rows.length;
}
