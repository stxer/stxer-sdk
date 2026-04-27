/**
 * Vitest example: drive a Clarity contract through stxer Simulation v2
 * and assert on the typed responses.
 *
 * Each `describe` block creates its own session in `beforeAll` so its
 * tests share state — the counter scenarios accumulate within a
 * scenario, but scenarios are isolated from one another.
 *
 *   pnpm sample:vitest
 *
 * Tests hit https://api.stxer.xyz; they need network and spend a few
 * seconds per session. Set STXER_SKIP_NETWORK_TESTS=1 to skip in
 * offline / CI-without-internet environments.
 *
 * The fork point and starting nonce are pinned to a settled mainnet
 * block so the chain state the simulator forks from is identical on
 * every run — assertions on receipt.result and event hex stay
 * deterministic. Bump the constants below when the upstream prunes
 * the snapshot.
 */
import { STACKS_MAINNET } from '@stacks/network';
import {
  ClarityVersion,
  makeUnsignedContractCall,
  makeUnsignedContractDeploy,
  PostConditionMode,
  uintCV,
} from '@stacks/transactions';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createSimulationSession,
  parseSimulationEvent,
  type SimulationStepInput,
  submitSimulationSteps,
} from '..';
import { bytesToHex, setSender } from './_helpers';

const SKIP = process.env.STXER_SKIP_NETWORK_TESTS === '1';
const scenario = SKIP ? describe.skip : describe;

const SENDER = 'SP212Y5JKN59YP3GYG07K3S8W5SSGE4KH6B5STXER';
const CONTRACT_NAME = 'counter-under-test';
const CONTRACT_ID = `${SENDER}.${CONTRACT_NAME}`;

// Pinned mainnet fork point. SENDER's nonce at this index_block_hash is
// FIXED_NONCE — verified once via Hiro and hardcoded so the test is
// self-contained.
const FIXED_BLOCK_HEIGHT = 7_760_000;
const FIXED_BLOCK_HASH =
  'f1c3927e12edec74aa05e7e8fa99a6d2e4b97f9b8566389aebd8a1c8a4926698';
const FIXED_NONCE = 10n;

const SOURCE = `
(define-data-var counter uint u0)

(define-public (increment (delta uint))
  (begin
    (print { event: "increment", delta: delta })
    (var-set counter (+ (var-get counter) delta))
    (ok (var-get counter))))

(define-public (always-err)
  (err u100))

(define-public (panic)
  (ok (/ u1 u0)))

(define-read-only (get-counter)
  (ok (var-get counter)))
`;

interface Session {
  id: string;
  buildIncrement: (delta: number) => Promise<string>;
  buildCall: (functionName: string) => Promise<string>;
  submit: (
    steps: SimulationStepInput[],
  ) => ReturnType<typeof submitSimulationSteps>;
}

async function setupSession(): Promise<Session> {
  const id = await createSimulationSession({
    block_height: FIXED_BLOCK_HEIGHT,
    block_hash: FIXED_BLOCK_HASH,
    skip_tracing: true,
  });
  let nonce = FIXED_NONCE;

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

  const submit = (steps: SimulationStepInput[]) =>
    submitSimulationSteps(id, { steps });

  // Deploy once. Verify deploy succeeded so later tests can assume it.
  const deployResp = await submit([
    { Transaction: bytesToHex(deployTx.serializeBytes()) },
  ]);
  const deployStep = deployResp.steps[0];
  if (!('Transaction' in deployStep) || !('Ok' in deployStep.Transaction)) {
    throw new Error(`deploy failed: ${JSON.stringify(deployStep)}`);
  }

  return { id, buildIncrement, buildCall, submit };
}

scenario('counter contract — happy path', () => {
  let s: Session;
  beforeAll(async () => {
    s = await setupSession();
  }, 30_000);

  it('starts at u0', async () => {
    const r = await s.submit([
      { Eval: [SENDER, '', CONTRACT_ID, '(get-counter)'] },
    ]);
    const step = r.steps[0];
    if (!('Eval' in step) || !('Ok' in step.Eval)) {
      throw new Error(`expected Eval.Ok, got ${JSON.stringify(step)}`);
    }
    // (ok u0) — SIP-005 hex: 07 (response::ok) 01 (uint) 00...00 (16 bytes)
    expect(step.Eval.Ok).toBe('070100000000000000000000000000000000');
  });

  it('increments to u5 and emits a print event', async () => {
    const r = await s.submit([{ Transaction: await s.buildIncrement(5) }]);
    const step = r.steps[0];
    if (!('Transaction' in step) || !('Ok' in step.Transaction)) {
      throw new Error(`expected Transaction.Ok, got ${JSON.stringify(step)}`);
    }
    const receipt = step.Transaction.Ok;
    expect(receipt.vm_error).toBeNull();
    expect(receipt.post_condition_aborted).toBe(false);
    // (ok u5)
    expect(receipt.result).toBe('070100000000000000000000000000000005');

    // events[i] is a JSON-encoded *string*. Use parseSimulationEvent
    // to JSON.parse + cast to the typed `SimulationEvent` union.
    expect(receipt.events).toHaveLength(1);
    const event = parseSimulationEvent(receipt.events[0]);
    if (event.type !== 'contract_event') {
      throw new Error(`expected contract_event, got ${event.type}`);
    }
    expect(event.contract_event.topic).toBe('print');
    expect(event.contract_event.contract_identifier).toBe(CONTRACT_ID);
    // raw_value is SIP-005 hex; deserializeCV() decodes to a Clarity Value.
    expect(event.contract_event.raw_value.startsWith('0x')).toBe(true);
  });

  it('reads counter via DataVar after increment', async () => {
    const r = await s.submit([
      { Reads: [{ DataVar: [CONTRACT_ID, 'counter'] }] },
    ]);
    const step = r.steps[0];
    if (!('Reads' in step)) {
      throw new Error(`expected Reads, got ${JSON.stringify(step)}`);
    }
    const read = step.Reads[0];
    if (!('Ok' in read)) {
      throw new Error(`expected DataVar Ok, got ${JSON.stringify(read)}`);
    }
    // u5 raw (no response wrapper for DataVar reads):
    // 01 (uint) followed by 16 bytes big-endian.
    expect(read.Ok).toBe('0100000000000000000000000000000005');
  });
});

scenario('counter contract — failure modes', () => {
  let s: Session;
  beforeAll(async () => {
    s = await setupSession();
  }, 30_000);

  it('always-err: (err u100) lives inside .result, no flags set', async () => {
    const r = await s.submit([
      { Transaction: await s.buildCall('always-err') },
    ]);
    const step = r.steps[0];
    if (!('Transaction' in step) || !('Ok' in step.Transaction)) {
      throw new Error(`expected Transaction.Ok, got ${JSON.stringify(step)}`);
    }
    const receipt = step.Transaction.Ok;
    expect(receipt.vm_error).toBeNull();
    expect(receipt.post_condition_aborted).toBe(false);
    // 08 = response::err prefix; the contract-level error is encoded
    // here, NOT signalled by vm_error or the outer Err.
    expect(receipt.result.startsWith('08')).toBe(true);
    // (err u100): 08 01 00...64
    expect(receipt.result).toBe('080100000000000000000000000000000064');
  });

  it('panic: vm_error populated by Clarity runtime error', async () => {
    const r = await s.submit([{ Transaction: await s.buildCall('panic') }]);
    const step = r.steps[0];
    if (!('Transaction' in step) || !('Ok' in step.Transaction)) {
      throw new Error(`expected Transaction.Ok, got ${JSON.stringify(step)}`);
    }
    const receipt = step.Transaction.Ok;
    expect(receipt.vm_error).not.toBeNull();
    expect(receipt.vm_error).toMatch(/DivisionByZero/);
  });
});
