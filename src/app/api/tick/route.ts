import { timingSafeEqual } from "node:crypto";
import { productionDeps, tradingMode } from "@/lib/bot";
import { runTick } from "@/lib/engine";
import { goLiveCheck } from "@/lib/stats";
import { SupabaseStore } from "@/lib/store/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Called every 5 minutes by Supabase pg_cron (see supabase/scheduler.sql). */
export async function POST(req: Request) {
  if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    if (tradingMode() === "live") {
      const gate = goLiveCheck(await new SupabaseStore("paper").paperTrades());
      if (!gate.ready) return Response.json({ error: `live trading blocked: ${gate.reason}` }, { status: 409 });
    }
    const result = await runTick(productionDeps());
    return Response.json(result, { status: result.errors.length ? 207 : 200 });
  } catch (err) {
    console.error("[tick] failed", err);
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
