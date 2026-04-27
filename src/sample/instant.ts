/**
 * One-shot instant simulation:
 *   - submit a single transaction
 *   - run a batch of reads against the simulated post-state
 *   - receive { receipt, reads } in the response
 *
 * Demonstrates `InstantSimulationRequest` / `InstantSimulationResponse`,
 * exercises every variant of `ReadStep` (MapEntry, DataVar, EvalReadonly,
 * StxBalance, FtBalance, FtSupply, Nonce), and confirms that
 * `result.reads` is always present (may be `[]`) — the SDK type is
 * required, not optional.
 */
import { STACKS_MAINNET } from '@stacks/network';
import {
  makeUnsignedContractCall,
  PostConditionMode,
  principalCV,
  serializeCV,
  tupleCV,
  uintCV,
} from '@stacks/transactions';
import { getTip, instantSimulation, type ReadStep } from '..';
import { bytesToHex, getNonce, setSender } from './_helpers';

const ALEX_TOKEN = 'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.token-alex';
const ALEX_VAULT = 'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.amm-vault-v2-01';
const ALEX_REGISTRY =
  'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.amm-registry-v2-01';
const SENDER = 'SP212Y5JKN59YP3GYG07K3S8W5SSGE4KH6B5STXER';

async function main() {
  const tip = await getTip();
  const nonce = await getNonce(SENDER, tip.index_block_hash);

  // Contract-call tx hitting a read-only function — produces a receipt
  // with no state change (so a no-asset sender is fine).
  const tx = await makeUnsignedContractCall({
    contractAddress: 'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM',
    contractName: 'token-alex',
    functionName: 'get-balance',
    functionArgs: [principalCV(ALEX_VAULT)],
    nonce,
    network: STACKS_MAINNET,
    publicKey: '',
    postConditionMode: PostConditionMode.Allow,
    fee: 0,
  });
  setSender(tx, SENDER);

  // One entry per ReadStep variant.
  const reads: ReadStep[] = [
    {
      MapEntry: [
        ALEX_REGISTRY,
        'pools-data-map',
        serializeCV(
          tupleCV({
            'token-x': principalCV(
              'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.token-wstx-v2',
            ),
            'token-y': principalCV(ALEX_TOKEN),
            factor: uintCV(1e8),
          }),
        ),
      ],
    },
    { DataVar: [ALEX_VAULT, 'paused'] },
    { EvalReadonly: [SENDER, '', ALEX_TOKEN, '(get-name)'] },
    { StxBalance: ALEX_VAULT },
    { FtBalance: [ALEX_TOKEN, 'alex', ALEX_VAULT] },
    { FtSupply: [ALEX_TOKEN, 'alex'] },
    { Nonce: ALEX_VAULT },
  ];

  const result = await instantSimulation({
    transaction: bytesToHex(tx.serializeBytes()),
    block_height: tip.block_height,
    block_hash: tip.block_hash,
    reads,
  });

  // result.reads is always an array, positionally aligned with input reads.
  console.log(`reads (${result.reads.length}):`);
  const labels = [
    'MapEntry    ',
    'DataVar     ',
    'EvalReadonly',
    'StxBalance  ',
    'FtBalance   ',
    'FtSupply    ',
    'Nonce       ',
  ];
  result.reads.forEach((r, i) => {
    console.log(`  ${labels[i]} ${'Ok' in r ? r.Ok : `Err: ${r.Err}`}`);
  });

  const r = result.receipt;
  console.log('receipt:', {
    result: r.result,
    vm_error: r.vm_error,
    post_condition_aborted: r.post_condition_aborted,
    stx_burned: r.stx_burned,
    tx_index: r.tx_index,
    runtime_us: r.execution_cost.runtime,
    wall_ms: r.costs,
  });
  // events[i] is a JSON-encoded string — JSON.parse to get the event object.
  for (const ev of r.events) {
    console.log('event:', JSON.parse(ev));
  }
}

if (require.main === module) {
  main().catch(console.error);
}
