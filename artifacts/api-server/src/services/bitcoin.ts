import crypto from "crypto";
import { bech32, bech32m } from "bech32";
import bs58check from "bs58check";

function sha256(data: Buffer): Buffer {
  return crypto.createHash("sha256").update(data).digest();
}

function toScripthash(script: Buffer): string {
  const hash = sha256(script);
  return Buffer.from(hash).reverse().toString("hex");
}

export function addressToScripthash(address: string): string {
  // Try bech32 (P2WPKH, P2WSH — bc1q...)
  try {
    const decoded = bech32.decode(address, 90);
    if (decoded.prefix === "bc" || decoded.prefix === "tb") {
      const witnessVersion = decoded.words[0];
      const program = Buffer.from(bech32.fromWords(decoded.words.slice(1)));
      if (witnessVersion === 0) {
        let script: Buffer;
        if (program.length === 20) {
          script = Buffer.concat([Buffer.from([0x00, 0x14]), program]);
        } else if (program.length === 32) {
          script = Buffer.concat([Buffer.from([0x00, 0x20]), program]);
        } else {
          throw new Error("Invalid witness program length");
        }
        return toScripthash(script);
      }
    }
  } catch {
    // not bech32
  }

  // Try bech32m (P2TR — bc1p...)
  try {
    const decoded = bech32m.decode(address, 90);
    if (decoded.prefix === "bc" || decoded.prefix === "tb") {
      const witnessVersion = decoded.words[0];
      const program = Buffer.from(bech32m.fromWords(decoded.words.slice(1)));
      if (witnessVersion === 1 && program.length === 32) {
        const script = Buffer.concat([Buffer.from([0x51, 0x20]), program]);
        return toScripthash(script);
      }
    }
  } catch {
    // not bech32m
  }

  // Try Base58Check (P2PKH — 1xxx, P2SH — 3xxx)
  try {
    const decoded = bs58check.decode(address);
    const version = decoded[0];
    const hash = decoded.slice(1);
    let script: Buffer;
    if (version === 0x00) {
      // P2PKH: OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG
      script = Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), hash, Buffer.from([0x88, 0xac])]);
    } else if (version === 0x05) {
      // P2SH: OP_HASH160 <20 bytes> OP_EQUAL
      script = Buffer.concat([Buffer.from([0xa9, 0x14]), hash, Buffer.from([0x87])]);
    } else {
      throw new Error(`Unknown version byte: 0x${version.toString(16)}`);
    }
    return toScripthash(script);
  } catch {
    // not base58check
  }

  throw new Error(`Cannot parse Bitcoin address: "${address}"`);
}

export function validateBitcoinAddress(address: string): boolean {
  try {
    addressToScripthash(address);
    return true;
  } catch {
    return false;
  }
}

function readVarInt(buf: Buffer, offset: number): [number, number] {
  const first = buf[offset]!;
  if (first < 0xfd) return [first, 1];
  if (first === 0xfd) return [buf.readUInt16LE(offset + 1), 3];
  if (first === 0xfe) return [buf.readUInt32LE(offset + 1), 5];
  return [Number(buf.readBigUInt64LE(offset + 1)), 9];
}

export interface TxInput {
  prevhash: string;
  previndex: number;
}

export interface TxOutput {
  valueSats: number;
  scriptHex: string;
  scripthash: string;
}

/**
 * Decode inputs AND outputs from a raw transaction hex.
 * Works for legacy and segwit (marker/flag bytes detected automatically).
 */
export function decodeRawTx(hex: string): { inputs: TxInput[]; outputs: TxOutput[] } {
  const buf = Buffer.from(hex, "hex");
  let offset = 4; // skip version

  // segwit: marker=0x00, flag!=0x00
  if (buf[offset] === 0x00 && buf.length > offset + 1 && buf[offset + 1] !== 0x00) {
    offset += 2;
  }

  // inputs
  const [inCount, inCountLen] = readVarInt(buf, offset);
  offset += inCountLen;
  const inputs: TxInput[] = [];
  for (let i = 0; i < inCount; i++) {
    const prevhash = Buffer.from(buf.subarray(offset, offset + 32)).reverse().toString("hex");
    offset += 32;
    const previndex = buf.readUInt32LE(offset);
    offset += 4;
    const [scriptLen, scriptLenLen] = readVarInt(buf, offset);
    offset += scriptLenLen + scriptLen;
    offset += 4; // sequence
    inputs.push({ prevhash, previndex });
  }

  // outputs
  const [outCount, outCountLen] = readVarInt(buf, offset);
  offset += outCountLen;
  const outputs: TxOutput[] = [];
  for (let i = 0; i < outCount; i++) {
    const valueSats = Number(buf.readBigUInt64LE(offset));
    offset += 8;
    const [scriptLen, scriptLenLen] = readVarInt(buf, offset);
    offset += scriptLenLen;
    const script = buf.subarray(offset, offset + scriptLen);
    offset += scriptLen;
    outputs.push({ valueSats, scriptHex: script.toString("hex"), scripthash: toScripthash(script) });
  }
  return { inputs, outputs };
}

/** Kept for backward compatibility */
export function decodeRawTxOutputs(hex: string): TxOutput[] {
  return decodeRawTx(hex).outputs;
}
