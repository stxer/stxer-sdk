/**
 * Direct stxer Simulation v2 lifecycle, no SimulationBuilder:
 *   createSimulationSession -> submitSimulationSteps -> getSimulationResult.
 *
 * Demonstrates every `SimulationStepInput` shape (Transaction / Eval /
 * SetContractCode / Reads / TenureExtend) and how to narrow on the
 * `SimulationStepResult` discriminated union the POST endpoint returns.
 */
import { STACKS_MAINNET } from '@stacks/network';
import {
  ClarityVersion,
  makeUnsignedContractCall,
  makeUnsignedContractDeploy,
  PostConditionMode,
  uintCV,
} from '@stacks/transactions';
import {
  bytesToHex,
  createSimulationSession,
  getSimulationResult,
  getTip,
  type SimulationStepInput,
  setSender,
  submitSimulationSteps,
} from '..';
import { getOnChainNonce } from './_helpers';

const SENDER = 'SP212Y5JKN59YP3GYG07K3S8W5SSGE4KH6B5STXER';
const CONTRACT_NAME = 'sample-counter';
const CONTRACT_ID = `${SENDER}.${CONTRACT_NAME}`;

const SOURCE = `
;; counter example
(define-data-var counter uint u0)

(define-public (increment (delta uint))
  (begin
    (print { event: "increment", delta: delta })
    (var-set counter (+ (var-get counter) delta))
    (ok (var-get counter))))

(define-read-only (get-counter)
  (ok (var-get counter)))
`;

// Replacement source patched in via SetContractCode mid-session: doubles
// the increment delta so we can observe the rewritten behavior on the
// next call.
const SOURCE_DOUBLED = `
(define-data-var counter uint u0)

(define-public (increment (delta uint))
  (begin
    (print { event: "increment-doubled", delta: delta })
    (var-set counter (+ (var-get counter) (* delta u2)))
    (ok (var-get counter))))

(define-read-only (get-counter)
  (ok (var-get counter)))
`;

async function main() {
  const tip = await getTip();
  console.log(`tip @ block ${tip.block_height}`);

  const simulationId = await createSimulationSession({
    block_height: tip.block_height,
    block_hash: tip.block_hash,
    skip_tracing: true,
  });
  console.log(`session: ${simulationId}`);

  let nonce = await getOnChainNonce(SENDER, tip.index_block_hash);

  const deployTx = await makeUnsignedContractDeploy({
    contractName: CONTRACT_NAME,
    codeBody: SOURCE,
    nonce: nonce++,
    network: STACKS_MAINNET,
    publicKey: '',
    postConditionMode: PostConditionMode.Allow,
    fee: 0,
    clarityVersion: ClarityVersion.Clarity3,
  });
  setSender(deployTx, SENDER);

  const buildIncrement = async (delta: number) => {
    const tx = await makeUnsignedContractCall({
      contractAddress: SENDER,
      contractName: CONTRACT_NAME,
      functionName: 'increment',
      functionArgs: [uintCV(delta)],
      nonce: nonce++,
      network: STACKS_MAINNET,
      publicKey: '',
      postConditionMode: PostConditionMode.Allow,
      fee: 0,
    });
    setSender(tx, SENDER);
    return bytesToHex(tx.serializeBytes());
  };

  // Each entry exercises one variant of `SimulationStepInput`.
  const steps: SimulationStepInput[] = [
    { Transaction: bytesToHex(deployTx.serializeBytes()) },
    // Eval — labeled tuple [sender, sponsor, contract_id, code]; "" sponsor when none.
    { Eval: [SENDER, '', CONTRACT_ID, '(get-counter)'] },
    { Transaction: await buildIncrement(10) },
    { Eval: [SENDER, '', CONTRACT_ID, '(get-counter)'] },
    // SetContractCode — labeled tuple [contract_id, source_code, clarity_version].
    // Replaces the contract source in-place so the next increment runs
    // the patched logic.
    { SetContractCode: [CONTRACT_ID, SOURCE_DOUBLED, 3] },
    { Transaction: await buildIncrement(10) },
    { Eval: [SENDER, '', CONTRACT_ID, '(get-counter)'] },
    // Reads — each entry is a tagged read step. All 7 read shapes are
    // exercised here so every `ReadStep` variant has wire coverage.
    {
      Reads: [
        { DataVar: [CONTRACT_ID, 'counter'] },
        { Nonce: SENDER },
        { StxBalance: SENDER },
        {
          EvalReadonly: [SENDER, '', CONTRACT_ID, '(get-counter)'],
        },
        // The vanity sender owns no FTs / map entries on the deployed
        // counter, so these will return Err — which is exactly what we
        // want: it confirms the SDK narrows on `Err` cleanly.
        // Map key is a hex-serialized Clarity value; `09` is `(none)`,
        // the shortest valid placeholder.
        { MapEntry: [CONTRACT_ID, 'no-such-map', '09'] },
        { FtBalance: [CONTRACT_ID, 'no-such-ft', SENDER] },
        { FtSupply: [CONTRACT_ID, 'no-such-ft'] },
      ],
    },
    // TenureExtend — empty tuple; result variant carries the running cost.
    { TenureExtend: [] },
  ];

  const submitResp = await submitSimulationSteps(simulationId, { steps });

  // Walk the discriminated `SimulationStepResult` union.
  for (const [i, step] of submitResp.steps.entries()) {
    if ('Transaction' in step) {
      const tx = step.Transaction;
      if ('Ok' in tx) {
        const r = tx.Ok;
        console.log(`#${i} Transaction Ok`, {
          result: r.result, // hex-serialized Clarity; (err uX) lives here
          vm_error: r.vm_error,
          post_condition_aborted: r.post_condition_aborted,
          stx_burned: r.stx_burned,
        });
        // events[i] is a JSON-encoded *string* — must JSON.parse.
        for (const ev of r.events) {
          console.log('  event:', JSON.parse(ev));
        }
      } else {
        // Engine-level failure (deserialization, etc.) — no receipt.
        console.error(`#${i} Transaction Err: ${tx.Err}`);
      }
    } else if ('Eval' in step) {
      const r = step.Eval;
      console.log(`#${i} Eval`, 'Ok' in r ? r.Ok : `Err: ${r.Err}`);
    } else if ('Reads' in step) {
      step.Reads.forEach((rr, j) => {
        console.log(`#${i}.${j} Read`, 'Ok' in rr ? rr.Ok : `Err: ${rr.Err}`);
      });
    } else if ('SetContractCode' in step) {
      const r = step.SetContractCode;
      console.log(`#${i} SetContractCode`, 'Ok' in r ? 'ok' : `Err: ${r.Err}`);
    } else if ('TenureExtend' in step) {
      console.log(`#${i} TenureExtend cost`, step.TenureExtend);
    }
  }

  // The GET endpoint returns a *summary* — different shape from the
  // POST response: each step carries its original input alongside the
  // result. Narrow on the `SimulationStepSummary` discriminated union.
  const summary = await getSimulationResult(simulationId);
  console.log(
    `\nsummary: ${summary.steps.length} steps @ block ${summary.metadata.block_height} (epoch ${summary.metadata.epoch})`,
  );
  for (const [i, s] of summary.steps.entries()) {
    if ('Transaction' in s) {
      // TransactionStepSummary — original tx hex + TxId + Result + ExecutionCost.
      // TxId is `""` (empty string) when the tx failed engine-level.
      console.log(
        `  #${i} Transaction txid=${s.TxId.slice(0, 10) || '<none>'}… runtime_us=${s.ExecutionCost.runtime}`,
      );
    } else if ('Reads' in s) {
      // ReadsStepSummary — original ReadStep[] + Result.Reads[]
      console.log(`  #${i} Reads (${s.Reads.length} read steps)`);
    } else if ('SetContractCode' in s) {
      // SetContractCodeStepSummary — labeled tuple [contract_id, code, version]
      const [contractId, , version] = s.SetContractCode;
      console.log(`  #${i} SetContractCode ${contractId} (clarity ${version})`);
    } else if ('Eval' in s) {
      // EvalStepSummary — labeled tuple [sender, sponsor, contract_id, code]
      const [, , , code] = s.Eval;
      console.log(`  #${i} Eval ${code}`);
    } else if ('TenureExtend' in s) {
      console.log(`  #${i} TenureExtend cost`, s.Result.TenureExtend);
    } else if ('AdvanceBlocks' in s) {
      const r = s.Result.AdvanceBlocks;
      if ('Ok' in r) {
        console.log(`  #${i} AdvanceBlocks → ${r.Ok.length} blocks`);
      } else {
        console.log(`  #${i} AdvanceBlocks Err: ${r.Err}`);
      }
    }
  }
  console.log(
    `\nview trace: https://stxer.xyz/simulations/mainnet/${simulationId}`,
  );
}

if (require.main === module) {
  main().catch(console.error);
}
