"use server";

import { revalidatePath } from "next/cache";
import { tradingMode } from "@/lib/bot";
import { SupabaseStore, supabaseAdmin } from "@/lib/store/supabase";

/** Stops new trades immediately. Open positions keep their stop-losses. */
export async function haltTrading() {
  const store = new SupabaseStore(tradingMode());
  const state = await store.loadState(0);
  await store.saveState({ ...state, halted: true, haltReason: "halted from dashboard" });
  revalidatePath("/");
}

/** Resumes after a halt. Drawdown is measured from current equity, not the old peak. */
export async function resumeTrading() {
  const mode = tradingMode();
  const store = new SupabaseStore(mode);
  const state = await store.loadState(0);
  const { data } = await supabaseAdmin().from("runs").select("equity").eq("mode", mode).order("at", { ascending: false }).limit(1).maybeSingle();
  const equity = data ? Number(data.equity) : state.peakEquity;
  await store.saveState({ ...state, halted: false, haltReason: null, peakEquity: equity, dayStartEquity: equity });
  revalidatePath("/");
}
