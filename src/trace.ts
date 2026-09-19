/**
 * Debug traces
 *
 * A debug trace is the expression-by-expression record of how a
 * transaction executed: every function call and nested sub-expression,
 * with its arguments, result and running execution cost. It is the data
 * behind the call tree in the [stxer debugger](https://stxer.xyz).
 *
 * Traces are served as a zstd-compressed binary blob from two endpoints:
 *
 *   - `GET /inspect/{block_height}/{block_hash}/{txid}` — an on-chain
 *     transaction ({@link getTransactionTrace}).
 *   - `GET /devtools/v2/simulations/{id}/inspect/{txid}` — a transaction
 *     step inside a simulation session ({@link getSimulationTrace}).
 *
 * {@link decodeTrace} turns a blob from either one into a {@link Trace}.
 * It is pure JavaScript — no WASM, no Node built-ins — so it runs unchanged
 * in browsers, workers and Node.
 */

import { type ClarityValue, deserializeCV } from '@stacks/transactions';
import { decompress as fzstdDecompress } from 'fzstd';
import { bytesToHex } from './bitcoin';
import { DEFAULT_STXER_API } from './constants';
import { SimulationError } from './simulation-api';
import type { U64 } from './types';

// =============================================================================
// Types
// =============================================================================

/**
 * A snapshot of the running execution-cost counters.
 *
 * Same fields as {@link ExecutionCost}, but always plain numbers: the
 * binary format carries them as `u64` and the decoder narrows them to
 * `number`, which is exact below 2^53 — far beyond what a block's cost
 * budget can reach.
 */
export interface TraceCost {
  read_count: number;
  read_length: number;
  write_count: number;
  write_length: number;
  runtime: number;
}

/**
 * An argument or result recorded in a trace: the decoded Clarity value
 * when the expression produced one, or a string when it did not. Narrow
 * with `typeof value === 'string'`.
 *
 * An expression produces no value in two situations, and the string says
 * which:
 *
 *   - A runtime error, such as `Runtime(DivisionByZero, …)`. This aborts
 *     the transaction.
 *   - An early return in flight, such as `EarlyReturn(AssertionFailed(…))`
 *     from a failed `asserts!`, `try!` or `unwrap!`. It travels up through
 *     the enclosing expressions — each records the same string — until it
 *     reaches the function being called, which returns it as an ordinary
 *     value. So a string here is not by itself a failed transaction: a
 *     function may early-return `(err u1)` to a caller that handles it.
 *
 * The text is diagnostic. Show it to people; do not parse it.
 */
export type TraceValue = ClarityValue | string;

/**
 * One node of the execution tree.
 *
 * Each node is one evaluated expression — a contract-function call or a
 * nested sub-expression — with its inputs, its output, the cost counters
 * either side of it, and the expressions it evaluated in turn. The root
 * is where execution starts: for a contract call, the body of the
 * function that was called.
 */
export interface TraceNode {
  /**
   * Id of the expression that produced this node. It equals the `id` of
   * a {@link SymbolicExpression} in the AST of the contract the node ran
   * in, which is how a node is mapped back to source code: index that
   * contract's AST with {@link indexExpressions}, look this id up, and
   * slice the source with {@link sliceSpan}.
   *
   * Ids are only unique within one contract, so resolve the contract
   * first — {@link flattenTrace} does that for every node.
   */
  id: number;
  /**
   * Where the node was evaluated.
   *
   * Where a function is entered this is a contract reference of the form
   * `<contract-id>:<function-name>`, e.g.
   * `SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.amm-pool-v2-01:swap-helper`.
   *
   * Nested sub-expressions may repeat that reference, or carry a short
   * `:`-prefixed label instead (treat it as informational). A node without
   * a contract reference belongs to the nearest ancestor that has one. Use
   * {@link flattenTrace} rather than reading this field directly — it
   * threads the contract id down to every node.
   */
  code: string;
  /**
   * Name of the evaluated expression: a function name (`transfer`, `+`,
   * `if`, …), or a synthetic `:`-prefixed label for leaves such as
   * literals and variable lookups.
   */
  func: string;
  /** Arguments passed to this node, in order. Empty when it takes none. */
  args: TraceValue[];
  /**
   * What this node evaluated to. A string means it produced no value —
   * see {@link TraceValue} for what that does and does not imply.
   */
  result: TraceValue;
  /**
   * Cost counters captured immediately before and immediately after this
   * node ran. Their difference is what the node cost, children included
   * ({@link traceNodeCost}); {@link traceNodeSelfCost} gives the node alone.
   */
  costs: [before: TraceCost, after: TraceCost];
  /** Sub-expressions this node evaluated, in evaluation order. */
  children: TraceNode[];
}

/** A decoded debug trace. */
export interface Trace {
  /**
   * Hash of the block that includes the transaction, as 64 lowercase hex
   * characters without a `0x` prefix. This is the Stacks block hash, not
   * the `index_block_hash`.
   *
   * All zeros for a simulated transaction, which belongs to no block.
   */
  block_hash: string;
  /** Id of the traced transaction, 64 lowercase hex characters, no `0x`. */
  txid: string;
  /** Where execution starts; every other node descends from it. */
  root: TraceNode;
}

/**
 * A zstd decompressor: takes one complete zstd frame and returns the
 * decompressed bytes, synchronously or as a promise.
 */
export type ZstdDecompress = (
  compressed: Uint8Array,
) => Uint8Array | Promise<Uint8Array>;

export interface DecodeTraceOptions {
  /**
   * Replace the built-in zstd decompressor.
   *
   * The default is a small pure-JavaScript implementation that works in
   * every runtime. Decompression is a minor share of decode time, so the
   * default is the right choice unless you are decoding traces in bulk —
   * in which case a native binding is several times faster:
   *
   * ```typescript
   * import { zstdDecompressSync } from 'node:zlib'; // Node >= 22.15
   *
   * const trace = await decodeTrace(blob, { decompress: zstdDecompressSync });
   * ```
   */
  decompress?: ZstdDecompress;
}

// =============================================================================
// Errors
// =============================================================================

/**
 * Thrown by {@link decodeTrace} when the input is not a trace this SDK
 * can read: not a trace at all, a truncated or corrupt one, or one written
 * in a newer format version.
 */
export class TraceDecodeError extends Error {
  /** Byte offset into the decompressed trace where decoding stopped. */
  readonly offset: number | undefined;
  constructor(message: string, offset?: number) {
    super(offset === undefined ? message : `${message} (at byte ${offset})`);
    this.name = 'TraceDecodeError';
    this.offset = offset;
  }
}

/**
 * Thrown by {@link getTransactionTrace} when the API responds with a
 * non-2xx status. A `status` of 404 means there is no trace to return:
 * the transaction ran no Clarity code, or its trace is not available yet
 * (or any more).
 */
export class TraceFetchError extends Error {
  readonly status: number;
  /** The server's message, unwrapped from its JSON envelope when present. */
  readonly body: string;
  constructor(operation: string, status: number, body: string) {
    super(`${operation} (HTTP ${status}): ${body}`);
    this.name = 'TraceFetchError';
    this.status = status;
    this.body = body;
  }
}

// =============================================================================
// Decoding
// =============================================================================

// Every zstd frame opens with this magic number.
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
// A decompressed trace opens with `stxer` followed by a one-character
// format version. This decoder reads version `0`.
const TRACE_MAGIC = 'stxer';
const TRACE_VERSION = '0';
const HASH_LENGTH = 32;

const utf8 = new TextDecoder();

/** Bounds-checked big-endian cursor over the decompressed trace. */
class ByteReader {
  offset = 0;
  private readonly bytes: Uint8Array;
  private readonly view: DataView;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private advance(length: number): number {
    const start = this.offset;
    if (start + length > this.bytes.byteLength) {
      throw new TraceDecodeError(
        `Trace is truncated: needed ${length} more bytes, ${this.bytes.byteLength - start} left`,
        start,
      );
    }
    this.offset = start + length;
    return start;
  }

  u8(): number {
    return this.view.getUint8(this.advance(1));
  }

  u32(): number {
    return this.view.getUint32(this.advance(4));
  }

  /**
   * Reads a `u64` as a `number`. Assembling it from two 32-bit halves
   * avoids a BigInt allocation per field — a large trace holds millions
   * of them — and is exact for every value below 2^53.
   */
  u64(): number {
    const start = this.advance(8);
    return (
      this.view.getUint32(start) * 4294967296 + this.view.getUint32(start + 4)
    );
  }

  take(length: number): Uint8Array {
    const start = this.advance(length);
    return this.bytes.subarray(start, start + length);
  }

  /** A `u32` length followed by that many bytes of UTF-8. */
  string(): string {
    return utf8.decode(this.take(this.u32()));
  }
}

function readCost(reader: ByteReader): TraceCost {
  const read_count = reader.u64();
  const read_length = reader.u64();
  const write_count = reader.u64();
  const write_length = reader.u64();
  const runtime = reader.u64();
  return { read_count, read_length, write_count, write_length, runtime };
}

/**
 * A status byte (`0` = evaluated, anything else = failed), then a
 * length-prefixed payload: a serialized Clarity value on success, a UTF-8
 * error message on failure.
 */
function readValue(reader: ByteReader): TraceValue {
  const start = reader.offset;
  const evaluated = reader.u8() === 0;
  const payload = reader.take(reader.u32());
  if (!evaluated) return utf8.decode(payload);
  try {
    return deserializeCV(payload);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new TraceDecodeError(
      `Trace holds a Clarity value this SDK cannot deserialize: ${reason}`,
      start,
    );
  }
}

/**
 * Reads one node up to and including its child count. The children
 * themselves follow immediately, depth-first, and are attached by the
 * caller.
 */
function readNode(reader: ByteReader): [node: TraceNode, childCount: number] {
  const code = reader.string();
  const id = reader.u64();
  const before = readCost(reader);
  const after = readCost(reader);
  const func = reader.string();

  const argCount = reader.u32();
  const args: TraceValue[] = [];
  for (let i = 0; i < argCount; i++) {
    args.push(readValue(reader));
  }
  const result = readValue(reader);

  const node: TraceNode = {
    id,
    code,
    func,
    args,
    result,
    costs: [before, after],
    children: [],
  };
  return [node, reader.u32()];
}

/**
 * Reads the node tree. Nodes carry no length prefix, so the only way to
 * find where one ends is to read it; an explicit stack keeps deeply
 * nested traces from exhausting the call stack.
 */
function readTree(reader: ByteReader): TraceNode {
  const [root, rootChildren] = readNode(reader);
  const open: { node: TraceNode; pending: number }[] = [
    { node: root, pending: rootChildren },
  ];
  while (open.length > 0) {
    const parent = open[open.length - 1];
    if (parent.pending === 0) {
      open.pop();
      continue;
    }
    parent.pending--;
    const [child, childChildren] = readNode(reader);
    parent.node.children.push(child);
    if (childChildren > 0) {
      open.push({ node: child, pending: childChildren });
    }
  }
  return root;
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return (
    bytes.byteLength >= prefix.length &&
    prefix.every((byte, i) => bytes[i] === byte)
  );
}

/**
 * The API reports failures as a `{"error": "..."}` JSON body. Recognize
 * one that was handed to the decoder by mistake, so the caller sees the
 * server's message rather than a complaint about magic bytes.
 */
function apiErrorMessage(bytes: Uint8Array): string | undefined {
  if (bytes[0] !== 0x7b /* { */) return undefined;
  try {
    const parsed: unknown = JSON.parse(utf8.decode(bytes));
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
      return String(parsed.error);
    }
  } catch {
    // Not JSON after all — fall through to the generic format error.
  }
  return undefined;
}

function parseTrace(bytes: Uint8Array): Trace {
  const reader = new ByteReader(bytes);
  const magic =
    bytes.byteLength > TRACE_MAGIC.length
      ? utf8.decode(bytes.subarray(0, TRACE_MAGIC.length + 1))
      : '';

  if (!magic.startsWith(TRACE_MAGIC)) {
    const apiError = apiErrorMessage(bytes);
    throw new TraceDecodeError(
      apiError === undefined
        ? 'Not a stxer debug trace: unrecognized header'
        : `The API returned an error instead of a trace: ${apiError}`,
    );
  }
  if (magic !== TRACE_MAGIC + TRACE_VERSION) {
    throw new TraceDecodeError(
      `Unsupported trace format "${magic}" (this SDK reads "${TRACE_MAGIC}${TRACE_VERSION}"). Upgrade the stxer SDK.`,
    );
  }
  reader.take(magic.length);

  const block_hash = bytesToHex(reader.take(HASH_LENGTH));
  const txid = bytesToHex(reader.take(HASH_LENGTH));
  return { block_hash, txid, root: readTree(reader) };
}

/**
 * Decode a debug-trace blob into a {@link Trace}.
 *
 * Accepts the response body of either trace endpoint exactly as served
 * (zstd-compressed). Already-decompressed trace bytes are recognized and
 * accepted too.
 *
 * Reach for this when you fetch or store blobs yourself; otherwise
 * {@link getTransactionTrace} and {@link getSimulationTrace} fetch and
 * decode in one call.
 *
 * @throws {TraceDecodeError} if the input is not a readable trace.
 *
 * @example
 * ```typescript
 * import { decodeTrace } from 'stxer';
 *
 * const response = await fetch(traceUrl);
 * const trace = await decodeTrace(await response.arrayBuffer());
 * console.log(trace.txid, trace.root.func, trace.root.result);
 * ```
 */
export async function decodeTrace(
  data: Uint8Array | ArrayBuffer,
  options: DecodeTraceOptions = {},
): Promise<Trace> {
  let bytes = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);

  if (startsWith(bytes, ZSTD_MAGIC)) {
    const decompress = options.decompress ?? fzstdDecompress;
    try {
      bytes = await decompress(bytes);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new TraceDecodeError(`zstd decompression failed: ${reason}`);
    }
  }
  return parseTrace(bytes);
}

// =============================================================================
// Fetching
// =============================================================================

export interface TraceApiOptions extends DecodeTraceOptions {
  /** stxer API endpoint (default: https://api.stxer.xyz) */
  stxerApi?: string;
}

export interface GetTransactionTraceOptions extends TraceApiOptions {
  /** Height of the block that includes the transaction. */
  blockHeight: U64;
  /**
   * Hash of that block — the Stacks block hash (`block_hash` on a Stacks
   * API transaction, `hash` on a block), **not** the `index_block_hash`.
   * A leading `0x` is accepted.
   */
  blockHash: string;
  /** Transaction id. A leading `0x` is accepted. */
  txid: string;
}

export interface GetSimulationTraceOptions extends TraceApiOptions {
  /** Simulation session id. */
  simulationId: string;
  /**
   * Id of a `Transaction` step in that session — `txid` from
   * {@link callContract}, or `TxId` on the step's summary from
   * {@link getSimulationResult}. A leading `0x` is accepted.
   */
  txid: string;
}

/** Normalize a 32-byte hex id to the bare lowercase form the API expects. */
function normalizeHash(value: string, name: string): string {
  const hex = value.replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new TypeError(
      `${name} must be 32 bytes of hex (64 characters, optional 0x prefix), got "${value}"`,
    );
  }
  return hex;
}

/** The server's message, unwrapped from `{"error": "..."}` when present. */
async function errorBody(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
      return String(parsed.error);
    }
  } catch {
    // Plain-text body.
  }
  return text;
}

function fetchTrace(url: string): Promise<Response> {
  return fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/octet-stream',
    },
  });
}

/**
 * Fetch and decode the debug trace of an on-chain transaction.
 *
 * The transaction is addressed by the block that includes it; both values
 * are on the transaction as returned by the Stacks API (`block_height`
 * and `block_hash`).
 *
 * A trace exists only if the transaction actually ran Clarity code. A
 * plain STX transfer has none, and neither does a call that was rejected
 * before it started — calling a function that is not public, say.
 *
 * @throws {TraceFetchError} on a non-2xx response. `status === 404` means
 *   there is no trace for that transaction.
 * @throws {TraceDecodeError} if the response is not a readable trace.
 *
 * @example
 * ```typescript
 * import { cvToString } from '@stacks/transactions';
 * import { getTransactionTrace } from 'stxer';
 *
 * const trace = await getTransactionTrace({
 *   blockHeight: 1018838,
 *   blockHash: '89945f0d9956794d453adb28d78302002a1d16885d8b4de3ee598ec69c631a54',
 *   txid: 'c1bfb9616c51a17859c48f1716eefdd5ea9646f59b8e6c082033370ae17e33fa',
 * });
 * const { root } = trace;
 * console.log(root.code); // SP102V8...amm-pool-v2-01:swap-helper
 * console.log(typeof root.result === 'string' ? root.result : cvToString(root.result));
 * ```
 */
export async function getTransactionTrace(
  options: GetTransactionTraceOptions,
): Promise<Trace> {
  const blockHash = normalizeHash(options.blockHash, 'blockHash');
  const txid = normalizeHash(options.txid, 'txid');
  const url = `${options.stxerApi ?? DEFAULT_STXER_API}/inspect/${options.blockHeight}/${blockHash}/${txid}`;

  const response = await fetchTrace(url);
  if (!response.ok) {
    throw new TraceFetchError(
      'Failed to fetch transaction trace',
      response.status,
      await errorBody(response),
    );
  }
  return decodeTrace(await response.arrayBuffer(), options);
}

/**
 * Fetch and decode the debug trace of a transaction step inside a
 * simulation session.
 *
 * Traces exist only for `Transaction` steps that ran Clarity code, and
 * only when the session was created without `skip_tracing`.
 * `instantSimulation` never records one.
 *
 * @throws {SimulationError} on a non-2xx response, like every other
 *   session call: 404 when there is no trace (tracing skipped, not a
 *   `Transaction` step, nothing executed, unknown or expired session),
 *   409 when the session is busy (retry), 410 when it is outdated (start
 *   a new one).
 * @throws {TraceDecodeError} if the response is not a readable trace.
 *
 * @example
 * ```typescript
 * import { Cl } from '@stacks/transactions';
 * import { callContract, createSimulationSession, getSimulationTrace } from 'stxer';
 *
 * const simulationId = await createSimulationSession();
 * const { txid } = await callContract(simulationId, {
 *   sender: 'SP212Y5JKN59YP3GYG07K3S8W5SSGE4KH6B5STXER',
 *   contract: 'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.amm-pool-v2-01',
 *   functionName: 'get-pool-details',
 *   functionArgs: [tokenX, tokenY, Cl.uint(100000000)],
 * });
 * const trace = await getSimulationTrace({ simulationId, txid });
 * ```
 */
export async function getSimulationTrace(
  options: GetSimulationTraceOptions,
): Promise<Trace> {
  const txid = normalizeHash(options.txid, 'txid');
  const url = `${options.stxerApi ?? DEFAULT_STXER_API}/devtools/v2/simulations/${options.simulationId}/inspect/${txid}`;

  const response = await fetchTrace(url);
  if (!response.ok) {
    throw new SimulationError(
      'Failed to fetch simulation trace',
      response.status,
      await errorBody(response),
    );
  }
  return decodeTrace(await response.arrayBuffer(), options);
}

// =============================================================================
// Working with a trace
// =============================================================================

/** A node together with the context needed to interpret it. */
export interface TraceVisit {
  node: TraceNode;
  /**
   * The contract this node was evaluated in — taken from the node's own
   * contract reference when it has one, inherited from the nearest
   * ancestor otherwise. `undefined` only if no contract reference has
   * been seen yet on the way down from the root.
   */
  contractId: string | undefined;
  /** Distance from the root, which is at depth 0. */
  depth: number;
  /** The enclosing node. `undefined` for the root. */
  parent: TraceNode | undefined;
}

// Contract references open with a Stacks address, and every Stacks address
// version starts with one of these prefixes. Labels start with `:`.
const CONTRACT_REFERENCE = /^S[PMTN]/;

function contractIdOf(code: string): string | undefined {
  if (!CONTRACT_REFERENCE.test(code)) return undefined;
  const separator = code.indexOf(':');
  return separator === -1 ? code : code.slice(0, separator);
}

/**
 * List every node of a trace in evaluation order (depth-first,
 * parents before children), each paired with the contract it ran in.
 *
 * A node only names its contract at a call boundary; this resolves it
 * for all the nodes in between, which is what you need before looking a
 * node's `id` up in an AST.
 *
 * @example
 * ```typescript
 * // Print the call tree with what each step cost.
 * for (const { node, depth, contractId } of flattenTrace(trace.root)) {
 *   const { runtime } = traceNodeCost(node);
 *   console.log(`${'  '.repeat(depth)}${node.func}  runtime=${runtime}  ${contractId}`);
 * }
 * ```
 */
export function flattenTrace(root: TraceNode): TraceVisit[] {
  const visits: TraceVisit[] = [];
  const pending: TraceVisit[] = [
    { node: root, contractId: undefined, depth: 0, parent: undefined },
  ];
  for (let visit = pending.pop(); visit; visit = pending.pop()) {
    const { node, depth } = visit;
    const contractId = contractIdOf(node.code) ?? visit.contractId;
    visits.push({ node, contractId, depth, parent: visit.parent });
    // Pushed in reverse so the first child is popped — and visited — first.
    for (let i = node.children.length - 1; i >= 0; i--) {
      pending.push({
        node: node.children[i],
        contractId,
        depth: depth + 1,
        parent: node,
      });
    }
  }
  return visits;
}

/**
 * The ids of every contract a trace executed code in, in order of first
 * appearance. These are the contracts whose ASTs you need to map the
 * trace back to source.
 */
export function traceContractIds(root: TraceNode): string[] {
  const ids = new Set<string>();
  for (const { contractId } of flattenTrace(root)) {
    if (contractId !== undefined) ids.add(contractId);
  }
  return Array.from(ids);
}

/**
 * The execution cost of one node: its `after` snapshot minus its `before`
 * snapshot. This is inclusive — it covers the node and everything it
 * evaluated — so a parent's cost is never less than the sum of its
 * children's. For the node's own share, see {@link traceNodeSelfCost}.
 */
export function traceNodeCost(node: TraceNode): TraceCost {
  const [before, after] = node.costs;
  return {
    read_count: after.read_count - before.read_count,
    read_length: after.read_length - before.read_length,
    write_count: after.write_count - before.write_count,
    write_length: after.write_length - before.write_length,
    runtime: after.runtime - before.runtime,
  };
}

/**
 * The cost of one node excluding its children: {@link traceNodeCost}
 * minus the cost of each child. Self costs partition the trace — summed
 * over every node they equal the root's cost — which makes them the
 * figure to group by when asking where a transaction's budget went.
 *
 * @example
 * ```typescript
 * // Runtime spent in each contract.
 * const runtime = new Map<string, number>();
 * for (const { node, contractId = '' } of flattenTrace(trace.root)) {
 *   const spent = traceNodeSelfCost(node).runtime;
 *   runtime.set(contractId, (runtime.get(contractId) ?? 0) + spent);
 * }
 * ```
 */
export function traceNodeSelfCost(node: TraceNode): TraceCost {
  const self = traceNodeCost(node);
  for (const child of node.children) {
    const cost = traceNodeCost(child);
    self.read_count -= cost.read_count;
    self.read_length -= cost.read_length;
    self.write_count -= cost.write_count;
    self.write_length -= cost.write_length;
    self.runtime -= cost.runtime;
  }
  return self;
}
