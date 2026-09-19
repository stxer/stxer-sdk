/**
 * Vitest example: read debug traces and map them back to source.
 *
 * Two scenarios, matching the two trace endpoints:
 *
 *   1. An on-chain transaction — fetch its trace, resolve the contracts it
 *      touched, and slice the exact source of a node out of the on-chain
 *      AST (`getContractAST`).
 *   2. A simulation — deploy a contract into a session, call it, and trace
 *      the call. The contract exists only inside the session, so its AST
 *      comes from `parseContract` on the source you deployed.
 *
 *   pnpm sample:vitest
 *
 * Tests hit https://api.stxer.xyz; they need network. Set
 * STXER_SKIP_NETWORK_TESTS=1 to skip in offline environments.
 *
 * Both scenarios are pinned to settled mainnet blocks, so every assertion
 * is exact.
 */
import { STACKS_MAINNET } from '@stacks/network';
import {
  ClarityVersion,
  cvToString,
  makeUnsignedContractDeploy,
  PostConditionMode,
  uintCV,
} from '@stacks/transactions';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  bytesToHex,
  callContract,
  createSimulationSession,
  flattenTrace,
  getContractAST,
  getSimulationTrace,
  getTransactionTrace,
  indexExpressions,
  parseContract,
  SimulationError,
  type SymbolicExpression,
  setSender,
  sliceSpan,
  submitSimulationSteps,
  type Trace,
  TraceFetchError,
  type TraceValue,
  traceContractIds,
  traceNodeCost,
  traceNodeSelfCost,
} from '..';
import { apiOptions } from './_helpers';

const SKIP = process.env.STXER_SKIP_NETWORK_TESTS === '1';
const scenario = SKIP ? describe.skip : describe;

const show = (value: TraceValue) =>
  typeof value === 'string' ? value : cvToString(value);

// -----------------------------------------------------------------------------
// 1. An on-chain transaction
// -----------------------------------------------------------------------------

// An ALEX swap. `BLOCK_HASH` is the Stacks block hash — `block_hash` on the
// transaction as the Stacks API returns it — not the index_block_hash.
const BLOCK_HEIGHT = 1_018_838;
const BLOCK_HASH =
  '89945f0d9956794d453adb28d78302002a1d16885d8b4de3ee598ec69c631a54';
const SWAP_TXID =
  'c1bfb9616c51a17859c48f1716eefdd5ea9646f59b8e6c082033370ae17e33fa';
// A plain STX transfer mined in the same block.
const TRANSFER_TXID =
  '02fa25d1fbcd85866d0fd99b1c834b18af38a933031983c049f0921f9b4648ff';

const ALEX = 'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM';
const POOL = `${ALEX}.amm-pool-v2-01`;

scenario('trace of an on-chain transaction', () => {
  let trace: Trace;

  beforeAll(async () => {
    trace = await getTransactionTrace({
      blockHeight: BLOCK_HEIGHT,
      // Pasted straight from an explorer: the 0x prefix is accepted.
      blockHash: `0x${BLOCK_HASH}`,
      txid: `0x${SWAP_TXID}`,
      ...apiOptions(),
    });
  });

  it('identifies the transaction it belongs to', () => {
    expect(trace.block_hash).toBe(BLOCK_HASH);
    expect(trace.txid).toBe(SWAP_TXID);
  });

  it('starts at the function the transaction called', () => {
    expect(trace.root.code).toBe(`${POOL}:swap-helper`);
    expect(show(trace.root.result)).toBe('(ok u112248824)');
  });

  it('resolves the contract of every node', () => {
    const visits = flattenTrace(trace.root);
    expect(visits.every(({ contractId }) => contractId !== undefined)).toBe(
      true,
    );
    expect(traceContractIds(trace.root)).toEqual(
      expect.arrayContaining([
        POOL,
        `${ALEX}.amm-registry-v2-01`,
        `${ALEX}.amm-vault-v2-01`,
        `${ALEX}.token-alex`,
      ]),
    );
  });

  it('accounts for cost inclusively: a node covers its children', () => {
    expect(traceNodeCost(trace.root).runtime).toBe(540_244);
    for (const { node } of flattenTrace(trace.root)) {
      const children = node.children.reduce(
        (sum, child) => sum + traceNodeCost(child).runtime,
        0,
      );
      expect(traceNodeCost(node).runtime).toBeGreaterThanOrEqual(children);
    }
  });

  it('partitions cost: self costs add up to the whole transaction', () => {
    const byContract = new Map<string, number>();
    for (const { node, contractId = '' } of flattenTrace(trace.root)) {
      const spent = traceNodeSelfCost(node).runtime;
      byContract.set(contractId, (byContract.get(contractId) ?? 0) + spent);
    }
    const total = Array.from(byContract.values()).reduce((a, b) => a + b, 0);
    expect(total).toBe(traceNodeCost(trace.root).runtime);
    // Most of a swap's runtime is spent in the pool itself.
    expect(byContract.get(POOL)).toBeGreaterThan(total / 2);
  });

  it('maps nodes back to the on-chain source', async () => {
    const ast = await getContractAST({ contractId: POOL, ...apiOptions() });
    const byId = indexExpressions(ast.expressions);
    const source = ast.source_code as string;

    // Every node evaluated inside the pool has an expression behind it.
    const inPool = flattenTrace(trace.root).filter(
      ({ contractId }) => contractId === POOL,
    );
    expect(inPool.length).toBeGreaterThan(0);
    expect(inPool.every(({ node }) => byId.has(node.id))).toBe(true);

    const isSome = trace.root.children[0];
    expect(isSome.func).toBe('is-some');
    expect(
      sliceSpan(source, (byId.get(isSome.id) as SymbolicExpression).span),
    ).toBe(
      '(is-some (get-pool-exists (contract-of token-x-trait) (contract-of token-y-trait) factor))',
    );
  });

  it('has no trace for a transaction that ran no Clarity code', async () => {
    const error = await getTransactionTrace({
      blockHeight: BLOCK_HEIGHT,
      blockHash: BLOCK_HASH,
      txid: TRANSFER_TXID,
      ...apiOptions(),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TraceFetchError);
    expect((error as TraceFetchError).status).toBe(404);
  });
});

// -----------------------------------------------------------------------------
// 2. A simulated transaction
// -----------------------------------------------------------------------------

const SENDER = 'SP212Y5JKN59YP3GYG07K3S8W5SSGE4KH6B5STXER';
const CONTRACT_NAME = 'traced-counter';
const CONTRACT_ID = `${SENDER}.${CONTRACT_NAME}`;

// Pinned fork point, shared with contract-vitest.test.ts. SENDER's nonce
// there is 10.
const FORK_BLOCK_HEIGHT = 7_760_000;
const FORK_BLOCK_HASH =
  'f1c3927e12edec74aa05e7e8fa99a6d2e4b97f9b8566389aebd8a1c8a4926698';
const FORK_NONCE = 10n;

const SOURCE = `(define-data-var counter uint u0)

(define-public (increment (delta uint))
  (begin
    (asserts! (< delta u10) (err u400))
    (var-set counter (+ (var-get counter) delta))
    (ok (var-get counter))))
`;

async function deployInto(simulationId: string) {
  const deploy = await makeUnsignedContractDeploy({
    contractName: CONTRACT_NAME,
    codeBody: SOURCE,
    clarityVersion: ClarityVersion.Clarity3,
    nonce: FORK_NONCE,
    fee: 1_000n,
    network: STACKS_MAINNET,
    publicKey: '0'.repeat(66),
    postConditionMode: PostConditionMode.Allow,
  });
  setSender(deploy, SENDER);
  await submitSimulationSteps(
    simulationId,
    { steps: [{ Transaction: bytesToHex(deploy.serializeBytes()) }] },
    apiOptions(),
  );
}

const increment = (simulationId: string, delta: number) =>
  callContract(
    simulationId,
    {
      sender: SENDER,
      contract: CONTRACT_ID,
      functionName: 'increment',
      functionArgs: [uintCV(delta)],
    },
    apiOptions(),
  );

scenario('trace of a simulated transaction', () => {
  let simulationId: string;
  let sourceOf: (id: number) => string;

  beforeAll(async () => {
    simulationId = await createSimulationSession(
      { block_height: FORK_BLOCK_HEIGHT, block_hash: FORK_BLOCK_HASH },
      apiOptions(),
    );
    await deployInto(simulationId);

    // The contract is not on chain, so `getContractAST` cannot know it.
    // Parse the source that was deployed instead; the ids line up.
    const ast = await parseContract({
      contractId: CONTRACT_ID,
      sourceCode: SOURCE,
      clarityVersion: '3',
      ...apiOptions(),
    });
    const byId = indexExpressions(ast.expressions);
    sourceOf = (id) =>
      sliceSpan(SOURCE, (byId.get(id) as SymbolicExpression).span);
  });

  it('traces a successful call, down to each sub-expression', async () => {
    const call = await increment(simulationId, 3);
    expect(call.result).toBe('(ok u3)');

    const trace = await getSimulationTrace({
      simulationId,
      txid: call.txid,
      ...apiOptions(),
    });

    // A simulated transaction is in no block.
    expect(trace.txid).toBe(call.txid);
    expect(trace.block_hash).toBe('0'.repeat(64));

    expect(trace.root.code).toBe(`${CONTRACT_ID}:increment`);
    expect(show(trace.root.result)).toBe('(ok u3)');
    expect(traceContractIds(trace.root)).toEqual([CONTRACT_ID]);

    // The body's three statements, each mapped to its exact source.
    expect(trace.root.children.map(({ id }) => sourceOf(id))).toEqual([
      '(asserts! (< delta u10) (err u400))',
      '(var-set counter (+ (var-get counter) delta))',
      '(ok (var-get counter))',
    ]);

    const comparison = flattenTrace(trace.root).find(
      ({ node }) => node.func === '<',
    );
    expect(comparison?.node.args.map(show)).toEqual(['u3', 'u10']);
    expect(comparison && show(comparison.node.result)).toBe('true');
  });

  it('shows where a failing call gave up', async () => {
    const call = await increment(simulationId, 50);
    // The transaction's result is an ordinary value…
    expect(call.result).toBe('(err u400)');

    const trace = await getSimulationTrace({
      simulationId,
      txid: call.txid,
      ...apiOptions(),
    });

    // …produced by an early return, which the trace records as a string
    // on the `asserts!` that raised it and on everything it unwound.
    const [asserts, ...rest] = trace.root.children;
    expect(sourceOf(asserts.id)).toBe('(asserts! (< delta u10) (err u400))');
    expect(asserts.result).toEqual(expect.stringContaining('AssertionFailed'));
    expect(trace.root.result).toBe(asserts.result);
    // Nothing after the assertion ran.
    expect(rest).toEqual([]);

    const comparison = asserts.children[0];
    expect(comparison.args.map(show)).toEqual(['u50', 'u10']);
    expect(show(comparison.result)).toBe('false');
  });

  it('records no trace when the session skips tracing', async () => {
    const untraced = await createSimulationSession(
      {
        block_height: FORK_BLOCK_HEIGHT,
        block_hash: FORK_BLOCK_HASH,
        skip_tracing: true,
      },
      apiOptions(),
    );
    await deployInto(untraced);
    const call = await increment(untraced, 3);
    expect(call.result).toBe('(ok u3)');

    const error = await getSimulationTrace({
      simulationId: untraced,
      txid: call.txid,
      ...apiOptions(),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SimulationError);
    expect((error as SimulationError).status).toBe(404);
  });
});
