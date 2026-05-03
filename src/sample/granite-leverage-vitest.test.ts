/**
 * Vitest demo — Granite leverage open with a forged Pyth v3 price update.
 *
 * Granite Leverage (`gl-api`) reads Pyth via gl-oracle →
 * `pyth-oracle-v3.verify-and-update-price-feeds` →
 * `pyth-pnau-decoder-v2`. Patching the decoder with `SetContractCode`
 * bypasses the Wormhole secp256k1 quorum + Merkle proof + authorized
 * data-source check in one shot.
 *
 * Flow (all assertions are exact — block height + chainstate are
 * pinned, so each call has a deterministic outcome):
 *  1. Patch `pyth-pnau-decoder-v2` with a stub returning a fixed
 *     forged BTC/USD entry; AdvanceBlocks +1 so
 *     `pyth-storage-v3.write_batch_entry`'s freshness gate has a
 *     synthetic-tip block_time to compare against.
 *  2. Submit `gl-api.open` (sBTC short, leverage 1) with a collateral
 *     of 10_000 sats. After the protocol fee
 *     (`static-fees`: collateral / 1_000) is deducted, only 9_990 sats
 *     reach `gl-positions`, which is below the live
 *     `MIN-SHORT-COLLATERAL=10_000` and trips
 *     `gl-positions.is-legal-position`. Expect exact `(err u307)`
 *     and zero sBTC delta.
 *  3. Submit a successful `gl-api.open` with collateral 100_000 sats
 *     (leaves 99_900 after the fee — well above
 *     `MIN-SHORT-COLLATERAL`). Expect `(ok ...)`, a `fee=u100` entry
 *     in the result, and an exact sBTC delta of -100_000.
 *  4. Independent direct `pyth-oracle-v3.verify-and-update-price-feeds`
 *     + `pyth-storage-v3.read` confirms the forged price reaches
 *     storage even when called outside `gl-api`.
 */
import {
  Cl,
  ClarityType,
  cvToString,
  deserializeCV,
} from '@stacks/transactions';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  callContract,
  createSimulationSession,
  ftPrincipal,
  getFtBalance,
  submitSimulationSteps,
} from '..';
import { apiOptions } from './_helpers';

const SKIP = process.env.STXER_SKIP_NETWORK_TESTS === '1';
const scenario = SKIP ? describe.skip : describe;

const FIXED_BLOCK_HEIGHT = 7_113_629;
const FIXED_BLOCK_HASH =
  'e213fd816584e196ca0ae8bb3c628f98f85c0173aec89d5276d8f25370270632';

const PYTH_DEPLOYER = 'SP3R4F6C1J3JQWWCVZ3S7FRRYPMYG6ZW6RZK31FXY';
const PYTH_STORAGE = `${PYTH_DEPLOYER}.pyth-storage-v3`;
const PYTH_DECODER = `${PYTH_DEPLOYER}.pyth-pnau-decoder-v2`;
const PYTH_ORACLE_V3 = `${PYTH_DEPLOYER}.pyth-oracle-v3`;
const WORMHOLE_V3 = `${PYTH_DEPLOYER}.wormhole-core-v3`;

const BTC_FEED_ID =
  'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43';
const FORGED_BTC_PRICE = 5_000_000_000_000n;
const FORGED_BTC_CONF = 1_000_000n;
const FORGED_BTC_EXPO = -8;
const FORGED_BTC_EMA_PRICE = 5_000_000_000_000n;
const FORGED_BTC_EMA_CONF = 1_000_000n;
const PUBLISH_TIME_OFFSET = 8_000_000_000n;

const PATCHED_DECODER_CODE = `
(impl-trait '${PYTH_DEPLOYER}.pyth-traits-v1.decoder-trait)
(use-trait wormhole-core-trait '${PYTH_DEPLOYER}.wormhole-traits-v1.core-trait)

(define-public (decode-and-verify-price-feeds
    (pf-bytes (buff 8192))
    (wormhole-core-contract <wormhole-core-trait>))
  (ok (list {
    price-identifier: 0x${BTC_FEED_ID},
    price: ${FORGED_BTC_PRICE},
    conf: u${FORGED_BTC_CONF},
    expo: ${FORGED_BTC_EXPO},
    ema-price: ${FORGED_BTC_EMA_PRICE},
    ema-conf: u${FORGED_BTC_EMA_CONF},
    publish-time: (+ burn-block-height u${PUBLISH_TIME_OFFSET}),
    prev-publish-time: u${PUBLISH_TIME_OFFSET},
  })))
`;

// PNAU-prefixed forged buffer — patched decoder ignores its content.
const FORGED_MESSAGE_HEX = `504e41550100000003b8${'deadbeef'.repeat(16)}`;

const GL_DEPLOYER = 'SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1';
const GL_API = `${GL_DEPLOYER}.gl-api`;
const GL_ORACLE = `${GL_DEPLOYER}.gl-oracle`;

const SBTC_TOKEN = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
const USDH_TOKEN = 'SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.usdh-token-v1';

const GL_USER = 'SP3573HMB9SPCTMT85YS85KEPYCX33E6MZGQ5QB2A';
const LEVERAGE = 1n;
const DESIRED_PRICE_QDP = FORGED_BTC_PRICE;
const SLIPPAGE_QDP = 1_000_000n;

// `gl-params.static-fees` deducts collateral / PROTOCOL-FEE (= /1_000)
// from `collateral0` BEFORE `gl-positions.is-legal-position` runs.
// `BAD_COLLATERAL = 10_000` → after-fee 9_990, just below the live
// `MIN-SHORT-COLLATERAL=10_000`, trips `(err u307)`.
// `GOOD_COLLATERAL = 100_000` → after-fee 99_900, well within range.
const BAD_COLLATERAL_SATS = 10_000n;
const GOOD_COLLATERAL_SATS = 100_000n;
const GOOD_FEE = GOOD_COLLATERAL_SATS / 1_000n; // 100

function makeCtx() {
  return Cl.tuple({
    identifier: Cl.bufferFromHex(BTC_FEED_ID),
    message: Cl.bufferFromHex(FORGED_MESSAGE_HEX),
    oracle: ftPrincipal(GL_ORACLE),
  });
}

scenario(
  'granite-leverage — Pyth v3 forged + gl-api.open + storage read-back',
  () => {
    let sessionId: string;

    beforeAll(async () => {
      sessionId = await createSimulationSession(
        {
          block_height: FIXED_BLOCK_HEIGHT,
          block_hash: FIXED_BLOCK_HASH,
          skip_tracing: true,
        },
        apiOptions(),
      );
    }, 60_000);

    it('patches pyth-pnau-decoder-v2 + advances 1 burn block', async () => {
      const r = await submitSimulationSteps(
        sessionId,
        {
          steps: [
            { SetContractCode: [PYTH_DECODER, PATCHED_DECODER_CODE, 2] },
            {
              AdvanceBlocks: {
                bitcoin_blocks: 1,
                stacks_blocks_per_bitcoin: 1,
              },
            },
          ],
        },
        apiOptions(),
      );
      const patchStep = r.steps[0];
      if (
        !('SetContractCode' in patchStep) ||
        !('Ok' in patchStep.SetContractCode)
      ) {
        throw new Error(`decoder patch failed: ${JSON.stringify(patchStep)}`);
      }
    });

    it('gl-api.open with 10_000 sats collateral fails the legal-position check (err u307)', async () => {
      const sbtcBefore = await getFtBalance(
        sessionId,
        SBTC_TOKEN,
        GL_USER,
        apiOptions(),
      );
      const open = await callContract(
        sessionId,
        {
          sender: GL_USER,
          contract: GL_API,
          functionName: 'open',
          functionArgs: [
            ftPrincipal(SBTC_TOKEN),
            ftPrincipal(USDH_TOKEN),
            Cl.bool(false), // long=false (short)
            Cl.uint(BAD_COLLATERAL_SATS),
            Cl.uint(LEVERAGE),
            Cl.uint(DESIRED_PRICE_QDP),
            Cl.uint(SLIPPAGE_QDP),
            makeCtx(),
          ],
          fee: 200_000,
        },
        apiOptions(),
      );
      expect(open.vmError).toBeNull();
      // Exact: gl-positions.err-open-preconditions = (err u307).
      expect(open.result).toBe('(err u307)');
      // gl-core's transfer-from is rolled back by the failed assert.
      const sbtcAfter = await getFtBalance(
        sessionId,
        SBTC_TOKEN,
        GL_USER,
        apiOptions(),
      );
      expect(sbtcAfter).toBe(sbtcBefore);
    });

    it('gl-api.open with 100_000 sats collateral succeeds; sBTC delta is exactly -100_000', async () => {
      const sbtcBefore = await getFtBalance(
        sessionId,
        SBTC_TOKEN,
        GL_USER,
        apiOptions(),
      );
      const open = await callContract(
        sessionId,
        {
          sender: GL_USER,
          contract: GL_API,
          functionName: 'open',
          functionArgs: [
            ftPrincipal(SBTC_TOKEN),
            ftPrincipal(USDH_TOKEN),
            Cl.bool(false), // short
            Cl.uint(GOOD_COLLATERAL_SATS),
            Cl.uint(LEVERAGE),
            Cl.uint(DESIRED_PRICE_QDP),
            Cl.uint(SLIPPAGE_QDP),
            makeCtx(),
          ],
          fee: 200_000,
        },
        apiOptions(),
      );
      expect(open.vmError).toBeNull();
      expect(open.pcAborted).toBe(false);
      expect(open.result.startsWith('(ok ')).toBe(true);

      // Decode the response and assert the open-event tuple shape.
      const decoded = deserializeCV(open.resultHex);
      if (
        decoded.type !== ClarityType.ResponseOk ||
        decoded.value.type !== ClarityType.Tuple
      ) {
        throw new Error(`expected (ok tuple), got ${cvToString(decoded)}`);
      }
      const tup = decoded.value.value;
      // op: "open"
      const opField = tup.op;
      if (opField?.type !== ClarityType.StringASCII) {
        throw new Error('op field not string-ascii');
      }
      expect(opField.value).toBe('open');
      // fee: u100 (= GOOD_COLLATERAL_SATS / PROTOCOL-FEE = 100_000/1_000)
      const feeField = tup.fee;
      if (feeField?.type !== ClarityType.UInt) {
        throw new Error('fee field not uint');
      }
      expect(BigInt(feeField.value)).toBe(GOOD_FEE);

      // Balance: gl-core's `call-transfer-from base-token collateral0`
      // pulls the full collateral0 from the user (the fee is then sent
      // from the protocol to gl-fees-bank, NOT from the user).
      const sbtcAfter = await getFtBalance(
        sessionId,
        SBTC_TOKEN,
        GL_USER,
        apiOptions(),
      );
      expect(sbtcAfter).toBe(sbtcBefore - GOOD_COLLATERAL_SATS);
    });

    it('direct verify-and-update + storage read confirm forged price commits', async () => {
      // Advance another burn block so the patched decoder's
      // `(+ burn-block-height u8000000000)` produces a strictly newer
      // publish-time than whatever gl-api.open's nested call left in place.
      const advance = await submitSimulationSteps(
        sessionId,
        {
          steps: [
            {
              AdvanceBlocks: {
                bitcoin_blocks: 1,
                stacks_blocks_per_bitcoin: 1,
              },
            },
          ],
        },
        apiOptions(),
      );
      const advStep = advance.steps[0];
      if (!('AdvanceBlocks' in advStep) || !('Ok' in advStep.AdvanceBlocks)) {
        throw new Error(`advance failed: ${JSON.stringify(advStep)}`);
      }

      const directUpdate = await callContract(
        sessionId,
        {
          sender: GL_USER,
          contract: PYTH_ORACLE_V3,
          functionName: 'verify-and-update-price-feeds',
          functionArgs: [
            Cl.bufferFromHex(FORGED_MESSAGE_HEX),
            Cl.tuple({
              'pyth-storage-contract': ftPrincipal(PYTH_STORAGE),
              'pyth-decoder-contract': ftPrincipal(PYTH_DECODER),
              'wormhole-core-contract': ftPrincipal(WORMHOLE_V3),
            }),
          ],
        },
        apiOptions(),
      );
      expect(directUpdate.vmError).toBeNull();
      expect(directUpdate.result.startsWith('(ok ')).toBe(true);

      // Read the storage entry directly via Reads.EvalReadonly.
      const r = await submitSimulationSteps(
        sessionId,
        {
          steps: [
            {
              Reads: [
                {
                  EvalReadonly: [
                    GL_USER,
                    '',
                    PYTH_STORAGE,
                    `(read 0x${BTC_FEED_ID})`,
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
        throw new Error(`Reads step shape: ${JSON.stringify(step)}`);
      }
      const v = step.Reads[0];
      if (!('Ok' in v)) {
        throw new Error(`storage.read failed: ${JSON.stringify(v)}`);
      }
      const decoded = deserializeCV(v.Ok);
      if (
        decoded.type !== ClarityType.ResponseOk ||
        decoded.value.type !== ClarityType.Tuple
      ) {
        throw new Error('expected (ok tuple)');
      }
      const price = decoded.value.value.price;
      const pubTime = decoded.value.value['publish-time'];
      if (price?.type !== ClarityType.Int) {
        throw new Error('price not int');
      }
      if (pubTime?.type !== ClarityType.UInt) {
        throw new Error('publish-time not uint');
      }
      expect(BigInt(price.value)).toBe(FORGED_BTC_PRICE);
      expect(BigInt(pubTime.value)).toBeGreaterThan(PUBLISH_TIME_OFFSET);
    });
  },
);
