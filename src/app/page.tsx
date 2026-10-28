import { RISK, STRATEGY } from "@/config/settings";
import { tradingMode } from "@/lib/bot";
import { goLiveCheck, tradeStats } from "@/lib/stats";
import { supabaseAdmin } from "@/lib/store/supabase";
import type { BotState } from "@/lib/types";
import { haltTrading, resumeTrading } from "./actions";

export const dynamic = "force-dynamic";

const money = (x: number) => `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(2)}`;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const when = (iso: string) => new Date(iso).toLocaleString("en-AU", { timeZone: "Australia/Sydney", dateStyle: "short", timeStyle: "short" });

interface TradeRow {
  product_id: string;
  size: number;
  entry_price: number;
  exit_price: number;
  closed_at: string;
  pnl: number;
  exit_reason: string;
  agents: string[];
  win_probability: number;
  jev_probability: number | null;
  exploration: boolean;
}

export default async function Dashboard() {
  const mode = tradingMode();
  const db = supabaseAdmin();
  const [stateRes, positionsRes, tradesRes, runsRes, briefRes] = await Promise.all([
    db.from("bot_state").select("data").eq("mode", mode).maybeSingle(),
    db.from("positions").select("*").eq("mode", mode).order("opened_at"),
    db.from("trades").select("*").eq("mode", mode).order("closed_at", { ascending: false }).limit(500),
    db.from("runs").select("*").eq("mode", mode).order("at", { ascending: false }).limit(12),
    db.from("knowledge_briefs").select("*").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const state = stateRes.data?.data as BotState | undefined;
  const positions = positionsRes.data ?? [];
  const trades = (tradesRes.data ?? []).map((t) => ({ ...t, pnl: Number(t.pnl), size: Number(t.size), entryPrice: Number(t.entry_price) })) as (TradeRow & { entryPrice: number })[];
  const runs = runsRes.data ?? [];
  const brief = briefRes.data;
  const latest = runs[0];

  const all = tradeStats(trades);
  const gated = tradeStats(trades.filter((t) => !t.exploration));
  const jevScored = trades.filter((t) => t.jev_probability !== null);
  const jevBrier = jevScored.length ? jevScored.reduce((s, t) => s + (Number(t.jev_probability) - (t.pnl > 0 ? 1 : 0)) ** 2, 0) / jevScored.length : null;
  const ownBrier = jevScored.length ? jevScored.reduce((s, t) => s + (Number(t.win_probability) - (t.pnl > 0 ? 1 : 0)) ** 2, 0) / jevScored.length : null;
  const gate = goLiveCheck(trades.filter((t) => !t.exploration));
  const stale = latest ? Date.now() - Date.parse(latest.at) > 20 * 60 * 1000 : true;

  return (
    <main>
      <h1>Trading bot</h1>
      <div className="muted">
        {mode === "live" ? <strong className="bad">LIVE trading</strong> : "Paper trading (simulated money)"} · CoinJar Exchange ·{" "}
        {STRATEGY.candleInterval} candles · {STRATEGY.products.join(", ")}
      </div>

      {state?.halted && <div className="banner bad">Halted: {state.haltReason}. No new trades until resumed.</div>}
      {stale && <div className="banner">No bot run in the last 20 minutes. Check the Supabase scheduler (supabase/scheduler.sql).</div>}
      {latest?.error && <div className="banner bad">Last run error: {latest.error}</div>}

      <div className="tiles">
        <Tile label="Equity" value={latest ? money(Number(latest.equity)) : "–"} />
        <Tile label="Cash" value={latest ? money(Number(latest.cash)) : "–"} />
        <Tile label="Total P/L" value={money(all.totalPnl)} tone={all.totalPnl >= 0 ? "good" : "bad"} />
        <Tile label="Win rate (all)" value={all.trades ? pct(all.winRate) : "–"} sub={`${all.trades} trades`} />
        <Tile label="Win rate (EV-gated)" value={gated.trades ? pct(gated.winRate) : "–"} sub={`${gated.trades} trades, target 65%`} />
        <Tile label="Avg win / loss" value={all.trades ? `${money(all.avgWin)} / ${money(all.avgLoss)}` : "–"} />
      </div>

      {mode === "paper" && (
        <div className="banner">
          <strong>Go-live check: {gate.ready ? "passed" : "not yet"}</strong>{" "}
          <span className="muted">· {gate.reason}</span>
        </div>
      )}

      <div className="actions">
        {state?.halted ? (
          <form action={resumeTrading}>
            <button type="submit">Resume trading</button>
          </form>
        ) : (
          <form action={haltTrading}>
            <button type="submit" className="danger">Halt new trades</button>
          </form>
        )}
      </div>

      <h2>Open positions ({positions.length}/{RISK.maxOpenPositions})</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Market</th><th className="num">Size</th><th className="num">Entry</th><th className="num">Stop</th><th className="num">Target</th><th className="num">p(win)</th><th>Agents</th><th>Opened</th>
            </tr>
          </thead>
          <tbody>
            {positions.length === 0 && (
              <tr><td colSpan={8} className="muted">None</td></tr>
            )}
            {positions.map((p) => (
              <tr key={p.id}>
                <td>{p.product_id}{p.exploration ? " *" : ""}</td>
                <td className="num">{Number(p.size)}</td>
                <td className="num">{Number(p.entry_price)}</td>
                <td className="num">{Number(p.stop_price).toFixed(4)}</td>
                <td className="num">{Number(p.take_profit_price).toFixed(4)}</td>
                <td className="num">{pct(Number(p.win_probability))}</td>
                <td>{p.agents.join(", ")}</td>
                <td>{when(p.opened_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Recent trades</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Closed</th><th>Market</th><th className="num">Entry</th><th className="num">Exit</th><th>Reason</th><th className="num">P/L</th><th className="num">p(win)</th><th className="num">JEV</th>
            </tr>
          </thead>
          <tbody>
            {trades.length === 0 && (
              <tr><td colSpan={8} className="muted">No trades yet</td></tr>
            )}
            {trades.slice(0, 30).map((t, i) => (
              <tr key={i}>
                <td>{when(t.closed_at)}</td>
                <td>{t.product_id}{t.exploration ? " *" : ""}</td>
                <td className="num">{Number(t.entry_price)}</td>
                <td className="num">{Number(t.exit_price)}</td>
                <td>{t.exit_reason.replace("_", " ")}</td>
                <td className={`num ${t.pnl > 0 ? "good" : "bad"}`}>{money(t.pnl)}</td>
                <td className="num">{pct(Number(t.win_probability))}</td>
                <td className="num">{t.jev_probability === null ? "–" : pct(Number(t.jev_probability))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">* paper exploration trade (taken to gather data, not because it passed the expected-value check)</p>

      <h2>JEV accuracy</h2>
      <p className="muted">
        {jevBrier === null
          ? "JEV not connected yet. Once it is, each trade records JEV's probability so we can check whether it predicts better than the bot's own estimate."
          : `Brier score (lower is better) over ${jevScored.length} trades: JEV ${jevBrier.toFixed(3)} vs bot ${ownBrier!.toFixed(3)}.`}
      </p>

      <h2>Research brief</h2>
      {brief ? (
        <div className="banner">
          <div className="muted">{when(brief.created_at)} · market bias {Number(brief.market_bias).toFixed(2)}{brief.pause_trading ? " · PAUSED" : ""}</div>
          <div>{brief.summary}</div>
        </div>
      ) : (
        <p className="muted">No brief yet. Ask Claude for a &ldquo;knowledge update&rdquo;.</p>
      )}

      <h2>Recent runs</h2>
      <div className="table-wrap">
        <table>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td>{when(r.at)}</td>
                <td className="num">{money(Number(r.equity))}</td>
                <td style={{ whiteSpace: "normal" }}>
                  {(r.actions as string[]).length ? (r.actions as string[]).join(" · ") : <span className="muted">no action</span>}
                  {r.error && <span className="bad"> · {r.error}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "bad" }) {
  return (
    <div className="tile">
      <div className="label">{label}</div>
      <div className={`value ${tone ?? ""}`}>{value}</div>
      {sub && <div className="label">{sub}</div>}
    </div>
  );
}
