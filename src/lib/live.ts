import { GO_LIVE } from "@/config/settings";
import type { CoinjarTradingClient } from "./exchange/coinjar";

export interface KeyCheck {
  ok: boolean;
  problems: string[];
  scopes: string[];
  audAvailable: number | null;
}

/** Permissions a trading key must have, and ones that would let a leaked key move money off the exchange. */
const REQUIRED = ["read", "trade"];
const FORBIDDEN = ["transfer", "external_withdrawal"];

/** Checks the CoinJar key can trade, cannot withdraw or transfer, and reads the AUD balance. */
export async function checkCoinjarKey(client: CoinjarTradingClient): Promise<KeyCheck> {
  const problems: string[] = [];
  let scopes: string[] = [];
  try {
    const t = await client.tokenScope();
    scopes = t.scopes ?? [];
    if (t.scope === "allaccess") problems.push('key has "all access"; create one with trading permission only');
    for (const s of REQUIRED) if (!scopes.includes(s)) problems.push(`key is missing the "${s}" permission`);
    for (const s of FORBIDDEN) if (scopes.includes(s)) problems.push(`key has the "${s}" permission; create one without it`);
  } catch (err) {
    problems.push(`could not read key permissions: ${(err as Error).message}`);
  }
  let audAvailable: number | null = null;
  try {
    const aud = (await client.accounts()).find((a) => a.asset_code === "AUD");
    audAvailable = aud ? Number(aud.available) : 0;
  } catch (err) {
    problems.push(`could not read balances: ${(err as Error).message}`);
  }
  return { ok: problems.length === 0, problems, scopes, audAvailable };
}

export interface Readiness {
  ready: boolean;
  checks: { label: string; ok: boolean; detail: string }[];
}

/** The go-live checks (GO_LIVE in settings.ts), evaluated before the first live trade. */
export function liveReadiness(input: {
  now: number;
  paperRuns: { runs: number; errors: number };
  paperHalted: boolean;
  key: KeyCheck | null;
}): Readiness {
  const earliest = Date.parse(GO_LIVE.earliestLiveAt);
  const expectedRuns = GO_LIVE.healthWindowMs / (5 * 60 * 1000);
  const coverage = input.paperRuns.runs / expectedRuns;
  const errorRate = input.paperRuns.runs ? input.paperRuns.errors / input.paperRuns.runs : 1;
  const hours = GO_LIVE.healthWindowMs / 3_600_000;
  const checks = [
    {
      label: "Date",
      ok: input.now >= earliest,
      detail: `real money allowed from ${new Date(earliest).toLocaleString("en-AU", { timeZone: "Australia/Sydney", dateStyle: "medium", timeStyle: "short" })} Sydney time`,
    },
    {
      label: "Paper bot running",
      ok: coverage >= GO_LIVE.minRunCoverage,
      detail: `${input.paperRuns.runs} of ~${expectedRuns} expected runs in the last ${hours}h (need ${GO_LIVE.minRunCoverage * 100}%)`,
    },
    {
      label: "Paper bot error-free",
      ok: input.paperRuns.runs > 0 && errorRate <= GO_LIVE.maxErrorRate,
      detail: `${input.paperRuns.errors} runs with errors in the last ${hours}h (allowed ${GO_LIVE.maxErrorRate * 100}%)`,
    },
    { label: "Paper account not halted", ok: !input.paperHalted, detail: input.paperHalted ? "paper account is halted" : "ok" },
    {
      label: "CoinJar key",
      ok: input.key?.ok ?? false,
      detail: !input.key
        ? "COINJAR_API_KEY not set"
        : input.key.ok
          ? `trade-only key, $${input.key.audAvailable?.toFixed(2)} AUD available`
          : input.key.problems.join("; "),
    },
  ];
  return { ready: checks.every((c) => c.ok), checks };
}
