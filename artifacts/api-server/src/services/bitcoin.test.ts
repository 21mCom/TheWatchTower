import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeRawTx } from "./bitcoin.js";
import { resolveOutgoingAmountSats } from "./outgoing.js";

/**
 * Build a minimal raw legacy transaction hex for unit testing.
 * Layout: version(4) + inCount(varint) + inputs + outCount(varint) + outputs + locktime(4)
 * Each input: prevhash(32, LE) + previndex(4, LE) + scriptLen(0) + sequence(4)
 * Each output: value(8, LE) + scriptLen(varint) + script
 */
function buildRawTx(
  inputs: { txid: string; vout: number }[],
  outputs: { valueSats: number; script: Buffer }[],
): string {
  const parts: Buffer[] = [];

  const version = Buffer.alloc(4);
  version.writeUInt32LE(1, 0);
  parts.push(version);

  parts.push(Buffer.from([inputs.length]));
  for (const inp of inputs) {
    const txidBytes = Buffer.from(inp.txid, "hex");
    parts.push(Buffer.from(txidBytes).reverse());
    const idx = Buffer.alloc(4);
    idx.writeUInt32LE(inp.vout, 0);
    parts.push(idx);
    parts.push(Buffer.from([0x00]));
    parts.push(Buffer.from([0xff, 0xff, 0xff, 0xff]));
  }

  parts.push(Buffer.from([outputs.length]));
  for (const out of outputs) {
    const value = Buffer.alloc(8);
    value.writeBigUInt64LE(BigInt(out.valueSats), 0);
    parts.push(value);
    parts.push(Buffer.from([out.script.length]));
    parts.push(out.script);
  }

  parts.push(Buffer.alloc(4));
  return Buffer.concat(parts).toString("hex");
}

const P2WPKH_SCRIPT = Buffer.from("0014" + "ab".repeat(20), "hex");
const P2WPKH_SCRIPT2 = Buffer.from("0014" + "cd".repeat(20), "hex");

describe("decodeRawTx — input parsing for outgoing amount calculation", () => {
  it("extracts prevhash in display (big-endian) format", () => {
    const txid = "a".repeat(64);
    const hex = buildRawTx([{ txid, vout: 0 }], [{ valueSats: 10000, script: P2WPKH_SCRIPT }]);
    const { inputs } = decodeRawTx(hex);
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0]!.prevhash, txid);
  });

  it("extracts previndex correctly", () => {
    const txid = "bb".repeat(32);
    const hex = buildRawTx([{ txid, vout: 3 }], [{ valueSats: 5000, script: P2WPKH_SCRIPT }]);
    const { inputs } = decodeRawTx(hex);
    assert.equal(inputs[0]!.previndex, 3);
  });

  it("extracts output valueSats correctly", () => {
    const txid = "cc".repeat(32);
    const hex = buildRawTx(
      [{ txid, vout: 0 }],
      [
        { valueSats: 100000, script: P2WPKH_SCRIPT },
        { valueSats: 49000, script: P2WPKH_SCRIPT2 },
      ],
    );
    const { outputs } = decodeRawTx(hex);
    assert.equal(outputs.length, 2);
    assert.equal(outputs[0]!.valueSats, 100000);
    assert.equal(outputs[1]!.valueSats, 49000);
  });

  it("handles multiple inputs — each gets its own prevhash and previndex", () => {
    const txid1 = "11".repeat(32);
    const txid2 = "22".repeat(32);
    const hex = buildRawTx(
      [
        { txid: txid1, vout: 0 },
        { txid: txid2, vout: 1 },
      ],
      [{ valueSats: 200000, script: P2WPKH_SCRIPT }],
    );
    const { inputs } = decodeRawTx(hex);
    assert.equal(inputs.length, 2);
    assert.equal(inputs[0]!.prevhash, txid1);
    assert.equal(inputs[0]!.previndex, 0);
    assert.equal(inputs[1]!.prevhash, txid2);
    assert.equal(inputs[1]!.previndex, 1);
  });

  it("previndex lookup into prevout outputs gives the correct satoshi value — the core of outgoing amount", () => {
    // Simulate exactly what monitor.ts does for outgoing transactions:
    //   const prevRaw = await client.getTransaction(input.prevhash);
    //   const { outputs: prevOutputs } = decodeRawTx(prevRaw);
    //   const prevOut = prevOutputs[input.previndex];
    //   if (prevOut && prevOut.scripthash === scripthash) spentSats += prevOut.valueSats;
    const prevTxid = "dd".repeat(32);
    const changeOutput = { valueSats: 24000, script: P2WPKH_SCRIPT2 };
    const spentOutput = { valueSats: 75000, script: P2WPKH_SCRIPT };

    // Previous tx: changeOutput at index 0, spentOutput at index 1.
    // A dummy coinbase-like input is included so inCount != 0 (avoids false segwit detection).
    const prevTxHex = buildRawTx([{ txid: "00".repeat(32), vout: 0xffffffff }], [changeOutput, spentOutput]);
    const { outputs: prevOutputs } = decodeRawTx(prevTxHex);

    // Spending tx references prevout at index 1 (the spentOutput)
    const spendTxHex = buildRawTx(
      [{ txid: prevTxid, vout: 1 }],
      [{ valueSats: 74500, script: P2WPKH_SCRIPT2 }],
    );
    const { inputs } = decodeRawTx(spendTxHex);

    const previndex = inputs[0]!.previndex;
    const prevOut = prevOutputs[previndex];
    assert.ok(prevOut, "prevOut at previndex should exist");
    assert.equal(prevOut.valueSats, 75000, "valueSats from prevout lookup must equal the spent output");
    assert.equal(prevOut.scripthash, prevOutputs[1]!.scripthash, "scripthash at previndex matches the spent output's scripthash");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// resolveOutgoingAmountSats — integration of prevout lookup + scripthash match
// ──────────────────────────────────────────────────────────────────────────────

describe("resolveOutgoingAmountSats — outgoing amount via prevout lookup", () => {
  it("returns the sum of prevout values matching our scripthash", async () => {
    // Build a previous tx that paid 150000 sats to our watched address at output index 0
    const prevScript = Buffer.from("0014" + "751e76e8199196f454f032d4f736e6a5b99e3f44", "hex"); // bc1qw508... witness program
    const prevTxHex = buildRawTx(
      [{ txid: "aa".repeat(32), vout: 0 }],
      [{ valueSats: 150000, script: prevScript }],
    );
    const { outputs: prevOutputs } = decodeRawTx(prevTxHex);
    const watchedScripthash = prevOutputs[0]!.scripthash;

    // The prevTxid is what the spending tx references
    const prevTxid = "ee".repeat(32);

    // Spending tx: one input referencing prevout index 0
    const spendTxHex = buildRawTx(
      [{ txid: prevTxid, vout: 0 }],
      [{ valueSats: 149000, script: Buffer.from("0014" + "cd".repeat(20), "hex") }],
    );
    const { inputs } = decodeRawTx(spendTxHex);

    // Mock fetcher: returns the previous tx hex for any txid
    const mockFetcher = {
      getTransaction: async (_txid: string) => prevTxHex,
    };

    const amount = await resolveOutgoingAmountSats(inputs, watchedScripthash, mockFetcher);
    assert.equal(amount, 150000, "should sum the value from the matched prevout");
  });

  it("returns 0 when no prevouts match our scripthash", async () => {
    const unrelatedScript = Buffer.from("0014" + "ff".repeat(20), "hex");
    const prevTxHex = buildRawTx(
      [{ txid: "11".repeat(32), vout: 0 }],
      [{ valueSats: 200000, script: unrelatedScript }],
    );
    const { outputs: prevOutputs } = decodeRawTx(prevTxHex);
    const unrelatedScripthash = prevOutputs[0]!.scripthash;
    const differentScripthash = "aa".repeat(32); // not the same

    const { inputs } = decodeRawTx(buildRawTx(
      [{ txid: "22".repeat(32), vout: 0 }],
      [{ valueSats: 199000, script: unrelatedScript }],
    ));

    const mockFetcher = { getTransaction: async () => prevTxHex };
    const amount = await resolveOutgoingAmountSats(inputs, differentScripthash, mockFetcher);
    assert.equal(amount, 0, "should return 0 when prevout scripthash does not match");
  });

  it("sums across multiple inputs that each match our scripthash", async () => {
    const watchedScript = Buffer.from("0014" + "ab".repeat(20), "hex");
    const prevTx1Hex = buildRawTx(
      [{ txid: "11".repeat(32), vout: 0 }],
      [{ valueSats: 60000, script: watchedScript }],
    );
    const prevTx2Hex = buildRawTx(
      [{ txid: "22".repeat(32), vout: 0 }],
      [{ valueSats: 40000, script: watchedScript }],
    );
    const { outputs: outs1 } = decodeRawTx(prevTx1Hex);
    const watchedScripthash = outs1[0]!.scripthash;

    const spendTxHex = buildRawTx(
      [
        { txid: "33".repeat(32), vout: 0 },
        { txid: "44".repeat(32), vout: 0 },
      ],
      [{ valueSats: 99000, script: Buffer.from("0014" + "cd".repeat(20), "hex") }],
    );
    const { inputs } = decodeRawTx(spendTxHex);

    const prevTxs: Record<string, string> = {
      ["33".repeat(32)]: prevTx1Hex,
      ["44".repeat(32)]: prevTx2Hex,
    };
    const mockFetcher = { getTransaction: async (txid: string) => prevTxs[txid]! };

    const amount = await resolveOutgoingAmountSats(inputs, watchedScripthash, mockFetcher);
    assert.equal(amount, 100000, "should sum values from all matching prevouts: 60000 + 40000");
  });

  it("skips inputs where fetcher throws and continues with the rest", async () => {
    const watchedScript = Buffer.from("0014" + "ab".repeat(20), "hex");
    const goodPrevTxHex = buildRawTx(
      [{ txid: "55".repeat(32), vout: 0 }],
      [{ valueSats: 80000, script: watchedScript }],
    );
    const { outputs: outs } = decodeRawTx(goodPrevTxHex);
    const watchedScripthash = outs[0]!.scripthash;

    const spendTxHex = buildRawTx(
      [
        { txid: "66".repeat(32), vout: 0 }, // will fail
        { txid: "77".repeat(32), vout: 0 }, // will succeed
      ],
      [{ valueSats: 79000, script: Buffer.from("0014" + "cd".repeat(20), "hex") }],
    );
    const { inputs } = decodeRawTx(spendTxHex);

    let callCount = 0;
    const mockFetcher = {
      getTransaction: async (_txid: string) => {
        callCount++;
        if (callCount === 1) throw new Error("network error");
        return goodPrevTxHex;
      },
    };

    const amount = await resolveOutgoingAmountSats(inputs, watchedScripthash, mockFetcher);
    assert.equal(amount, 80000, "should skip the failed input and sum the successful one");
  });
});
