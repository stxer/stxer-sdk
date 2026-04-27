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
  createSimulationSession,
  getSimulationResult,
  getTip,
  type SimulationStepInput,
  submitSimulationSteps,
} from '..';
import { bytesToHex, getNonce, setSender } from './_helpers';

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

async function main() {
  const tip = await getTip();
  console.log(`tip @ block ${tip.block_height}`);

  const simulationId = await createSimulationSession({
    block_height: tip.block_height,
    block_hash: tip.block_hash,
    skip_tracing: true,
  });
  console.log(`session: ${simulationId}`);

  let nonce = await getNonce(SENDER, tip.index_block_hash);

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

  const incrementTx = await makeUnsignedContractCall({
    contractAddress: SENDER,
    contractName: CONTRACT_NAME,
    functionName: 'increment',
    functionArgs: [uintCV(10)],
    nonce: nonce++,
    network: STACKS_MAINNET,
    publicKey: '',
    postConditionMode: PostConditionMode.Allow,
    fee: 0,
  });
  setSender(incrementTx, SENDER);

  // Each entry exercises one variant of `SimulationStepInput`.
  const steps: SimulationStepInput[] = [
    { Transaction: bytesToHex(deployTx.serializeBytes()) },
    // Eval — labeled tuple [sender, sponsor, contract_id, code]; "" sponsor when none.
    { Eval: [SENDER, '', CONTRACT_ID, '(get-counter)'] },
    { Transaction: bytesToHex(incrementTx.serializeBytes()) },
    { Eval: [SENDER, '', CONTRACT_ID, '(get-counter)'] },
    // Reads — each entry is a tagged read step (`MapEntry`, `DataVar`, etc.).
    {
      Reads: [{ DataVar: [CONTRACT_ID, 'counter'] }, { Nonce: SENDER }],
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

  // The GET endpoint returns a *summary* — different shape, includes
  // each step's original input alongside the result.
  const summary = await getSimulationResult(simulationId);
  console.log(
    `summary: ${summary.steps.length} steps, epoch ${summary.metadata.epoch}`,
  );
  console.log(
    `view trace: https://stxer.xyz/simulations/mainnet/${simulationId}`,
  );
}

if (require.main === module) {
  main().catch(console.error);
}
