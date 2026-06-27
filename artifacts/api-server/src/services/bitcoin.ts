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

export interface TxOutput {
  valueSats: number;
  scriptHex: string;
  scripthash: string;
}

export function decodeRawTxOutputs(hex: string): TxOutput[] {
  const buf = Buffer.from(hex, "hex");
  let offset = 4; // skip version

  // segwit marker
  if (buf[offset] === 0x00) {
    offset += 2; // skip marker and flag
  }

  // inputs
  const [inCount, inCountLen] = readVarInt(buf, offset);
  offset += inCountLen;
  for (let i = 0; i < inCount; i++) {
    offset += 36; // prevhash + previndex
    const [scriptLen, scriptLenLen] = readVarInt(buf, offset);
    offset += scriptLenLen + scriptLen;
    offset += 4; // sequence
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
    const scripthash = toScripthash(script);
    outputs.push({ valueSats, scriptHex: script.toString("hex"), scripthash });
  }
  return outputs;
}
