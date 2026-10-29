import { liveGate, productionDeps, tradingMode } from "@/lib/bot";
import { runTick } from "@/lib/engine";
import { recordQuotes } from "@/lib/research/quotes";
import { authorizedCron } from "./auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Called every 5 minutes by Supabase pg_cron (see supabase/scheduler.sql). */
export async function POST(req: Request) {
  if (!authorizedCron(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    if (tradingMode() === "live") {
      const gate = await liveGate();
      if (!gate.ok) return Response.json({ error: `live trading blocked: ${gate.reason}` }, { status: 409 });
    }
    const result = await runTick(productionDeps());
    // Research data only: a failure here must never count against a trading run.
    await recordQuotes().catch((err) => console.warn("[tick] quote recording failed", err));
    return Response.json(result, { status: result.errors.length ? 207 : 200 });
  } catch (err) {
    console.error("[tick] failed", err);
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
