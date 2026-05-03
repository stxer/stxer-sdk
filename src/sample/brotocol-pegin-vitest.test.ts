/**
 * Vitest demo — Brotocol BTC peg-in, end-to-end (forged tx + SPV).
 *
 * Flow:
 *  1. Test fixture: override `executor-dao` with a permissive stub
 *     (always-true `is-extension`), unpause peg-in, zero fees,
 *     approve a chosen P2WPKH bridge scriptPubKey.
 *  2. Forge a Bitcoin transaction depositing into the approved
 *     scriptPubKey, with OP_RETURN carrying the recipient principal
 *     in consensus form.
 *  3. Build a 2-tx Merkle proof + 80-byte block header; synthesize a
 *     burn block whose `burn_header_hash` matches the header hash.
 *  4. Call `finalize-peg-in-0`; assert mint + replay rejection
 *     (`err u1005`).
 *  5. Recipient transfers half to a secondary; balances reflect.
 */
import {
  Cl,
  cvToString,
  deserializeCV,
  serializeCV,
} from '@stacks/transactions';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type AdvancedBlockSummary,
  buildBitcoinHeader,
  bytesToHex,
  callContract,
  createSimulationSession,
  forgeBitcoinTx,
  getFtBalance,
  hexToBytes,
  merkleProof,
  opReturnScript,
  p2wpkhScript,
  submitSimulationSteps,
} from '..';
import { apiOptions } from './_helpers';

const SKIP = process.env.STXER_SKIP_NETWORK_TESTS === '1';
const scenario = SKIP ? describe.skip : describe;

const FIXED_BLOCK_HEIGHT = 7_113_629;
const FIXED_BLOCK_HASH =
  'e213fd816584e196ca0ae8bb3c628f98f85c0173aec89d5276d8f25370270632';

const BRO_DEPLOYER = 'SP2XD7417HGPRTREMKF748VNEQPDRR0RMANB7X1NK';
const ENDPOINT = `${BRO_DEPLOYER}.btc-peg-in-endpoint-v2-01`;
const REGISTRY = `${BRO_DEPLOYER}.btc-bridge-registry-v2-01`;
const DAO = `${BRO_DEPLOYER}.executor-dao`;
const TOKEN_ABTC = `${BRO_DEPLOYER}.token-abtc`;

// Permissive DAO replacement — every caller is an extension.
const PERMISSIVE_DAO_CODE = `
(define-read-only (is-extension (extension principal)) true)
(define-read-only (executed-at (proposal principal)) none)
`;

const RECIPIENT = 'SP3573HMB9SPCTMT85YS85KEPYCX33E6MZGQ5QB2A';
const SECONDARY = 'SP1Y7GTHNJ1XWZYPP5WDGSNVAE9H5M4M2ADBG9C33';
const SENDER = RECIPIENT;

const BRIDGE_SCRIPT_HASH = hexToBytes(
  'c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0',
);
const PEG_IN_AMOUNT = 100_000n;

scenario('brotocol — finalize-peg-in-0 with forged BTC tx + SPV proof', () => {
  let sessionId: string;
  let bridgeScript: Uint8Array;

  beforeAll(async () => {
    sessionId = await createSimulationSession(
      {
        block_height: FIXED_BLOCK_HEIGHT,
        block_hash: FIXED_BLOCK_HASH,
        skip_tracing: true,
      },
      apiOptions(),
    );
    bridgeScript = p2wpkhScript(BRIDGE_SCRIPT_HASH);
  }, 60_000);

  it('installs permissive DAO + unpauses bridge + zeros fees + approves scriptPubKey', async () => {
    const r = await submitSimulationSteps(
      sessionId,
      { steps: [{ SetContractCode: [DAO, PERMISSIVE_DAO_CODE, 2] }] },
      apiOptions(),
    );
    const step = r.steps[0];
    if (!('SetContractCode' in step) || !('Ok' in step.SetContractCode)) {
      throw new Error(`DAO override failed: ${JSON.stringify(step)}`);
    }

    const unpause = await callContract(
      sessionId,
      {
        sender: SENDER,
        contract: ENDPOINT,
        functionName: 'pause-peg-in',
        functionArgs: [Cl.bool(false)],
      },
      apiOptions(),
    );
    expect(unpause.result).toBe('(ok true)');

    const setFee = await callContract(
      sessionId,
      {
        sender: SENDER,
        contract: ENDPOINT,
        functionName: 'set-peg-in-fee',
        functionArgs: [Cl.uint(0)],
      },
      apiOptions(),
    );
    expect(setFee.result).toBe('(ok true)');

    const setMinFee = await callContract(
      sessionId,
      {
        sender: SENDER,
        contract: ENDPOINT,
        functionName: 'set-peg-in-min-fee',
        functionArgs: [Cl.uint(0)],
      },
      apiOptions(),
    );
    expect(setMinFee.result).toBe('(ok true)');

    const approve = await callContract(
      sessionId,
      {
        sender: SENDER,
        contract: REGISTRY,
        functionName: 'approve-peg-in-address',
        functionArgs: [
          Cl.bufferFromHex(bytesToHex(bridgeScript)),
          Cl.bool(true),
        ],
      },
      apiOptions(),
    );
    expect(approve.result).toBe('(ok true)');
  });

  it('forges peg-in tx + 2-leaf merkle root + synthesized burn block, finalizes mint', async () => {
    // Order payload: consensus-encoded recipient principal (22 bytes for a
    // standard SP… principal: 0x05 type prefix + 0x16 version + 20-byte hash).
    const orderPayload = hexToBytes(serializeCV(Cl.principal(RECIPIENT)));
    expect(orderPayload).toHaveLength(22);

    const btcTx = forgeBitcoinTx({
      inputs: [
        {
          prevTxid: hexToBytes('00'.repeat(32)),
          prevVout: 0,
          scriptSig: new Uint8Array(),
          sequence: 0xffffffff,
        },
      ],
      outputs: [
        { value: PEG_IN_AMOUNT, scriptPubKey: bridgeScript },
        { value: 0n, scriptPubKey: opReturnScript(orderPayload) },
      ],
    });

    // Use a 2-tx merkle (peg-in at index 0, decoy at index 1) so the
    // proof exercises the real merkle-verifier code path. Single-tx
    // blocks would special-case the Bitcoin "duplicate the leaf to
    // pair" rule.
    const decoyTxid = hexToBytes('dd'.repeat(32));
    const { proof, root } = merkleProof([btcTx.txid, decoyTxid], 0);
    const { header, hash: headerHash } = buildBitcoinHeader({
      merkleRoot: root,
      timestamp: 1_700_000_000,
    });

    const advance = await submitSimulationSteps(
      sessionId,
      {
        steps: [
          {
            AdvanceBlocks: {
              bitcoin_blocks: 1,
              stacks_blocks_per_bitcoin: 1,
              burn_header_hashes: { 0: bytesToHex(headerHash) },
            },
          },
        ],
      },
      apiOptions(),
    );
    const advStep = advance.steps[0];
    if (!('AdvanceBlocks' in advStep) || !('Ok' in advStep.AdvanceBlocks)) {
      throw new Error(`AdvanceBlocks failed: ${JSON.stringify(advStep)}`);
    }
    const tip: AdvancedBlockSummary = advStep.AdvanceBlocks.Ok[0];
    expect(tip.burn_header_hash).toBe(bytesToHex(headerHash));

    const beforeRecipient = await getFtBalance(
      sessionId,
      TOKEN_ABTC,
      RECIPIENT,
      apiOptions(),
    );
    const beforeSecondary = await getFtBalance(
      sessionId,
      TOKEN_ABTC,
      SECONDARY,
      apiOptions(),
    );

    const proofTuple = Cl.tuple({
      'tx-index': Cl.uint(0),
      hashes: Cl.list(proof.map((h) => Cl.bufferFromHex(bytesToHex(h)))),
      'tree-depth': Cl.uint(proof.length),
    });
    const blockTuple = Cl.tuple({
      header: Cl.bufferFromHex(bytesToHex(header)),
      height: Cl.uint(tip.burn_height),
    });

    const pegIn = await callContract(
      sessionId,
      {
        sender: SENDER,
        contract: ENDPOINT,
        functionName: 'finalize-peg-in-0',
        functionArgs: [
          Cl.bufferFromHex(bytesToHex(btcTx.bytes)),
          blockTuple,
          proofTuple,
          Cl.uint(0), // output-idx
          Cl.uint(1), // order-idx
        ],
      },
      apiOptions(),
    );
    expect(pegIn.vmError).toBeNull();
    expect(pegIn.pcAborted).toBe(false);
    expect(pegIn.result).toBe('(ok true)');

    const afterMintRecipient = await getFtBalance(
      sessionId,
      TOKEN_ABTC,
      RECIPIENT,
      apiOptions(),
    );
    const afterMintSecondary = await getFtBalance(
      sessionId,
      TOKEN_ABTC,
      SECONDARY,
      apiOptions(),
    );
    expect(afterMintRecipient).toBe(beforeRecipient + PEG_IN_AMOUNT);
    expect(afterMintSecondary).toBe(beforeSecondary);

    // Replay rejection: same tx + proof should fail with err-already-sent.
    const replay = await callContract(
      sessionId,
      {
        sender: SENDER,
        contract: ENDPOINT,
        functionName: 'finalize-peg-in-0',
        functionArgs: [
          Cl.bufferFromHex(bytesToHex(btcTx.bytes)),
          blockTuple,
          proofTuple,
          Cl.uint(0),
          Cl.uint(1),
        ],
      },
      apiOptions(),
    );
    const replayDecoded = deserializeCV(replay.resultHex);
    expect(cvToString(replayDecoded)).toBe('(err u1005)');

    // Recipient transfers half to secondary.
    const transferAmount = PEG_IN_AMOUNT / 2n;
    const transfer = await callContract(
      sessionId,
      {
        sender: RECIPIENT,
        contract: TOKEN_ABTC,
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
    expect(transfer.vmError).toBeNull();
    expect(transfer.result).toBe('(ok true)');

    const finalRecipient = await getFtBalance(
      sessionId,
      TOKEN_ABTC,
      RECIPIENT,
      apiOptions(),
    );
    const finalSecondary = await getFtBalance(
      sessionId,
      TOKEN_ABTC,
      SECONDARY,
      apiOptions(),
    );
    expect(finalRecipient).toBe(afterMintRecipient - transferAmount);
    expect(finalSecondary).toBe(afterMintSecondary + transferAmount);
  });
});
