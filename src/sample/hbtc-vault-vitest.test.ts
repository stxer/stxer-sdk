/**
 * Vitest demo — hBTC vault: deposit, reward, time-locked redeem,
 * transfer, end-to-end with exact balance assertions.
 *
 * hBTC is a yield-bearing wrapper around sBTC. Yield accrues when the
 * rewarder calls `controller-hbtc-v1.log-reward` — bumping
 * `total-assets` while leaving `total-shares`, raising
 * `share-price = total-assets / total-shares`.
 *
 * All values pinned to mainnet block 7_113_629 — every assertion is
 * exact and the demo verifies that the realised yield matches the
 * expected delta.
 *
 * Flow:
 *  1. user.deposit(500_000)            → mints exactly 497_726 shares.
 *  2. user.request-redeem(shares)      → escrows the shares (claim-id 35).
 *  3. redeem before fund-claim         → ERR_NOT_FUNDED (u103006).
 *  4. user funds the reserve with the reward backing.
 *  5. AdvanceBlocks +1 day              → crosses the rewarder window.
 *  6. rewarder.log-reward(30_000, true) → share-price 100_456_763 →
 *                                          100_485_216 (Δ = +28_453).
 *  7. manager.fund-claim(claim-id)      → claim.assets = 500_141
 *                                          (gain = 141 sats yield).
 *  8. redeem still pre-cooldown          → ERR_NOT_COOLED_DOWN (u103004).
 *  9. AdvanceBlocks +3 days              → past the 3-day cooldown.
 * 10. user.redeem(claim-id)              → assetsNet = 500_141 (exit fee 0).
 * 11. user transfers half (250_070) to secondary; balances reconcile.
 *
 * No governance overrides — uses real on-chain rewarder/manager
 * (the simulator doesn't validate signatures, so setSender suffices).
 */
import { Cl, ClarityType, deserializeCV } from '@stacks/transactions';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  callContract,
  createSimulationSession,
  getFtBalance,
  submitSimulationSteps,
} from '..';
import { apiOptions } from './_helpers';

const SKIP = process.env.STXER_SKIP_NETWORK_TESTS === '1';
const scenario = SKIP ? describe.skip : describe;

const FIXED_BLOCK_HEIGHT = 7_113_629;
const FIXED_BLOCK_HASH =
  'e213fd816584e196ca0ae8bb3c628f98f85c0173aec89d5276d8f25370270632';

const SBTC_TOKEN = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
const HBTC_DEPLOYER = 'SP1S1HSFH0SQQGWKB69EYFNY0B1MHRMGXR3J1FH4D';
const TOKEN_HBTC = `${HBTC_DEPLOYER}.token-hbtc`;
const VAULT_HBTC = `${HBTC_DEPLOYER}.vault-hbtc-v1`;
const STATE_HBTC = `${HBTC_DEPLOYER}.state-hbtc-v1`;
const RESERVE_HBTC = `${HBTC_DEPLOYER}.reserve-hbtc-v1`;
const CONTROLLER_HBTC = `${HBTC_DEPLOYER}.controller-hbtc-v1`;

const USER = 'SP3573HMB9SPCTMT85YS85KEPYCX33E6MZGQ5QB2A';
const SECONDARY = 'SP1Y7GTHNJ1XWZYPP5WDGSNVAE9H5M4M2ADBG9C33';
// Real on-chain Hermetica role-holder at the pinned block (rewarder + manager).
const REWARDER = 'SP20V8SG811G6CT2QMZQNX6XCN20YAX36DYD1BAE0';
const MANAGER = REWARDER;

const DEPOSIT_AMOUNT = 500_000n;
const REWARD_AMOUNT = 30_000n;

// Pinned mainnet state at block 7_113_629.
const EXPECTED_SBTC_BEFORE = 1_011_001n;
const EXPECTED_HBTC_BEFORE = 0n;
const EXPECTED_SHARE_PRICE_BEFORE = 100_456_763n;
const EXPECTED_SHARES = 497_726n;
const EXPECTED_CLAIM_ID = 35n;
const EXPECTED_SHARE_PRICE_AFTER = 100_485_216n;
const EXPECTED_SHARE_PRICE_DELTA =
  EXPECTED_SHARE_PRICE_AFTER - EXPECTED_SHARE_PRICE_BEFORE; // 28_453
const EXPECTED_CLAIM_ASSETS = 500_141n; // = DEPOSIT_AMOUNT + 141 sats of yield
const EXPECTED_YIELD = EXPECTED_CLAIM_ASSETS - DEPOSIT_AMOUNT; // 141

function unwrapOkUint(s: string): bigint {
  const m = s.match(/^\(ok u(\d+)\)$/);
  if (!m) throw new Error(`expected (ok uXXX), got ${s}`);
  return BigInt(m[1]);
}

async function readSharePrice(sessionId: string): Promise<bigint> {
  const r = await submitSimulationSteps(
    sessionId,
    {
      steps: [
        {
          Reads: [
            {
              EvalReadonly: [
                'SP000000000000000000002Q6VF78',
                '',
                STATE_HBTC,
                '(get-share-price)',
              ],
            },
          ],
        },
      ],
    },
    apiOptions(),
  );
  const step = r.steps[0];
  if (!('Reads' in step)) {
    throw new Error(`share-price read failed: ${JSON.stringify(step)}`);
  }
  const read = step.Reads[0];
  if (!('Ok' in read)) {
    throw new Error(`share-price read failed: ${JSON.stringify(read)}`);
  }
  const decoded = deserializeCV(read.Ok);
  if (decoded.type !== ClarityType.UInt) {
    throw new Error('share-price not uint');
  }
  return BigInt(decoded.value);
}

scenario('hbtc-vault — deposit + reward + time-locked redeem flow', () => {
  let sessionId: string;
  let claimAssets: bigint;

  beforeAll(async () => {
    sessionId = await createSimulationSession(
      {
        block_height: FIXED_BLOCK_HEIGHT,
        block_hash: FIXED_BLOCK_HASH,
        skip_tracing: true,
      },
      apiOptions(),
    );
    console.log(
      `[hbtc-vault] view: https://stxer.xyz/simulations/mainnet/${sessionId}`,
    );
  }, 60_000);

  it('reads pre-state — exact sBTC, hBTC, share-price', async () => {
    expect(await getFtBalance(sessionId, SBTC_TOKEN, USER, apiOptions())).toBe(
      EXPECTED_SBTC_BEFORE,
    );
    expect(await getFtBalance(sessionId, TOKEN_HBTC, USER, apiOptions())).toBe(
      EXPECTED_HBTC_BEFORE,
    );
    expect(await readSharePrice(sessionId)).toBe(EXPECTED_SHARE_PRICE_BEFORE);
  });

  it('vault.deposit mints exactly 497_726 hBTC; sBTC reduces by 500_000', async () => {
    const r = await callContract(
      sessionId,
      {
        sender: USER,
        contract: VAULT_HBTC,
        functionName: 'deposit',
        functionArgs: [Cl.uint(DEPOSIT_AMOUNT), Cl.none()],
      },
      apiOptions(),
    );
    expect(r.vmError).toBeNull();
    const shares = unwrapOkUint(r.result);
    expect(shares).toBe(EXPECTED_SHARES);

    expect(await getFtBalance(sessionId, SBTC_TOKEN, USER, apiOptions())).toBe(
      EXPECTED_SBTC_BEFORE - DEPOSIT_AMOUNT,
    );
    expect(await getFtBalance(sessionId, TOKEN_HBTC, USER, apiOptions())).toBe(
      EXPECTED_HBTC_BEFORE + EXPECTED_SHARES,
    );
  });

  it('request-redeem returns claim-id 35 and escrows the shares', async () => {
    const reqRedeem = await callContract(
      sessionId,
      {
        sender: USER,
        contract: VAULT_HBTC,
        functionName: 'request-redeem',
        functionArgs: [Cl.uint(EXPECTED_SHARES), Cl.bool(false)],
      },
      apiOptions(),
    );
    expect(reqRedeem.vmError).toBeNull();
    expect(unwrapOkUint(reqRedeem.result)).toBe(EXPECTED_CLAIM_ID);

    expect(await getFtBalance(sessionId, TOKEN_HBTC, USER, apiOptions())).toBe(
      EXPECTED_HBTC_BEFORE,
    );
  });

  it('redeem pre-fund returns exactly (err u103006) (ERR_NOT_FUNDED)', async () => {
    const r = await callContract(
      sessionId,
      {
        sender: USER,
        contract: VAULT_HBTC,
        functionName: 'redeem',
        functionArgs: [Cl.uint(EXPECTED_CLAIM_ID)],
      },
      apiOptions(),
    );
    expect(r.result).toBe('(err u103006)');
  });

  it('user funds reserve, advance 1 day, rewarder bumps share-price by exactly +28_453', async () => {
    const fundReserve = await callContract(
      sessionId,
      {
        sender: USER,
        contract: SBTC_TOKEN,
        functionName: 'transfer',
        functionArgs: [
          Cl.uint(REWARD_AMOUNT),
          Cl.principal(USER),
          Cl.principal(RESERVE_HBTC),
          Cl.none(),
        ],
      },
      apiOptions(),
    );
    expect(fundReserve.result).toBe('(ok true)');

    const advance1 = await submitSimulationSteps(
      sessionId,
      {
        steps: [
          {
            AdvanceBlocks: {
              bitcoin_blocks: 1,
              stacks_blocks_per_bitcoin: 1,
              bitcoin_interval_secs: 86_400,
            },
          },
        ],
      },
      apiOptions(),
    );
    const adv = advance1.steps[0];
    if (!('AdvanceBlocks' in adv) || !('Ok' in adv.AdvanceBlocks)) {
      throw new Error(`advance failed: ${JSON.stringify(adv)}`);
    }

    const logReward = await callContract(
      sessionId,
      {
        sender: REWARDER,
        contract: CONTROLLER_HBTC,
        functionName: 'log-reward',
        functionArgs: [Cl.uint(REWARD_AMOUNT), Cl.bool(true)],
      },
      apiOptions(),
    );
    expect(logReward.vmError).toBeNull();
    expect(logReward.result).toBe('(ok true)');

    const sharePriceAfter = await readSharePrice(sessionId);
    expect(sharePriceAfter).toBe(EXPECTED_SHARE_PRICE_AFTER);
    expect(sharePriceAfter - EXPECTED_SHARE_PRICE_BEFORE).toBe(
      EXPECTED_SHARE_PRICE_DELTA,
    );
  });

  it('manager.fund-claim returns claim.assets = 500_141 (yield = 141 sats)', async () => {
    const fundClaim = await callContract(
      sessionId,
      {
        sender: MANAGER,
        contract: VAULT_HBTC,
        functionName: 'fund-claim',
        functionArgs: [Cl.uint(EXPECTED_CLAIM_ID)],
      },
      apiOptions(),
    );
    expect(fundClaim.vmError).toBeNull();
    claimAssets = unwrapOkUint(fundClaim.result);
    expect(claimAssets).toBe(EXPECTED_CLAIM_ASSETS);
    expect(claimAssets - DEPOSIT_AMOUNT).toBe(EXPECTED_YIELD);
  });

  it('redeem pre-cooldown returns exactly (err u103004) (ERR_NOT_COOLED_DOWN)', async () => {
    const r = await callContract(
      sessionId,
      {
        sender: USER,
        contract: VAULT_HBTC,
        functionName: 'redeem',
        functionArgs: [Cl.uint(EXPECTED_CLAIM_ID)],
      },
      apiOptions(),
    );
    expect(r.result).toBe('(err u103004)');
  });

  it('advance 3 more days, redeem returns assets-net = claim.assets, balances reconcile exactly', async () => {
    const advance3 = await submitSimulationSteps(
      sessionId,
      {
        steps: [
          {
            AdvanceBlocks: {
              bitcoin_blocks: 3,
              stacks_blocks_per_bitcoin: 1,
              bitcoin_interval_secs: 86_400,
            },
          },
        ],
      },
      apiOptions(),
    );
    const adv = advance3.steps[0];
    if (!('AdvanceBlocks' in adv) || !('Ok' in adv.AdvanceBlocks)) {
      throw new Error(`3-day advance failed: ${JSON.stringify(adv)}`);
    }

    // Pre-redeem sBTC = initial - DEPOSIT - REWARD (the user transferred
    // REWARD_AMOUNT to the reserve to back the yield).
    const sbtcBeforeRedeem = await getFtBalance(
      sessionId,
      SBTC_TOKEN,
      USER,
      apiOptions(),
    );
    expect(sbtcBeforeRedeem).toBe(
      EXPECTED_SBTC_BEFORE - DEPOSIT_AMOUNT - REWARD_AMOUNT,
    );

    const redeem = await callContract(
      sessionId,
      {
        sender: USER,
        contract: VAULT_HBTC,
        functionName: 'redeem',
        functionArgs: [Cl.uint(EXPECTED_CLAIM_ID)],
      },
      apiOptions(),
    );
    expect(redeem.vmError).toBeNull();
    const assetsNet = unwrapOkUint(redeem.result);
    // Exit fee is 0 at the pinned chainstate, so assets-net == claim.assets.
    expect(assetsNet).toBe(EXPECTED_CLAIM_ASSETS);

    const sbtcAfterRedeem = await getFtBalance(
      sessionId,
      SBTC_TOKEN,
      USER,
      apiOptions(),
    );
    expect(sbtcAfterRedeem).toBe(sbtcBeforeRedeem + EXPECTED_CLAIM_ASSETS);

    // Transfer half to secondary.
    const transferAmount = EXPECTED_CLAIM_ASSETS / 2n;
    const secBefore = await getFtBalance(
      sessionId,
      SBTC_TOKEN,
      SECONDARY,
      apiOptions(),
    );
    const transfer = await callContract(
      sessionId,
      {
        sender: USER,
        contract: SBTC_TOKEN,
        functionName: 'transfer',
        functionArgs: [
          Cl.uint(transferAmount),
          Cl.principal(USER),
          Cl.principal(SECONDARY),
          Cl.none(),
        ],
      },
      apiOptions(),
    );
    expect(transfer.result).toBe('(ok true)');

    const userFinal = await getFtBalance(
      sessionId,
      SBTC_TOKEN,
      USER,
      apiOptions(),
    );
    const secFinal = await getFtBalance(
      sessionId,
      SBTC_TOKEN,
      SECONDARY,
      apiOptions(),
    );
    expect(userFinal).toBe(sbtcAfterRedeem - transferAmount);
    expect(secFinal).toBe(secBefore + transferAmount);
  });
});
