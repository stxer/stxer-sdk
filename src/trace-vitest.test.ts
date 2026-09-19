import {
  Cl,
  type ClarityValue,
  cvToString,
  serializeCVBytes,
} from '@stacks/transactions';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { indexExpressions, parseSpan, sliceSpan } from './ast';
import { SimulationError } from './simulation-api';
import {
  decodeTrace,
  flattenTrace,
  getSimulationTrace,
  getTransactionTrace,
  type TraceCost,
  TraceDecodeError,
  TraceFetchError,
  type TraceNode,
  traceContractIds,
  traceNodeCost,
  traceNodeSelfCost,
} from './trace';
import type { SymbolicExpression } from './types';

/**
 * Offline: no network. Traces are built by a small encoder that mirrors the
 * wire layout, so each case can state exactly the bytes it needs — an error
 * value, a truncated node, a counter above 2^32 — instead of leaning on one
 * opaque captured blob. The compressed path is covered by a real zstd frame
 * embedded below; the live suite in `src/sample` covers real API responses.
 */

// -----------------------------------------------------------------------------
// Test-only encoder
// -----------------------------------------------------------------------------

type ValueSpec = ClarityValue | { error: string };

interface NodeSpec {
  code: string;
  id: number | bigint;
  func: string;
  args?: ValueSpec[];
  result: ValueSpec;
  before?: Partial<TraceCost>;
  after?: Partial<TraceCost>;
  children?: NodeSpec[];
}

const text = new TextEncoder();

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

function u64(value: number | bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

const lengthPrefixed = (bytes: Uint8Array) =>
  concat([u32(bytes.byteLength), bytes]);

const encodeCost = (cost: Partial<TraceCost> = {}) =>
  concat([
    u64(cost.read_count ?? 0),
    u64(cost.read_length ?? 0),
    u64(cost.write_count ?? 0),
    u64(cost.write_length ?? 0),
    u64(cost.runtime ?? 0),
  ]);

const encodeValue = (value: ValueSpec) =>
  'error' in value
    ? concat([
        Uint8Array.of(1),
        lengthPrefixed(text.encode(value.error as string)),
      ])
    : concat([Uint8Array.of(0), lengthPrefixed(serializeCVBytes(value))]);

/** Everything in a node except its children, which follow it directly. */
const encodeNodeHead = (node: NodeSpec, childCount: number) =>
  concat([
    lengthPrefixed(text.encode(node.code)),
    u64(node.id),
    encodeCost(node.before),
    encodeCost(node.after),
    lengthPrefixed(text.encode(node.func)),
    u32(node.args?.length ?? 0),
    ...(node.args ?? []).map(encodeValue),
    encodeValue(node.result),
    u32(childCount),
  ]);

const encodeNode = (node: NodeSpec): Uint8Array =>
  concat([
    encodeNodeHead(node, node.children?.length ?? 0),
    ...(node.children ?? []).map(encodeNode),
  ]);

const BLOCK_HASH = 'ab'.repeat(32);
const TXID = 'cd'.repeat(32);
const hexToBytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));

const encodeHeader = (magic = 'stxer0') =>
  concat([text.encode(magic), hexToBytes(BLOCK_HASH), hexToBytes(TXID)]);

const encodeTrace = (root: NodeSpec, magic?: string) =>
  concat([encodeHeader(magic), encodeNode(root)]);

// -----------------------------------------------------------------------------
// Fixture: a swap that calls into a token contract, which fails
// -----------------------------------------------------------------------------

const POOL = 'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.pool';
const TOKEN = 'SP26BVHEKMZSAKZ4PZ5SFPZVMRHDKH99D2Z38TK1Y.token';

// What a failed `asserts!` records: an early return on its way up.
const ASSERTION_FAILED =
  'EarlyReturn(AssertionFailed(Response(ResponseData { committed: false, data: UInt(1) })))';

const SWAP: NodeSpec = {
  code: `${POOL}:swap`,
  id: 10,
  func: 'let',
  args: [Cl.uint(500)],
  result: Cl.error(Cl.uint(1)),
  before: { runtime: 1_000, read_count: 2 },
  after: { runtime: 9_000, read_count: 7, read_length: 640, write_count: 1 },
  children: [
    {
      code: ':let',
      id: 11,
      func: ':literal',
      result: Cl.uint(500),
      before: { runtime: 1_100, read_count: 2 },
      after: { runtime: 1_200, read_count: 2 },
    },
    {
      code: ':let',
      id: 12,
      func: 'contract-call?',
      args: [Cl.uint(500), { error: 'Unchecked(UndefinedVariable("who"))' }],
      result: Cl.error(Cl.uint(1)),
      before: { runtime: 1_200, read_count: 2 },
      after: { runtime: 8_000, read_count: 7, read_length: 640 },
      children: [
        {
          code: `${TOKEN}:transfer`,
          id: 40,
          func: 'asserts!',
          result: { error: ASSERTION_FAILED },
          before: { runtime: 2_000, read_count: 3 },
          after: { runtime: 7_500, read_count: 7, read_length: 640 },
          children: [
            {
              code: ':asserts',
              id: 41,
              func: 'is-eq',
              result: Cl.bool(false),
              before: { runtime: 2_100, read_count: 3 },
              after: { runtime: 2_300, read_count: 3 },
            },
          ],
        },
      ],
    },
    {
      code: ':let',
      id: 13,
      func: 'print',
      result: Cl.stringAscii('after the call'),
      before: { runtime: 8_000, read_count: 7, read_length: 640 },
      after: { runtime: 8_500, read_count: 7, read_length: 640 },
    },
  ],
};

/**
 * `encodeTrace(SWAP)` compressed by the reference zstd implementation, as
 * base64. Embedding it checks the built-in decompressor against an
 * independent encoder, and keeps the suite off `node:zlib`'s zstd support,
 * which older Node versions lack.
 */
const SWAP_ZSTD = [
  'KLUv/WBzA4UPADZXV0Awa5wOgCVMRiSgGRGpKKSgoCDEmUdMlVtHvaNOmJc2nOh8IOLNAfvY',
  'IYjDHhH2qlr8E3Pi0KjuC9YbV936DeinSgBFAEYAVQEPEAiBZin5b00c8gyRU+8geeQAflqP',
  'iskwPFWAMouGxuE21wbpIqPD4NKujLORyUDgsgwGyUGmY9k0I4zlsoWu/xs0WChX6BoczygD',
  'A7OFNJWKRGjykLBYSliQ7ujjCZb4myLrYw6PTd4UTSiQcj2K9pb2DD2I/wsQUB8CLpdygxKr',
  '/n9MIg8mAbDJf0lcZ3iqzFkfS3A7MwQza1IKzZwFSZdDiqhNudatDnCgLMqlOpc2Npkj7IoI',
  'l4+G5uow2mbj+WgeDjTqtk7ootssuk8W6kCf/y/lepFNHSl3aSEM9ATpiRJBUQMmkAlMUUHK',
  '/w+VxKL6j1UVDLFysXo2EEVse7+YgKvcUsQ+7gY7OkIvXojbqwVDqIG5NtFImKAkBSnlAAOR',
  'makOEkDDYJBSQmMEUGiEZS6aoEKlxQZmID0RPsvzL6h44JXlFuiIhFm9PNBg4d2szmvNUXPk',
  'g7gfIX3QQcFAxGVUE4uEWy6q34aU4N5trsXouMx/8iQMt3CmJLRM3jbSkPTSogUp+LGaASZC',
  'nuphc00i4XYni/ze61MwVoSgAx8=',
].join('');

const base64ToBytes = (base64: string) =>
  Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

const show = (value: TraceNode['result']) =>
  typeof value === 'string' ? value : cvToString(value);

// -----------------------------------------------------------------------------
// decodeTrace
// -----------------------------------------------------------------------------

describe('decodeTrace', () => {
  it('reads the header and the node tree', async () => {
    const trace = await decodeTrace(encodeTrace(SWAP));

    expect(trace.block_hash).toBe(BLOCK_HASH);
    expect(trace.txid).toBe(TXID);

    const { root } = trace;
    expect(root).toMatchObject({ id: 10, code: `${POOL}:swap`, func: 'let' });
    expect(root.args.map(show)).toEqual(['u500']);
    expect(show(root.result)).toBe('(err u1)');
    expect(root.costs[0]).toEqual({
      read_count: 2,
      read_length: 0,
      write_count: 0,
      write_length: 0,
      runtime: 1_000,
    });
    expect(root.costs[1]).toEqual({
      read_count: 7,
      read_length: 640,
      write_count: 1,
      write_length: 0,
      runtime: 9_000,
    });
    expect(root.children.map((child) => child.func)).toEqual([
      ':literal',
      'contract-call?',
      'print',
    ]);
  });

  it('reports a failed argument or result as its error message', async () => {
    const { root } = await decodeTrace(encodeTrace(SWAP));
    const call = root.children[1];

    expect(call.args.map(show)).toEqual([
      'u500',
      'Unchecked(UndefinedVariable("who"))',
    ]);
    expect(call.children[0].result).toBe(ASSERTION_FAILED);
  });

  it('always gives leaves empty args and children', async () => {
    const { root } = await decodeTrace(encodeTrace(SWAP));
    expect(root.children[0].args).toEqual([]);
    expect(root.children[0].children).toEqual([]);
  });

  it('decompresses a zstd frame with the built-in decompressor', async () => {
    const compressed = base64ToBytes(SWAP_ZSTD);
    expect(Array.from(compressed.subarray(0, 4))).toEqual([
      0x28, 0xb5, 0x2f, 0xfd,
    ]);
    expect(await decodeTrace(compressed)).toEqual(
      await decodeTrace(encodeTrace(SWAP)),
    );
  });

  it('uses a custom decompressor, sync or async', async () => {
    const raw = encodeTrace(SWAP);
    const compressed = base64ToBytes(SWAP_ZSTD);
    const expected = await decodeTrace(raw);

    const sync = vi.fn(() => raw);
    expect(await decodeTrace(compressed, { decompress: sync })).toEqual(
      expected,
    );
    expect(sync).toHaveBeenCalledWith(compressed);

    const async = vi.fn(async () => raw);
    expect(await decodeTrace(compressed, { decompress: async })).toEqual(
      expected,
    );
  });

  it('does not decompress input that is already a trace', async () => {
    const decompress = vi.fn();
    await decodeTrace(encodeTrace(SWAP), { decompress });
    expect(decompress).not.toHaveBeenCalled();
  });

  it('accepts an ArrayBuffer and a view at a non-zero offset', async () => {
    const raw = encodeTrace(SWAP);
    const expected = await decodeTrace(raw);

    const exact = raw.buffer.slice(raw.byteOffset, raw.byteLength);
    expect(await decodeTrace(exact as ArrayBuffer)).toEqual(expected);

    const padded = concat([new Uint8Array(13), raw, new Uint8Array(5)]);
    const view = padded.subarray(13, 13 + raw.byteLength);
    expect(await decodeTrace(view)).toEqual(expected);
  });

  it('reads counters above 2^32 exactly', async () => {
    const runtime = 5_000_000_123; // a full block's runtime budget, and then some
    const { root } = await decodeTrace(
      encodeTrace({ ...SWAP, children: [], after: { runtime } }),
    );
    expect(root.costs[1].runtime).toBe(runtime);
  });

  it('decodes a trace nested far deeper than the call stack allows', async () => {
    const depth = 50_000;
    const link: NodeSpec = {
      code: ':begin',
      id: 1,
      func: 'begin',
      result: Cl.bool(true),
    };
    const chain = concat([
      encodeHeader(),
      encodeNodeHead({ ...link, code: `${POOL}:deep` }, 1),
      ...Array.from({ length: depth - 2 }, () => encodeNodeHead(link, 1)),
      encodeNodeHead(link, 0),
    ]);

    const { root } = await decodeTrace(chain);
    const visits = flattenTrace(root);
    expect(visits).toHaveLength(depth);
    expect(visits[depth - 1]).toMatchObject({
      depth: depth - 1,
      contractId: POOL,
    });
  });

  describe('rejects', () => {
    const decodeError = (message: RegExp) =>
      expect.objectContaining({
        name: 'TraceDecodeError',
        message: expect.stringMatching(message),
      });

    it('a truncated trace, reporting where it ran out', async () => {
      const raw = encodeTrace(SWAP);
      const cut = raw.subarray(0, raw.byteLength - 3);

      const error = await decodeTrace(cut).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TraceDecodeError);
      expect(error).toEqual(decodeError(/truncated/));
      expect((error as TraceDecodeError).offset).toBeGreaterThan(70);
    });

    it('every possible truncation, without ever throwing anything else', async () => {
      const raw = encodeTrace(SWAP);
      for (let length = 0; length < raw.byteLength; length++) {
        await expect(
          decodeTrace(raw.subarray(0, length)),
        ).rejects.toBeInstanceOf(TraceDecodeError);
      }
    });

    it('input that is not a trace', async () => {
      await expect(decodeTrace(new Uint8Array())).rejects.toEqual(
        decodeError(/Not a stxer debug trace/),
      );
      await expect(decodeTrace(text.encode('<html>nope'))).rejects.toEqual(
        decodeError(/Not a stxer debug trace/),
      );
    });

    it('a newer format version, saying so', async () => {
      await expect(decodeTrace(encodeTrace(SWAP, 'stxer1'))).rejects.toEqual(
        decodeError(/Unsupported trace format "stxer1".*Upgrade/),
      );
    });

    it('an API error body, surfacing the server message', async () => {
      const body = text.encode('{"error":"data not ready yet"}');
      await expect(decodeTrace(body)).rejects.toEqual(
        decodeError(/returned an error instead of a trace: data not ready yet/),
      );
    });

    it('a corrupt zstd frame', async () => {
      const corrupt = concat([
        Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd),
        new Uint8Array(24).fill(0xff),
      ]);
      await expect(decodeTrace(corrupt)).rejects.toEqual(
        decodeError(/zstd decompression failed/),
      );
    });

    it('a Clarity value it cannot deserialize', async () => {
      const bogus = concat([
        encodeHeader(),
        lengthPrefixed(text.encode(`${POOL}:f`)),
        u64(1),
        encodeCost(),
        encodeCost(),
        lengthPrefixed(text.encode('f')),
        u32(0),
        Uint8Array.of(0),
        lengthPrefixed(Uint8Array.of(0xee, 0xee)), // no such Clarity type id
        u32(0),
      ]);
      await expect(decodeTrace(bogus)).rejects.toEqual(
        decodeError(/cannot deserialize/),
      );
    });
  });
});

// -----------------------------------------------------------------------------
// Working with a trace
// -----------------------------------------------------------------------------

describe('flattenTrace', () => {
  it('lists nodes in evaluation order with depth and parent', async () => {
    const { root } = await decodeTrace(encodeTrace(SWAP));
    const visits = flattenTrace(root);

    expect(visits.map(({ node, depth }) => [node.id, depth])).toEqual([
      [10, 0],
      [11, 1],
      [12, 1],
      [40, 2],
      [41, 3],
      [13, 1],
    ]);
    expect(visits[0].parent).toBeUndefined();
    expect(visits[3].parent).toBe(root.children[1]);
  });

  it('threads the contract down, and back out after a nested call returns', async () => {
    const { root } = await decodeTrace(encodeTrace(SWAP));
    const contracts = flattenTrace(root).map(({ node, contractId }) => [
      node.id,
      contractId,
    ]);

    expect(contracts).toEqual([
      [10, POOL],
      [11, POOL],
      [12, POOL],
      [40, TOKEN],
      [41, TOKEN],
      [13, POOL], // evaluated by the pool again, after the token call
    ]);
  });

  it('leaves the contract undefined until a reference is seen', async () => {
    const { root } = await decodeTrace(
      encodeTrace({ ...SWAP, code: ':orphan', children: [] }),
    );
    expect(flattenTrace(root)[0].contractId).toBeUndefined();
  });
});

describe('traceContractIds', () => {
  it('lists each contract once, in order of first appearance', async () => {
    const { root } = await decodeTrace(encodeTrace(SWAP));
    expect(traceContractIds(root)).toEqual([POOL, TOKEN]);
  });
});

describe('traceNodeCost', () => {
  it('is the after snapshot minus the before snapshot', async () => {
    const { root } = await decodeTrace(encodeTrace(SWAP));
    expect(traceNodeCost(root)).toEqual({
      read_count: 5,
      read_length: 640,
      write_count: 1,
      write_length: 0,
      runtime: 8_000,
    });
  });
});

describe('traceNodeSelfCost', () => {
  it('excludes what the children cost', async () => {
    const { root } = await decodeTrace(encodeTrace(SWAP));
    // 8_000 in total, less children costing 100 + 6_800 + 500.
    expect(traceNodeSelfCost(root)).toEqual({
      read_count: 0,
      read_length: 0,
      write_count: 1,
      write_length: 0,
      runtime: 600,
    });
  });

  it('partitions the trace: self costs sum to the root cost', async () => {
    const { root } = await decodeTrace(encodeTrace(SWAP));
    const total = flattenTrace(root).reduce(
      (sum, { node }) => sum + traceNodeSelfCost(node).runtime,
      0,
    );
    expect(total).toBe(traceNodeCost(root).runtime);
  });
});

// -----------------------------------------------------------------------------
// Fetching
// -----------------------------------------------------------------------------

describe('trace fetchers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubFetch = (response: Response) => {
    const fetchMock = vi.fn(async (_url: string) => response);
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };
  const traceResponse = () =>
    new Response(base64ToBytes(SWAP_ZSTD), {
      headers: { 'content-type': 'application/octet-stream' },
    });

  it('getTransactionTrace addresses the block and normalizes pasted ids', async () => {
    const fetchMock = stubFetch(traceResponse());

    const trace = await getTransactionTrace({
      blockHeight: 1018838,
      blockHash: `0x${BLOCK_HASH.toUpperCase()}`,
      txid: `0x${TXID}`,
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://api.stxer.xyz/inspect/1018838/${BLOCK_HASH}/${TXID}`,
    );
    expect(trace.root.code).toBe(`${POOL}:swap`);
  });

  it('getSimulationTrace addresses the session, on a custom endpoint', async () => {
    const fetchMock = stubFetch(traceResponse());

    await getSimulationTrace({
      simulationId: 'f'.repeat(32),
      txid: TXID,
      stxerApi: 'https://testnet-api.stxer.xyz',
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://testnet-api.stxer.xyz/devtools/v2/simulations/${'f'.repeat(32)}/inspect/${TXID}`,
    );
  });

  it('rejects a malformed id before making a request', async () => {
    const fetchMock = stubFetch(traceResponse());

    await expect(
      getTransactionTrace({ blockHeight: 1, blockHash: 'nope', txid: TXID }),
    ).rejects.toThrow(/blockHash must be 32 bytes of hex/);
    await expect(
      getSimulationTrace({ simulationId: 'f'.repeat(32), txid: '0x1234' }),
    ).rejects.toThrow(/txid must be 32 bytes of hex/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getTransactionTrace throws TraceFetchError carrying the status', async () => {
    stubFetch(
      new Response('{"error":"data not ready yet or already expired"}', {
        status: 404,
      }),
    );

    const error = await getTransactionTrace({
      blockHeight: 1,
      blockHash: BLOCK_HASH,
      txid: TXID,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TraceFetchError);
    expect(error).toMatchObject({
      status: 404,
      body: 'data not ready yet or already expired',
    });
  });

  it('getSimulationTrace throws SimulationError, keeping the busy marker', async () => {
    stubFetch(
      new Response('simulation_busy: another submit is in flight', {
        status: 409,
      }),
    );

    const error = await getSimulationTrace({
      simulationId: 'f'.repeat(32),
      txid: TXID,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SimulationError);
    expect(error).toMatchObject({ status: 409, marker: 'simulation_busy' });
  });
});

// -----------------------------------------------------------------------------
// Mapping a node back to source
// -----------------------------------------------------------------------------

describe('AST helpers', () => {
  const atom = (
    id: number,
    name: string,
    span: string,
  ): SymbolicExpression => ({
    id,
    span,
    expr: { atom: name },
  });
  const SOURCE = '(define-public (f)\n  (ok\n    true))\n';
  const AST: SymbolicExpression[] = [
    {
      id: 1,
      span: '1:1-3:10',
      expr: {
        list: [
          atom(2, 'define-public', '1:2-1:14'),
          {
            id: 3,
            span: '1:16-1:18',
            expr: { list: [atom(4, 'f', '1:17-1:17')] },
          },
          {
            id: 5,
            span: '2:3-3:9',
            expr: {
              list: [atom(6, 'ok', '2:4-2:5'), atom(7, 'true', '3:5-3:8')],
            },
          },
        ],
      },
    },
  ];

  it('indexExpressions reaches every nested expression', () => {
    const byId = indexExpressions(AST);
    expect(Array.from(byId.keys()).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(byId.get(7)?.expr).toEqual({ atom: 'true' });
  });

  it('parseSpan reads 1-based, end-inclusive positions', () => {
    expect(parseSpan('361:2-363:83')).toEqual({
      startLine: 361,
      startColumn: 2,
      endLine: 363,
      endColumn: 83,
    });
    expect(() => parseSpan('361:2')).toThrow(/Invalid source span/);
  });

  it('sliceSpan returns exactly the text an expression covers', () => {
    const byId = indexExpressions(AST);
    const slice = (id: number) =>
      sliceSpan(SOURCE, (byId.get(id) as SymbolicExpression).span);

    expect(slice(2)).toBe('define-public');
    expect(slice(4)).toBe('f');
    expect(slice(5)).toBe('(ok\n    true)');
    expect(slice(1)).toBe(SOURCE.trimEnd());
  });

  it('sliceSpan returns an empty string for a span outside the source', () => {
    expect(sliceSpan(SOURCE, '0:0-0:0')).toBe('');
    expect(sliceSpan(SOURCE, '99:1-99:5')).toBe('');
  });

  it('sliceSpan is not confused by switching between sources', () => {
    const other = 'first\nsecond\n';
    expect(sliceSpan(SOURCE, '2:4-2:5')).toBe('ok');
    expect(sliceSpan(other, '2:1-2:6')).toBe('second');
    expect(sliceSpan(SOURCE, '2:4-2:5')).toBe('ok');
  });
});
