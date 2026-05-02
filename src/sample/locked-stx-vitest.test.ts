/**
 * Vitest demo — PoX-4 locked STX unlock + transfer, end-to-end with
 * exact balance assertions.
 *
 * Picks a real delegated PoX-4 stacker (SP3573…) at a pinned mainnet
 * block. Their stacked principal is locked until burn height 964_250
 * and unspendable; only `unlocked` is part of the native STX balance.
 * `AdvanceBlocks` synthesizes burn blocks past `unlock_height`, the
 * locked portion releases into spendable, and a real STX transfer
 * moves it.
 *
 * Flow:
 *  1. Setup: deploy `acct-probe` (read-only `(stx-account principal)`
 *     wrapper) and `stx-transfer-helper` (thin `stx-transfer?` wrapper
 *     so we can control the sender via the simulator's no-signature
 *     trust model).
 *  2. Read stacker state via the probe + STX read: exact
 *     `locked = 4_049_000_000_000`, `unlocked = 976_775_508`,
 *     `unlock_height = 964_250`. Confirms the native STX balance
 *     reads only the unlocked portion.
 *  3. Pre-unlock transfer of `locked` from the stacker → `(err u1)`
 *     (insufficient spendable balance). Tx fee is still charged.
 *  4. Pre-unlock transfer of `unlocked + 1` → also `(err u1)`. Tx fee
 *     charged a second time.
 *  5. Probe the parent burn height with `AdvanceBlocks {bitcoin: 0,
 *     stacks_per_bitcoin: 1}` (in-tenure stacks-only block) so we
 *     know how many burn blocks to synthesize to cross unlock_height.
 *  6. `AdvanceBlocks +N burn blocks` (N computed to land one past
 *     `unlock_height`). Asserts each synthesized block has a non-zero
 *     `vrf_seed` and the final synthetic burn_height > unlock_height.
 *  7. Read available balance after unlock: exactly
 *     `locked + unlocked - 2*fee` (two pre-unlock failures were the
 *     only prior state changes; the locked portion has now released
 *     into spendable).
 *  8. Post-unlock transfer of `locked` → `(ok true)`. Stacker /
 *     recipient balances reconcile exactly.
 *
 * Pin: settled mainnet block 7_113_629. Re-pin if your chainstate
 * prunes past it; the locked / unlocked / unlock_height numbers above
 * will shift accordingly.
 */
import {
  Cl,
  ClarityType,
  deserializeCV,
  serializeCV,
} from '@stacks/transactions';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type AdvancedBlockSummary,
  callContract,
  createSimulationSession,
  getStxBalance,
  type SimulationStepResult,
  simulationBatchReads,
  submitSimulationSteps,
} from '..';
import { apiOptions } from './_helpers';

const SKIP = process.env.STXER_SKIP_NETWORK_TESTS === '1';
const scenario = SKIP ? describe.skip : describe;

const FIXED_BLOCK_HEIGHT = 7_113_629;
const FIXED_BLOCK_HASH =
  'e213fd816584e196ca0ae8bb3c628f98f85c0173aec89d5276d8f25370270632';

// A delegated PoX-4 stacker with locked STX in the pinned reward set.
const STACKER = 'SP3573HMB9SPCTMT85YS85KEPYCX33E6MZGQ5QB2A';
const RECIPIENT = 'SP1Y7GTHNJ1XWZYPP5WDGSNVAE9H5M4M2ADBG9C33';

// Exact stacker state at the pinned block, cross-checked via
// `(stx-account 'SP3573…)`.
const EXPECTED_LOCKED = 4_049_000_000_000n;
const EXPECTED_UNLOCKED = 976_775_508n;
const EXPECTED_UNLOCK_HEIGHT = 964_250n;

const PROBE = 'SP000000000000000000002Q6VF78.acct-probe';
const PROBE_CODE = '(define-read-only (q (p principal)) (stx-account p))';

const TRANSFER_HELPER = 'SP000000000000000000002Q6VF78.test-stx-transfer';
const TRANSFER_CODE = `(define-public (send (amount uint) (recipient principal))
  (stx-transfer? amount tx-sender recipient))`;

const FEE = 5_000n;

interface Account {
  locked: bigint;
  unlocked: bigint;
  unlockHeight: bigint;
}

function unwrapAdvance(step: SimulationStepResult): AdvancedBlockSummary[] {
  if (!('AdvanceBlocks' in step)) {
    throw new Error(`expected AdvanceBlocks, got ${JSON.stringify(step)}`);
  }
  if ('Err' in step.AdvanceBlocks) {
    throw new Error(`AdvanceBlocks Err: ${step.AdvanceBlocks.Err}`);
  }
  return step.AdvanceBlocks.Ok;
}

function assertSetContractCodeOk(step: SimulationStepResult): void {
  if (!('SetContractCode' in step)) {
    throw new Error(`expected SetContractCode, got ${JSON.stringify(step)}`);
  }
  if ('Err' in step.SetContractCode) {
    throw new Error(`SetContractCode Err: ${step.SetContractCode.Err}`);
  }
}

scenario('locked-stx — unlock + transfer flow', () => {
  let sessionId: string;
  let before: Account;
  let parentBurn: number;
  let advanceN: number;
  let advancedBlocks: AdvancedBlockSummary[];

  beforeAll(async () => {
    sessionId = await createSimulationSession(
      {
        block_height: FIXED_BLOCK_HEIGHT,
        block_hash: FIXED_BLOCK_HASH,
        skip_tracing: true,
      },
      apiOptions(),
    );

    const setup = await submitSimulationSteps(
      sessionId,
      {
        steps: [
          { SetContractCode: [PROBE, PROBE_CODE, 2] },
          { SetContractCode: [TRANSFER_HELPER, TRANSFER_CODE, 2] },
        ],
      },
      apiOptions(),
    );
    assertSetContractCodeOk(setup.steps[0]);
    assertSetContractCodeOk(setup.steps[1]);
  }, 60_000);

  it('reads stacker account: exact locked / unlocked / unlock_height', async () => {
    const reads = await simulationBatchReads(
      sessionId,
      {
        readonly: [[PROBE, 'q', serializeCV(Cl.principal(STACKER))]],
        stx: [STACKER],
      },
      apiOptions(),
    );
    const probeRead = reads.readonly?.[0];
    if (!probeRead || !('Ok' in probeRead)) {
      throw new Error(`probe read failed: ${JSON.stringify(probeRead)}`);
    }
    const acct = deserializeCV(probeRead.Ok);
    if (acct.type !== ClarityType.Tuple) {
      throw new Error('expected stx-account tuple');
    }
    const lk = acct.value.locked;
    const unl = acct.value.unlocked;
    const uh = acct.value['unlock-height'];
    if (
      lk?.type !== ClarityType.UInt ||
      unl?.type !== ClarityType.UInt ||
      uh?.type !== ClarityType.UInt
    ) {
      throw new Error('malformed stx-account tuple');
    }
    before = {
      locked: BigInt(lk.value),
      unlocked: BigInt(unl.value),
      unlockHeight: BigInt(uh.value),
    };
    expect(before.locked).toBe(EXPECTED_LOCKED);
    expect(before.unlocked).toBe(EXPECTED_UNLOCKED);
    expect(before.unlockHeight).toBe(EXPECTED_UNLOCK_HEIGHT);

    const stxRead = reads.stx?.[0];
    if (!stxRead || !('Ok' in stxRead)) {
      throw new Error('stx read failed');
    }
    expect(BigInt(stxRead.Ok)).toBe(EXPECTED_UNLOCKED);
  });

  it('pre-unlock transfer of the locked amount fails with (err u1)', async () => {
    const stackerBefore = await getStxBalance(sessionId, STACKER, apiOptions());
    const recipientBefore = await getStxBalance(
      sessionId,
      RECIPIENT,
      apiOptions(),
    );

    const r = await callContract(
      sessionId,
      {
        sender: STACKER,
        contract: TRANSFER_HELPER,
        functionName: 'send',
        functionArgs: [Cl.uint(before.locked), Cl.principal(RECIPIENT)],
        fee: Number(FEE),
      },
      apiOptions(),
    );
    expect(r.vmError).toBeNull();
    expect(r.pcAborted).toBe(false);
    // stx-transfer? returns (err u1) for "not enough STX" — the locked
    // portion is reserved by PoX and isn't part of the spendable balance.
    expect(r.result).toBe('(err u1)');

    // The Clarity-level err rolled back the transfer body, but the tx
    // fee was still paid by the stacker.
    const stackerAfter = await getStxBalance(sessionId, STACKER, apiOptions());
    const recipientAfter = await getStxBalance(
      sessionId,
      RECIPIENT,
      apiOptions(),
    );
    expect(stackerAfter).toBe(stackerBefore - FEE);
    expect(recipientAfter).toBe(recipientBefore);
  });

  it('pre-unlock transfer of (unlocked + 1) also fails with (err u1)', async () => {
    const stackerBefore = await getStxBalance(sessionId, STACKER, apiOptions());

    const r = await callContract(
      sessionId,
      {
        sender: STACKER,
        contract: TRANSFER_HELPER,
        functionName: 'send',
        functionArgs: [Cl.uint(before.unlocked + 1n), Cl.principal(RECIPIENT)],
        fee: Number(FEE),
      },
      apiOptions(),
    );
    expect(r.result).toBe('(err u1)');
    expect(await getStxBalance(sessionId, STACKER, apiOptions())).toBe(
      stackerBefore - FEE,
    );
  });

  it('probes the parent burn height with a single in-tenure stacks block', async () => {
    const probe = await submitSimulationSteps(
      sessionId,
      {
        steps: [
          {
            AdvanceBlocks: { bitcoin_blocks: 0, stacks_blocks_per_bitcoin: 1 },
          },
        ],
      },
      apiOptions(),
    );
    const blocks = unwrapAdvance(probe.steps[0]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tenure_change).toBe(false);
    parentBurn = blocks[0].burn_height;
    advanceN = Number(before.unlockHeight) - parentBurn + 1;
    expect(advanceN).toBeGreaterThan(0);
  });

  it('advances synthetic chain past unlock height', async () => {
    const advance = await submitSimulationSteps(
      sessionId,
      {
        steps: [
          {
            AdvanceBlocks: {
              bitcoin_blocks: advanceN,
              stacks_blocks_per_bitcoin: 1,
            },
          },
        ],
      },
      apiOptions(),
    );
    advancedBlocks = unwrapAdvance(advance.steps[0]);
    expect(advancedBlocks.length).toBe(advanceN);
    const tip = advancedBlocks[advancedBlocks.length - 1];
    expect(BigInt(tip.burn_height)).toBeGreaterThan(before.unlockHeight);
    expect(tip.vrf_seed).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reads available balance after unlock = locked + unlocked - 2*fee', async () => {
    // Two failed pre-unlock transfers each charged FEE — those are the
    // only state changes we made before advancing past unlock_height.
    const after = await getStxBalance(sessionId, STACKER, apiOptions());
    expect(after).toBe(before.locked + before.unlocked - 2n * FEE);
  });

  it('post-unlock transfer of the locked amount succeeds; balances reconcile exactly', async () => {
    const stackerBefore = await getStxBalance(sessionId, STACKER, apiOptions());
    const recipientBefore = await getStxBalance(
      sessionId,
      RECIPIENT,
      apiOptions(),
    );

    const r = await callContract(
      sessionId,
      {
        sender: STACKER,
        contract: TRANSFER_HELPER,
        functionName: 'send',
        functionArgs: [Cl.uint(before.locked), Cl.principal(RECIPIENT)],
        fee: Number(FEE),
      },
      apiOptions(),
    );
    expect(r.vmError).toBeNull();
    expect(r.pcAborted).toBe(false);
    expect(r.result).toBe('(ok true)');

    const stackerFinal = await getStxBalance(sessionId, STACKER, apiOptions());
    const recipientFinal = await getStxBalance(
      sessionId,
      RECIPIENT,
      apiOptions(),
    );
    expect(stackerFinal).toBe(stackerBefore - before.locked - FEE);
    expect(recipientFinal).toBe(recipientBefore + before.locked);
  });
});
