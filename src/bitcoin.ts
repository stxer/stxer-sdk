/**
 * Bitcoin SPV utilities for cross-chain simulations.
 *
 * Stacks bridge contracts (sBTC, Brotocol, hBTC, …) verify Bitcoin
 * deposit transactions against burn-block headers and Merkle proofs
 * stored in the Stacks chainstate. To exercise these contracts under
 * the simulator you need three things on the wire:
 *
 * 1. A non-witness Bitcoin transaction whose `txid` (= `sha256d` of
 *    the bytes) the Stacks contract can recover.
 * 2. An 80-byte block header whose hash matches the
 *    `BurnchainHeaderHash` value the simulator stores. The simulator
 *    accepts any 32-byte hash via the `burn_header_hashes` override
 *    on `AdvanceBlocks`; pair the override with `buildHeader` so the
 *    contract's `verify-block-header` resolves to the same value.
 * 3. A Merkle proof linking the txid to the block header's
 *    `merkleRoot`. {@link merkleProof} produces the proof; the
 *    contract's on-chain verifier follows the same Bitcoin
 *    convention this module implements (leaves are NOT pre-hashed;
 *    `sha256d` of concatenated children for inner nodes).
 *
 * All wire-byte conventions match `clarity-bitcoin-v1-07` (the
 * current on-chain SPV reference): hash slots inside the header are
 * stored in *internal byte order* (raw `sha256d`), not the
 * display-reversed form Bitcoin block explorers show.
 *
 * @example
 * ```typescript
 * import {
 *   forgeBitcoinTx, p2wpkhScript, opReturnScript,
 *   buildBitcoinHeader, singleTxMerkleRoot,
 *   hexToBytes, bytesToHex,
 * } from 'stxer';
 *
 * const tx = forgeBitcoinTx({
 *   inputs: [{ prevTxid: hexToBytes('00'.repeat(32)), prevVout: 0,
 *              scriptSig: new Uint8Array() }],
 *   outputs: [
 *     { value: 100_000n, scriptPubKey: p2wpkhScript(hexToBytes('aa'.repeat(20))) },
 *     { value: 0n, scriptPubKey: opReturnScript(hexToBytes('5832' + '00'.repeat(20))) },
 *   ],
 * });
 * const header = buildBitcoinHeader({
 *   merkleRoot: singleTxMerkleRoot(tx.txid),
 * });
 * // Pass `bytesToHex(header.hash)` as `burn_header_hashes[0]` on
 * // `addAdvanceBlocks`; pass `bytesToHex(tx.txid)` to the bridge's
 * // `complete-deposit-wrapper` (or equivalent).
 * ```
 */
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';

// ============================================================================
// Hashing primitives
// ============================================================================

/**
 * SHA-256. Pure-JS via `@noble/hashes` so this module works in
 * browsers, Node, and Bun without a polyfill.
 */
export function sha256(data: Uint8Array): Uint8Array {
  return nobleSha256(data);
}

/** Bitcoin-style double-sha256 used for txids, block hashes, and Merkle nodes. */
export function sha256d(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

// ============================================================================
// Hex encoding
// ============================================================================

/** Decode a hex string (with or without `0x` prefix). */
export function hexToBytes(s: string): Uint8Array {
  const t = s.toLowerCase().replace(/^0x/, '');
  if (t.length % 2 !== 0) throw new Error('odd-length hex');
  const out = new Uint8Array(t.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(t.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Lower-case hex (no `0x` prefix). */
export function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

// ============================================================================
// Bitcoin script builders
// ============================================================================

/** P2WPKH output script: `OP_0 <20-byte pubkey-hash>`. */
export function p2wpkhScript(pubKeyHash20: Uint8Array): Uint8Array {
  if (pubKeyHash20.length !== 20) {
    throw new Error('pubKeyHash must be 20 bytes');
  }
  const out = new Uint8Array(22);
  out[0] = 0x00; // OP_0
  out[1] = 0x14; // pushdata length 20
  out.set(pubKeyHash20, 2);
  return out;
}

/** P2PKH output script: `OP_DUP OP_HASH160 <hash> OP_EQUALVERIFY OP_CHECKSIG`. */
export function p2pkhScript(pubKeyHash20: Uint8Array): Uint8Array {
  if (pubKeyHash20.length !== 20) {
    throw new Error('pubKeyHash must be 20 bytes');
  }
  const out = new Uint8Array(25);
  out[0] = 0x76; // OP_DUP
  out[1] = 0xa9; // OP_HASH160
  out[2] = 0x14; // pushdata 20
  out.set(pubKeyHash20, 3);
  out[23] = 0x88; // OP_EQUALVERIFY
  out[24] = 0xac; // OP_CHECKSIG
  return out;
}

/**
 * `OP_RETURN <data>` output. Used to embed peg-in metadata
 * (recipient principal, marker bytes, etc.). Bitcoin's standard relay
 * limit caps `data` at 80 bytes; this helper rejects > 75 to leave
 * room for the prefix bytes.
 */
export function opReturnScript(data: Uint8Array): Uint8Array {
  if (data.length > 75) {
    throw new Error(`OP_RETURN data too long: ${data.length}`);
  }
  const out = new Uint8Array(2 + data.length);
  out[0] = 0x6a; // OP_RETURN
  out[1] = data.length; // direct push
  out.set(data, 2);
  return out;
}

// ============================================================================
// Bitcoin transaction forging
// ============================================================================

export interface BitcoinTxInput {
  /** 32-byte previous txid in *internal byte order* (raw `sha256d`). */
  prevTxid: Uint8Array;
  prevVout: number;
  /** Script signature bytes. Empty for segwit-style inputs. */
  scriptSig: Uint8Array;
  /** Sequence number; default `0xfffffffd`. */
  sequence?: number;
}

export interface BitcoinTxOutput {
  /** Satoshi amount. */
  value: bigint;
  /** Locking script — use {@link p2wpkhScript} / {@link p2pkhScript} / {@link opReturnScript}. */
  scriptPubKey: Uint8Array;
}

export interface ForgedBitcoinTx {
  /** Wire-encoded non-witness tx bytes (this is what the txid is computed over). */
  bytes: Uint8Array;
  /** Canonical txid: `sha256d(bytes)`. Internal byte order. */
  txid: Uint8Array;
  /** Display-form (reversed) txid — what block explorers render. */
  txidDisplay: Uint8Array;
}

/**
 * Build a non-witness Bitcoin transaction (legacy serialization). The
 * txid is `sha256d` of the returned `bytes`. Use this form when you
 * only need to assert SPV inclusion; segwit witness data is irrelevant
 * to the txid.
 *
 * Wire format:
 * ```
 *   4  version (LE)
 *   varint  in-count
 *   per-input: 32 prev_txid + 4 prev_vout + varint script-len + script + 4 sequence
 *   varint  out-count
 *   per-output: 8 value (LE) + varint script-len + script
 *   4  locktime (LE)
 * ```
 */
export function forgeBitcoinTx(opts: {
  version?: number;
  inputs: BitcoinTxInput[];
  outputs: BitcoinTxOutput[];
  locktime?: number;
}): ForgedBitcoinTx {
  const chunks: Uint8Array[] = [];
  const u32le = (n: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n >>> 0, true);
    return b;
  };
  const u64le = (n: bigint) => {
    const b = new Uint8Array(8);
    const view = new DataView(b.buffer);
    view.setUint32(0, Number(n & 0xffffffffn), true);
    view.setUint32(4, Number((n >> 32n) & 0xffffffffn), true);
    return b;
  };
  const varint = (n: number): Uint8Array => {
    if (n < 0xfd) return new Uint8Array([n]);
    if (n <= 0xffff) {
      const b = new Uint8Array(3);
      b[0] = 0xfd;
      new DataView(b.buffer).setUint16(1, n, true);
      return b;
    }
    if (n <= 0xffffffff) {
      const b = new Uint8Array(5);
      b[0] = 0xfe;
      new DataView(b.buffer).setUint32(1, n, true);
      return b;
    }
    throw new Error(`varint too large: ${n}`);
  };

  chunks.push(u32le(opts.version ?? 2));
  chunks.push(varint(opts.inputs.length));
  for (const i of opts.inputs) {
    if (i.prevTxid.length !== 32) {
      throw new Error('prevTxid must be 32 bytes');
    }
    chunks.push(i.prevTxid);
    chunks.push(u32le(i.prevVout));
    chunks.push(varint(i.scriptSig.length));
    chunks.push(i.scriptSig);
    chunks.push(u32le(i.sequence ?? 0xfffffffd));
  }
  chunks.push(varint(opts.outputs.length));
  for (const o of opts.outputs) {
    chunks.push(u64le(o.value));
    chunks.push(varint(o.scriptPubKey.length));
    chunks.push(o.scriptPubKey);
  }
  chunks.push(u32le(opts.locktime ?? 0));

  const total = chunks.reduce((s, c) => s + c.length, 0);
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.length;
  }
  const txid = sha256d(bytes);
  const txidDisplay = reverseBytes(txid);
  return { bytes, txid, txidDisplay };
}

// ============================================================================
// Bitcoin block header
// ============================================================================

export interface BitcoinHeader {
  version: number;
  prevHash: Uint8Array;
  merkleRoot: Uint8Array;
  timestamp: number;
  bits: number;
  nonce: number;
}

export interface BuiltBitcoinHeader {
  /** Raw 80-byte serialized header. */
  header: Uint8Array;
  /**
   * Display-form hash (`reverse(sha256d(header))`) — what the Stacks
   * chainstate stores as `BurnchainHeaderHash`. Pass this as the
   * `burn_header_hashes[i]` override on `addAdvanceBlocks`.
   */
  hash: Uint8Array;
  /** Raw `sha256d(header)` (internal byte order). */
  rawHash: Uint8Array;
}

/**
 * Build an 80-byte Bitcoin block header. `prevHash` and `merkleRoot`
 * are written in internal byte order (raw `sha256d` output) — matching
 * the on-chain `clarity-bitcoin-v1-07` parser convention.
 */
export function buildBitcoinHeader(
  h: Partial<BitcoinHeader> & { merkleRoot: Uint8Array },
): BuiltBitcoinHeader {
  const out = new Uint8Array(80);
  const view = new DataView(out.buffer);
  view.setUint32(0, h.version ?? 0x20000000, true);
  out.set(h.prevHash ?? new Uint8Array(32), 4);
  out.set(h.merkleRoot, 36);
  view.setUint32(68, h.timestamp ?? Math.floor(Date.now() / 1000), true);
  view.setUint32(72, h.bits ?? 0x1d00ffff, true);
  view.setUint32(76, h.nonce ?? 0, true);
  const rawHash = sha256d(out);
  return { header: out, hash: reverseBytes(rawHash), rawHash };
}

// ============================================================================
// Merkle proofs (Bitcoin convention)
// ============================================================================

/**
 * Single-tx Merkle root — the txid itself. Bitcoin's Merkle tree
 * convention does NOT pre-hash the leaves; for a one-tx block the
 * root equals the txid.
 */
export function singleTxMerkleRoot(txid: Uint8Array): Uint8Array {
  return new Uint8Array(txid);
}

/**
 * Compute a Bitcoin Merkle proof for `txid` at `index` in `txids`
 * (transaction order within the block). Returns the sibling hashes
 * from leaf to root.
 *
 * Bitcoin convention:
 *  - Leaves are the txids themselves (no pre-hashing).
 *  - Inner nodes are `sha256d(left || right)`.
 *  - Odd levels duplicate the last entry to pair.
 */
export function merkleProof(
  txids: Uint8Array[],
  index: number,
): { proof: Uint8Array[]; root: Uint8Array } {
  if (index < 0 || index >= txids.length) {
    throw new Error(`merkleProof: index ${index} out of range ${txids.length}`);
  }
  let level: Uint8Array[] = txids.map((t) => new Uint8Array(t));
  const proof: Uint8Array[] = [];
  let i = index;
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]);
    const sibling = level[i ^ 1];
    proof.push(sibling);
    const next: Uint8Array[] = [];
    for (let j = 0; j < level.length; j += 2) {
      next.push(sha256d(concatBytes(level[j], level[j + 1])));
    }
    level = next;
    i = Math.floor(i / 2);
  }
  return { proof, root: level[0] };
}

/**
 * Verify a Bitcoin Merkle proof against `root`. Returns `true` iff the
 * proof reconstructs the root from `txid` at `index`. Matches the
 * on-chain `verify-merkle-proof` semantic.
 */
export function verifyMerkleProof(
  txid: Uint8Array,
  index: number,
  proof: Uint8Array[],
  root: Uint8Array,
): boolean {
  let h: Uint8Array = new Uint8Array(txid);
  let i = index;
  for (const sibling of proof) {
    h =
      (i & 1) === 0
        ? sha256d(concatBytes(h, sibling))
        : sha256d(concatBytes(sibling, h));
    i = Math.floor(i / 2);
  }
  return bytesEqual(h, root);
}

// ============================================================================
// Internal byte helpers
// ============================================================================

function reverseBytes(a: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[a.length - 1 - i];
  return out;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
