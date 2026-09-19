/**
 * Debug trace walkthrough: profile an on-chain transaction.
 *
 *   - fetch and decode the trace            (`getTransactionTrace`)
 *   - attribute its runtime to contracts    (`flattenTrace`, `traceNodeSelfCost`)
 *   - find the costliest expressions and print the source behind each
 *                                           (`getContractAST`, `indexExpressions`, `sliceSpan`)
 *
 * The transaction is an ALEX swap in a settled mainnet block, so the
 * output is the same on every run. Point the constants at any other
 * contract call to profile that instead — `block_height` and `block_hash`
 * are on the transaction as the Stacks API returns it.
 */
import { cvToString } from '@stacks/transactions';
import {
  flattenTrace,
  getContractAST,
  getTransactionTrace,
  indexExpressions,
  type SymbolicExpression,
  sliceSpan,
  type TraceValue,
  traceContractIds,
  traceNodeCost,
  traceNodeSelfCost,
} from '..';
import { apiOptions } from './_helpers';

const BLOCK_HEIGHT = 1_018_838;
const BLOCK_HASH =
  '89945f0d9956794d453adb28d78302002a1d16885d8b4de3ee598ec69c631a54';
const TXID = 'c1bfb9616c51a17859c48f1716eefdd5ea9646f59b8e6c082033370ae17e33fa';

const HOT_SPOTS = 5;

const show = (value: TraceValue) =>
  typeof value === 'string' ? value : cvToString(value);

const oneLine = (source: string, width = 72) => {
  const flat = source.replace(/\s+/g, ' ');
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
};

const percent = (part: number, whole: number) =>
  `${((100 * part) / whole).toFixed(1)}%`.padStart(6);

async function main() {
  const trace = await getTransactionTrace({
    blockHeight: BLOCK_HEIGHT,
    blockHash: BLOCK_HASH,
    txid: TXID,
    ...apiOptions(),
  });
  const { root } = trace;
  const visits = flattenTrace(root);
  const total = traceNodeCost(root);

  console.log(`transaction  0x${trace.txid}`);
  console.log(`called       ${root.code}`);
  console.log(`returned     ${show(root.result)}`);
  console.log(`evaluated    ${visits.length} expressions`);
  console.log('cost        ', total);

  // Self costs partition the trace, so grouping them by contract accounts
  // for the whole transaction exactly once.
  const runtimeByContract = new Map<string, number>();
  for (const { node, contractId = '(none)' } of visits) {
    runtimeByContract.set(
      contractId,
      (runtimeByContract.get(contractId) ?? 0) +
        traceNodeSelfCost(node).runtime,
    );
  }
  console.log('\nruntime by contract');
  for (const [contractId, runtime] of Array.from(runtimeByContract).sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`  ${percent(runtime, total.runtime)}  ${contractId}`);
  }

  // A node's `id` is only meaningful next to its contract's AST, so load
  // one AST per contract the trace touched.
  const contracts = new Map<
    string,
    { source: string; byId: Map<number, SymbolicExpression> }
  >();
  for (const contractId of traceContractIds(root)) {
    const ast = await getContractAST({ contractId, ...apiOptions() });
    contracts.set(contractId, {
      source: ast.source_code ?? '',
      byId: indexExpressions(ast.expressions),
    });
  }

  console.log(`\ntop ${HOT_SPOTS} expressions by their own runtime`);
  const hottest = [...visits]
    .sort(
      (a, b) =>
        traceNodeSelfCost(b.node).runtime - traceNodeSelfCost(a.node).runtime,
    )
    .slice(0, HOT_SPOTS);
  for (const { node, contractId = '' } of hottest) {
    const contract = contracts.get(contractId);
    const expression = contract?.byId.get(node.id);
    const runtime = traceNodeSelfCost(node).runtime;
    console.log(
      `  ${percent(runtime, total.runtime)}  ${node.func}  →  ${oneLine(show(node.result), 40)}`,
    );
    if (contract && expression) {
      console.log(`          ${contractId.split('.')[1]} @ ${expression.span}`);
      console.log(
        `          ${oneLine(sliceSpan(contract.source, expression.span))}`,
      );
    }
  }
}

if (require.main === module) {
  main().catch(console.error);
}
