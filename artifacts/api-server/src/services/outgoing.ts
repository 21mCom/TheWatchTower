import { decodeRawTx } from "./bitcoin.js";
import { logger } from "../lib/logger.js";

/**
 * Resolve the outgoing amount for a spend transaction by fetching each input's
 * previous output (prevout lookup) and summing values belonging to our scripthash.
 *
 * This is the core mechanism that gives outgoing transactions a non-zero amountSats.
 * For each input in the spending tx we fetch the previous tx, decode its outputs,
 * and add the value of the output at input.previndex if its scripthash matches ours.
 *
 * The `fetcher` parameter accepts any object with a `getTransaction` method so that
 * the function can be used both with a live ElectrumClient and with a test mock.
 */
export async function resolveOutgoingAmountSats(
  inputs: { prevhash: string; previndex: number }[],
  scripthash: string,
  fetcher: { getTransaction(txid: string): Promise<string> },
): Promise<number> {
  let spentSats = 0;
  for (const input of inputs) {
    try {
      const prevRaw = await fetcher.getTransaction(input.prevhash);
      const { outputs: prevOutputs } = decodeRawTx(prevRaw);
      const prevOut = prevOutputs[input.previndex];
      if (prevOut && prevOut.scripthash === scripthash) {
        spentSats += prevOut.valueSats;
        logger.debug(
          { prevhash: input.prevhash, previndex: input.previndex, valueSats: prevOut.valueSats },
          "[monitor] prevout matched — adding to outgoing amount",
        );
      }
    } catch (err) {
      logger.warn({ err, prevhash: input.prevhash }, "[monitor] prevout lookup failed");
    }
  }
  return spentSats;
}
