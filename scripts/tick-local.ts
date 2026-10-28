/**
 * One bot cycle against live CoinJar prices with a throwaway paper account,
 * no database needed. Good for checking the pipeline end to end:
 *
 *   npm run tick:local
 */
import { coinjarMarket, baseCalibration } from "../src/lib/bot";
import { runTick } from "../src/lib/engine";
import { JevDecisionModel } from "../src/lib/agents/jev";
import { PaperBroker } from "../src/lib/exchange/broker";
import { MemoryStore } from "../src/lib/store/store";

async function main() {
  const result = await runTick({
    store: new MemoryStore(),
    createBroker: (s) => new PaperBroker(s),
    market: coinjarMarket,
    decisionModel: new JevDecisionModel(),
    baseCalibration,
    initialCash: Number(process.env.PAPER_STARTING_BALANCE ?? "500"),
    explore: process.env.PAPER_EXPLORATION !== "false",
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
