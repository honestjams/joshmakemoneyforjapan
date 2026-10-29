import { readinessReport } from "@/lib/bot";
import { authorizedCron } from "../tick/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The go-live checklist as JSON (key permissions and AUD balance, never the
 * key itself). Same CRON_SECRET as /api/tick, so it can be checked from
 * Supabase without opening the dashboard.
 */
export async function POST(req: Request) {
  if (!authorizedCron(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    return Response.json(await readinessReport());
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
