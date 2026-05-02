/**
 * Demonstrates the four failure signals on a simulation receipt.
 * Deploys a bug-zoo contract, calls one trigger function per failure
 * mode in a single session, and prints which signals fired for each.
 *
 *   1. Outer `Err` on `Result.Transaction`        — engine refused the tx
 *                                                    (no receipt produced)
 *   2. `post_condition_aborted: true`             — post-condition tripped,
 *                                                    state rolled back. Note:
 *                                                    `vm_error` is also set
 *                                                    in this case (to the
 *                                                    abort reason).
 *   3. `vm_error: string` w/o PC abort             — Clarity VM raised a
 *                                                    runtime error
 *   4. `(err uX)` inside `result`                  — contract returned a
 *                                                    Clarity error response.
 *                                                    NOT signalled by any
 *                                                    field above; decode
 *                                                    `result` to detect.
 *
 * `post_condition_aborted` IMPLIES `vm_error` is set; the reverse is
 * not true. Always check `post_condition_aborted` first to disambiguate
 * between a PC abort and a plain VM/analysis failure.
 *
 * Also shows that each `events[i]` is a JSON-encoded *string* — the
 * caller must `JSON.parse` it to get the event object.
 */
import { STACKS_MAINNET } from '@stacks/network';
import {
  ClarityVersion,
  makeUnsignedContractCall,
  makeUnsignedContractDeploy,
  PostConditionMode,
} from '@stacks/transactions';
import {
  bytesToHex,
  createSimulationSession,
  getTip,
  parseSimulationEvent,
  type SimulationStepInput,
  setSender,
  submitSimulationSteps,
  type TransactionReceipt,
} from '..';
import { getOnChainNonce } from './_helpers';

const SENDER = 'SP212Y5JKN59YP3GYG07K3S8W5SSGE4KH6B5STXER';
const CONTRACT_NAME = 'failure-zoo';

const SOURCE = `
;; Bug zoo -- one public trigger per failure mode.

;; Returns a Clarity-level (err uX). Receipt is Ok, vm_error is null,
;; post_condition_aborted is false; the err lives inside .result as hex.
(define-public (return-err)
  (err u42))

;; Triggers a VM runtime error. Division by zero is non-recoverable
;; and surfaces as a populated vm_error.
(define-public (vm-panic)
  (ok (/ u1 u0)))

;; Emits a contract event we can JSON.parse.
(define-public (emit-event)
  (begin
    (print { kind: "demo", payload: "hello" })
    (ok true)))
`;

function describe(r: TransactionReceipt): string {
  const tags: string[] = [];
  if (r.post_condition_aborted) tags.push('post_condition_aborted');
  if (r.vm_error != null) tags.push(`vm_error=${JSON.stringify(r.vm_error)}`);
  // A Clarity-level error is encoded inside the hex `result`. The
  // SIP-005 prefix for `(err ...)` (response::err variant) is `0x08`
  // (one byte after the leading type tag); a quick way to spot it is
  // checking whether the hex starts with `08`.
  if (r.result.startsWith('08')) tags.push(`clarity-err result=${r.result}`);
  if (tags.length === 0) tags.push('clean');
  return tags.join(', ');
}

async function main() {
  const tip = await getTip();
  const simulationId = await createSimulationSession({
    block_height: tip.block_height,
    block_hash: tip.block_hash,
    skip_tracing: true,
  });
  console.log(`session: ${simulationId}`);

  let nonce = await getOnChainNonce(SENDER, tip.index_block_hash);

  const buildCall = async (functionName: string) => {
    const tx = await makeUnsignedContractCall({
      contractAddress: SENDER,
      contractName: CONTRACT_NAME,
      functionName,
      functionArgs: [],
      nonce: nonce++,
      network: STACKS_MAINNET,
      publicKey: '',
      postConditionMode: PostConditionMode.Allow,
      fee: 0,
    });
    setSender(tx, SENDER);
    return bytesToHex(tx.serializeBytes());
  };

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

  const labels = ['deploy', 'return-err', 'vm-panic', 'emit-event'];
  const steps: SimulationStepInput[] = [
    { Transaction: bytesToHex(deployTx.serializeBytes()) },
    { Transaction: await buildCall('return-err') },
    { Transaction: await buildCall('vm-panic') },
    { Transaction: await buildCall('emit-event') },
  ];

  const resp = await submitSimulationSteps(simulationId, { steps });

  for (const [i, step] of resp.steps.entries()) {
    const label = labels[i] ?? `#${i}`;
    if (!('Transaction' in step)) continue;
    const tx = step.Transaction;
    if ('Err' in tx) {
      // (1) Engine-level failure. Hard to trigger from an otherwise-valid
      // tx — usually surfaces when the upstream cannot deserialize or
      // pre-flight-validate the transaction at all.
      console.log(`[${label}] outer Err: ${tx.Err}`);
      continue;
    }
    const r = tx.Ok;
    console.log(`[${label}] receipt — ${describe(r)}`);
    for (const ev of r.events) {
      // Typed parse — `event` is narrowed by `event.type`.
      const event = parseSimulationEvent(ev);
      if (event.type === 'contract_event') {
        const { contract_identifier, topic, raw_value } = event.contract_event;
        console.log(
          `  ${event.type}: ${contract_identifier} topic=${topic} raw_value=${raw_value}`,
        );
      } else {
        console.log(`  ${event.type}:`, event);
      }
    }
  }

  // (2) post_condition_aborted requires a tx that actually moves an
  // asset under a deny post-condition. This sample's vanity sender has
  // no STX/FT balance on mainnet, so it can't legitimately trigger an
  // asset move; in your own samples, send a tx whose `postConditions`
  // disallow the asset movement that the contract performs — the
  // receipt's `post_condition_aborted` will be `true` while
  // `vm_error` stays `null`.
}

if (require.main === module) {
  main().catch(console.error);
}
