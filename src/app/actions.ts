"use server";

import { revalidatePath } from "next/cache";
import { productionDeps, tradingMode } from "@/lib/bot";
import { liquidateAll, withRunLock } from "@/lib/engine";
import { SupabaseStore, supabaseAdmin } from "@/lib/store/supabase";

function currentStore() {
  const mode = tradingMode();
  // A paper account that hasn't run yet must start with its paper balance, not $0.
  const initialCash = mode === "paper" ? Number(process.env.PAPER_STARTING_BALANCE ?? "500") : 0;
  return { mode, store: new SupabaseStore(mode), initialCash };
}

/** Stops new trades immediately. Open positions keep their stop-losses. */
export async function haltTrading() {
  const { store, initialCash } = currentStore();
  await withRunLock(store, async () => {
    const state = await store.loadState(initialCash);
    await store.saveState({ ...state, halted: true, haltReason: "halted from dashboard" });
  });
  revalidatePath("/");
}

/** Resumes after a halt. Drawdown is measured from current equity, not the old peak. */
export async function resumeTrading() {
  const { mode, store, initialCash } = currentStore();
  await withRunLock(store, async () => {
    const state = await store.loadState(initialCash);
    const { data } = await supabaseAdmin().from("runs").select("equity").eq("mode", mode).order("at", { ascending: false }).limit(1).maybeSingle();
    const equity = data ? Number(data.equity) : state.peakEquity;
    await store.saveState({ ...state, halted: false, haltReason: null, peakEquity: equity, dayStartEquity: equity });
  });
  revalidatePath("/");
}

/** Sells every open position at market and halts. Needs the confirmation box ticked. */
export async function liquidateEverything(form: FormData) {
  if (form.get("confirm") !== "yes") return;
  await liquidateAll(productionDeps(), "sell-everything button on the dashboard");
  revalidatePath("/");
}
