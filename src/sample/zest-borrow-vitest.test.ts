/**
 * Vitest demo — Zest V2 lend / borrow / repay round-trip with a forged
 * Pyth v4 price update.
 *
 * Cross-chain primitive being demonstrated:
 *   1. Patch `pyth-pnau-decoder-v3` so any forged PNAU buffer decodes
 *      to a chosen BTC + STX price entry. This bypasses the Wormhole
 *      secp256k1 quorum + Merkle proof + authorized-data-source
 *      checks.
 *   2. AdvanceBlocks +1 burn block so `pyth-storage-v4` has a
 *      synthetic-tip block_time to compare against the patched
 *      decoder's `(+ burn-block-height u8000000000)` publish-time.
 *
 * Zest V2 round-trip (all assertions exact at the pinned block):
 *   3. `supply-collateral-add 100_000 sBTC` mints exactly 99_952 zsBTC
 *      shares and marks sBTC as collateral. The forged BTC price is
 *      written to `pyth-storage-v4` as a side effect of this call.
 *   4. Over-borrow attempt (100_000_000_000 wstx) returns exact
 *      `(err u400005)` (ERR-UNHEALTHY).
 *   5. Borrow 100_000 wstx returns exact `(ok true)`. wstx is a thin
 *      wrapper around native STX; the user receives 100_000 µSTX
 *      (offset by the tx fee).
 *   6. Repay 1_000_000 wstx — the contract caps repay to actual debt
 *      and returns exact `(ok u100001)` (principal 100_000 + 1 sat
 *      accrued interest).
 *   7. `collateral-remove-redeem 99_952 zsBTC shares` returns exact
 *      `(ok u99999)` (1 sat haircut from vault rounding); final sBTC
 *      delta is -1 sat from the pinned-block starting balance.
 *
 * Pin: settled mainnet block 7_820_000. Re-pin if your chainstate
 * prunes past it; the exact share / debt / haircut numbers above will
 * shift accordingly.
 */
import { Cl } from '@stacks/transactions';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  callContract,
  createSimulationSession,
  ftPrincipal,
  getFtBalance,
  getStxBalance,
  submitSimulationSteps,
} from '..';
import { apiOptions } from './_helpers';

const SKIP = process.env.STXER_SKIP_NETWORK_TESTS === '1';
const scenario = SKIP ? describe.skip : describe;

const FIXED_BLOCK_HEIGHT = 7_820_000;
const FIXED_BLOCK_HASH =
  'ea67bd216c133af4f19bf21537a77d8d4337fb693b8bf32686bf83d6bf419b5e';

const PYTH_V4_DEPLOYER = 'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y';
const PYTH_V4_DECODER = `${PYTH_V4_DEPLOYER}.pyth-pnau-decoder-v3`;

const BTC_FEED_ID =
  'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43';
const STX_FEED_ID =
  'ec7a775f46379b5e943c3526b1c8d54cd49749176b0b98e02dde68d1bd335c17';

const FORGED_BTC_PRICE = 5_000_000_000_000n; // $50,000 @ 8dp
const FORGED_STX_PRICE = 100_000_000n; // $1.00 @ 8dp
const PUBLISH_TIME_OFFSET = 8_000_000_000n;

const PATCHED_DECODER_CODE = `
(impl-trait '${PYTH_V4_DEPLOYER}.pyth-traits-v2.decoder-trait)
(use-trait wormhole-core-trait '${PYTH_V4_DEPLOYER}.wormhole-traits-v2.core-trait)

(define-public (decode-and-verify-price-feeds
    (pf-bytes (buff 8192))
    (wormhole-core-contract <wormhole-core-trait>))
  (ok (list
    {
      price-identifier: 0x${BTC_FEED_ID},
      price: ${FORGED_BTC_PRICE},
      conf: u1000000,
      expo: -8,
      ema-price: ${FORGED_BTC_PRICE},
      ema-conf: u1000000,
      publish-time: (+ burn-block-height u${PUBLISH_TIME_OFFSET}),
      prev-publish-time: u${PUBLISH_TIME_OFFSET},
    }
    {
      price-identifier: 0x${STX_FEED_ID},
      price: ${FORGED_STX_PRICE},
      conf: u100000,
      expo: -8,
      ema-price: ${FORGED_STX_PRICE},
      ema-conf: u100000,
      publish-time: (+ burn-block-height u${PUBLISH_TIME_OFFSET}),
      prev-publish-time: u${PUBLISH_TIME_OFFSET},
    })))
`;

const FORGED_MESSAGE_HEX = `504e41550100000003b8${'deadbeef'.repeat(16)}`;

const ZEST_V2 = 'SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7';
const MARKET = `${ZEST_V2}.v0-4-market`;
const VAULT_SBTC = `${ZEST_V2}.v0-vault-sbtc`;
const ZEST_WSTX = `${ZEST_V2}.wstx`;
const SBTC_TOKEN = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';

const USER = 'SP3573HMB9SPCTMT85YS85KEPYCX33E6MZGQ5QB2A';
const TX_FEE = 200_000n;
const SUPPLY_AMT = 100_000n;
const BORROW_AMT = 100_000n;
const OVER_BORROW = 100_000_000_000n;
const OVERPAY_REPAY = 1_000_000n;

// Pinned mainnet state at block 7_820_000.
const EXPECTED_SBTC_BEFORE = 1_015_704n;
const EXPECTED_SHARES = 99_952n;
const EXPECTED_DEBT_REPAID = 100_001n; // principal 100_000 + 1 sat interest
const EXPECTED_REDEEMED_SBTC = 99_999n; // 1 sat haircut from vault rounding

scenario(
  'zest-borrow — V2 lend/borrow/repay round-trip with forged Pyth',
  () => {
    let sessionId: string;
    let sbtcPre: bigint;

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
        `[zest-borrow] view: https://stxer.xyz/simulations/mainnet/${sessionId}`,
      );
    }, 60_000);

    it('patches pyth-pnau-decoder-v3 + advances 1 burn block', async () => {
      const r = await submitSimulationSteps(
        sessionId,
        {
          steps: [
            { SetContractCode: [PYTH_V4_DECODER, PATCHED_DECODER_CODE, 2] },
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

    it('reads pre-state — exact sBTC + STX balances at pinned block', async () => {
      sbtcPre = await getFtBalance(sessionId, SBTC_TOKEN, USER, apiOptions());
      expect(sbtcPre).toBe(EXPECTED_SBTC_BEFORE);
    });

    it('supply-collateral-add 100_000 sBTC mints exactly 99_952 shares', async () => {
      // The market's `write-feeds` helper writes the forged price into
      // pyth-storage-v4 as a side effect of supply / borrow / repay calls
      // that pass `price-feeds`. No separate verify-and-update needed.
      const r = await callContract(
        sessionId,
        {
          sender: USER,
          contract: MARKET,
          functionName: 'supply-collateral-add',
          functionArgs: [
            ftPrincipal(SBTC_TOKEN),
            Cl.uint(SUPPLY_AMT),
            Cl.uint(0n), // min-shares
            Cl.some(Cl.list([Cl.bufferFromHex(FORGED_MESSAGE_HEX)])),
          ],
          fee: Number(TX_FEE),
        },
        apiOptions(),
      );
      expect(r.vmError).toBeNull();
      expect(r.result).toBe(`(ok u${EXPECTED_SHARES})`);

      expect(
        await getFtBalance(sessionId, SBTC_TOKEN, USER, apiOptions()),
      ).toBe(sbtcPre - SUPPLY_AMT);
    });

    it('over-borrow returns exact (err u400005) — ERR-UNHEALTHY', async () => {
      const r = await callContract(
        sessionId,
        {
          sender: USER,
          contract: MARKET,
          functionName: 'borrow',
          functionArgs: [
            ftPrincipal(ZEST_WSTX),
            Cl.uint(OVER_BORROW),
            Cl.none(),
            Cl.some(Cl.list([Cl.bufferFromHex(FORGED_MESSAGE_HEX)])),
          ],
          fee: Number(TX_FEE),
        },
        apiOptions(),
      );
      expect(r.vmError).toBeNull();
      expect(r.result).toBe('(err u400005)');
    });

    it('borrow 100_000 wstx succeeds — user receives exactly 99_998 µSTX (minus borrow dust)', async () => {
      const stxBefore = await getStxBalance(sessionId, USER, apiOptions());
      const r = await callContract(
        sessionId,
        {
          sender: USER,
          contract: MARKET,
          functionName: 'borrow',
          functionArgs: [
            ftPrincipal(ZEST_WSTX),
            Cl.uint(BORROW_AMT),
            Cl.none(), // receiver = caller
            Cl.some(Cl.list([Cl.bufferFromHex(FORGED_MESSAGE_HEX)])),
          ],
          fee: Number(TX_FEE),
        },
        apiOptions(),
      );
      expect(r.vmError).toBeNull();
      expect(r.result).toBe('(ok true)');

      // wstx is a thin wrapper around native STX, so the borrowed amount
      // arrives as a native STX delta of +BORROW_AMT, offset by the tx
      // fee. The 2-sat shortfall vs theoretical +BORROW_AMT - TX_FEE is
      // borrow-side scaled-debt rounding inside `convert-to-scaled-debt`
      // — deterministic at this pinned block.
      const stxAfter = await getStxBalance(sessionId, USER, apiOptions());
      expect(stxAfter).toBe(stxBefore + BORROW_AMT - TX_FEE - 2n);
    });

    it('repay 1_000_000 (overpay) returns exact (ok u100001) — covers principal + 1 sat interest', async () => {
      const r = await callContract(
        sessionId,
        {
          sender: USER,
          contract: MARKET,
          functionName: 'repay',
          functionArgs: [
            ftPrincipal(ZEST_WSTX),
            Cl.uint(OVERPAY_REPAY),
            Cl.none(),
          ],
          fee: Number(TX_FEE),
        },
        apiOptions(),
      );
      expect(r.vmError).toBeNull();
      expect(r.result).toBe(`(ok u${EXPECTED_DEBT_REPAID})`);
    });

    it('collateral-remove-redeem returns 99_999 sBTC; final sBTC delta is exactly -1 sat', async () => {
      const sbtcBeforeRemove = await getFtBalance(
        sessionId,
        SBTC_TOKEN,
        USER,
        apiOptions(),
      );
      const r = await callContract(
        sessionId,
        {
          sender: USER,
          contract: MARKET,
          functionName: 'collateral-remove-redeem',
          functionArgs: [
            Cl.contractPrincipal(ZEST_V2, 'v0-vault-sbtc'),
            Cl.uint(EXPECTED_SHARES),
            Cl.uint(0n), // min-underlying
            Cl.none(),
            Cl.some(Cl.list([Cl.bufferFromHex(FORGED_MESSAGE_HEX)])),
          ],
          fee: Number(TX_FEE),
        },
        apiOptions(),
      );
      expect(r.vmError).toBeNull();
      expect(r.result).toBe(`(ok u${EXPECTED_REDEEMED_SBTC})`);

      const sbtcFinal = await getFtBalance(
        sessionId,
        SBTC_TOKEN,
        USER,
        apiOptions(),
      );
      expect(sbtcFinal).toBe(sbtcBeforeRemove + EXPECTED_REDEEMED_SBTC);
      // Whole-round-trip: 1 sat haircut from vault share rounding.
      expect(sbtcFinal).toBe(EXPECTED_SBTC_BEFORE - 1n);
    });
  },
);

// suppress unused-import warning if VAULT_SBTC isn't referenced above
void VAULT_SBTC;
