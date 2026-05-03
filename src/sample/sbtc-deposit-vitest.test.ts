/**
 * Vitest demo — sBTC bridge deposit, end-to-end.
 *
 * Flow:
 *  1. Resolve the current sBTC signer principal from `sbtc-registry`.
 *  2. Forge a Bitcoin deposit transaction paying the sBTC bridge.
 *  3. Synthesize a burn block whose `burn_header_hash` is set via
 *     `AdvanceBlocks` override so the contract's
 *     `(get-burn-block-info? header-hash …)` resolves to a value we
 *     control.
 *  4. The signer (sender override via the simulator's no-signature
 *     trust model) calls `sbtc-deposit.complete-deposit-wrapper` —
 *     mints sBTC for the recipient.
 *  5. Recipient transfers half to a secondary; balances reflect.
 */
import {
  Cl,
  ClarityType,
  cvToString,
  deserializeCV,
} from '@stacks/transactions';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type AdvancedBlockSummary,
  buildUnsignedContractCallHex,
  bytesToHex,
  callContract,
  createSimulationSession,
  forgeBitcoinTx,
  getFtBalance,
  getNonce,
  hexToBytes,
  opReturnScript,
  p2wpkhScript,
  readDataVar,
  submitSimulationSteps,
} from '..';
import { apiOptions } from './_helpers';

const SKIP = process.env.STXER_SKIP_NETWORK_TESTS === '1';
const scenario = SKIP ? describe.skip : describe;

const FIXED_BLOCK_HEIGHT = 7_113_629;
const FIXED_BLOCK_HASH =
  'e213fd816584e196ca0ae8bb3c628f98f85c0173aec89d5276d8f25370270632';

const SBTC_DEPLOYER = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4';
const REGISTRY = `${SBTC_DEPLOYER}.sbtc-registry`;
const DEPOSIT = `${SBTC_DEPLOYER}.sbtc-deposit`;
const TOKEN = `${SBTC_DEPLOYER}.sbtc-token`;
const RECIPIENT = 'SP3573HMB9SPCTMT85YS85KEPYCX33E6MZGQ5QB2A';
const SECONDARY = 'SP1Y7GTHNJ1XWZYPP5WDGSNVAE9H5M4M2ADBG9C33';

scenario(
  'sbtc-deposit — bridge mint via complete-deposit-wrapper + transfer',
  () => {
    let sessionId: string;
    let signer: string;
    let depositTxid: Uint8Array;
    let burnHeight: number;
    const chosenHash = 'deadbeef'.repeat(8);
    const amount = 100_000n;

    let beforeRecipient: bigint;
    let beforeSecondary: bigint;
    let afterDepositRecipient: bigint;

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

    it('resolves the sBTC signer principal from sbtc-registry', async () => {
      const decoded = await readDataVar(
        sessionId,
        REGISTRY,
        'current-signer-principal',
        apiOptions(),
      );
      if (
        decoded.type !== ClarityType.PrincipalStandard &&
        decoded.type !== ClarityType.PrincipalContract
      ) {
        throw new Error(`expected principal, got ${cvToString(decoded)}`);
      }
      signer = decoded.value;
      expect(signer).toMatch(/^S[PMTN][0-9A-Z]+/);
    });

    it('forges a BTC deposit tx + synthetic burn block carrying the chosen header hash', async () => {
      const sbtcBridgePkh = hexToBytes(
        'aabbccddeeff00112233445566778899aabbccdd',
      );
      // sBTC deposit OP_RETURN payload: prefix marker + recipient hash placeholder.
      const opReturnPayload = hexToBytes(`5832${'00'.repeat(20)}`);
      const btcTx = forgeBitcoinTx({
        inputs: [
          {
            prevTxid: hexToBytes('00'.repeat(32)),
            prevVout: 0,
            scriptSig: new Uint8Array(),
          },
        ],
        outputs: [
          { value: amount, scriptPubKey: p2wpkhScript(sbtcBridgePkh) },
          { value: 0n, scriptPubKey: opReturnScript(opReturnPayload) },
        ],
      });
      depositTxid = btcTx.txid;
      expect(depositTxid).toHaveLength(32);

      const advance = await submitSimulationSteps(
        sessionId,
        {
          steps: [
            {
              AdvanceBlocks: {
                bitcoin_blocks: 1,
                stacks_blocks_per_bitcoin: 1,
                burn_header_hashes: { 0: chosenHash },
              },
            },
          ],
        },
        apiOptions(),
      );
      const step = advance.steps[0];
      if (!('AdvanceBlocks' in step) || !('Ok' in step.AdvanceBlocks)) {
        throw new Error(`AdvanceBlocks failed: ${JSON.stringify(step)}`);
      }
      const blocks: AdvancedBlockSummary[] = step.AdvanceBlocks.Ok;
      expect(blocks).toHaveLength(1);
      expect(blocks[0].burn_header_hash).toBe(chosenHash);
      expect(blocks[0].tenure_change).toBe(true);
      burnHeight = blocks[0].burn_height;
    });

    it('reads pre-deposit balances', async () => {
      beforeRecipient = await getFtBalance(
        sessionId,
        TOKEN,
        RECIPIENT,
        apiOptions(),
      );
      beforeSecondary = await getFtBalance(
        sessionId,
        TOKEN,
        SECONDARY,
        apiOptions(),
      );
    });

    it('signer calls complete-deposit-wrapper, recipient mint succeeds', async () => {
      const signerNonce = Number(
        await getNonce(sessionId, signer, apiOptions()),
      );
      const depositTx = await buildUnsignedContractCallHex({
        sender: signer,
        contract: DEPOSIT,
        functionName: 'complete-deposit-wrapper',
        functionArgs: [
          Cl.bufferFromHex(bytesToHex(depositTxid)),
          Cl.uint(0), // vout-index
          Cl.uint(amount),
          Cl.principal(RECIPIENT),
          Cl.bufferFromHex(chosenHash),
          Cl.uint(burnHeight),
          Cl.bufferFromHex('22'.repeat(32)), // sweep-txid placeholder
        ],
        nonce: signerNonce,
      });
      const r = await submitSimulationSteps(
        sessionId,
        { steps: [{ Transaction: depositTx }] },
        apiOptions(),
      );
      const step = r.steps[0];
      if (!('Transaction' in step) || !('Ok' in step.Transaction)) {
        throw new Error(
          `deposit failed: ${JSON.stringify(step).slice(0, 300)}`,
        );
      }
      const receipt = step.Transaction.Ok;
      expect(receipt.vm_error).toBeNull();
      expect(receipt.post_condition_aborted).toBe(false);
      const decoded = deserializeCV(receipt.result);
      expect(cvToString(decoded)).toBe('(ok true)');

      afterDepositRecipient = await getFtBalance(
        sessionId,
        TOKEN,
        RECIPIENT,
        apiOptions(),
      );
      const afterDepositSecondary = await getFtBalance(
        sessionId,
        TOKEN,
        SECONDARY,
        apiOptions(),
      );
      expect(afterDepositRecipient).toBe(beforeRecipient + amount);
      expect(afterDepositSecondary).toBe(beforeSecondary);
    });

    it('recipient transfers half of the new sBTC to secondary', async () => {
      const transferAmount = amount / 2n;
      const r = await callContract(
        sessionId,
        {
          sender: RECIPIENT,
          contract: TOKEN,
          functionName: 'transfer',
          functionArgs: [
            Cl.uint(transferAmount),
            Cl.principal(RECIPIENT),
            Cl.principal(SECONDARY),
            Cl.none(),
          ],
        },
        apiOptions(),
      );
      expect(r.vmError).toBeNull();
      expect(r.pcAborted).toBe(false);
      expect(r.result).toBe('(ok true)');

      const finalRecipient = await getFtBalance(
        sessionId,
        TOKEN,
        RECIPIENT,
        apiOptions(),
      );
      const finalSecondary = await getFtBalance(
        sessionId,
        TOKEN,
        SECONDARY,
        apiOptions(),
      );
      expect(finalRecipient).toBe(afterDepositRecipient - transferAmount);
      expect(finalSecondary).toBe(beforeSecondary + transferAmount);
    });
  },
);
