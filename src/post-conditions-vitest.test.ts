import {
  Cl,
  deserializeTransaction,
  NonFungibleConditionCode,
  Pc,
  PostConditionMode,
} from '@stacks/transactions';
import { describe, expect, it } from 'vitest';

import { SimulationBuilder } from './simulation';
import { buildUnsignedContractCallHex } from './transaction';

/**
 * Offline: no network, no simulator. These assert that a post-condition mode
 * and list survive into the serialized bytes, which is the whole transport —
 * stxer-api proxies the hex opaquely and echoes it back, so whatever is
 * encoded here is what the simulator enforces and what the UI can read.
 */
const SENDER = 'SP2V3J7G42E8ZD1YPK6G6295EQ1EGZMPGDZQSRDWT';
const CONTRACT = `${SENDER}.juice-pool`;

const build = (extra: Record<string, unknown> = {}) =>
  buildUnsignedContractCallHex({
    sender: SENDER,
    contract: CONTRACT,
    functionName: 'pox-claim-rewards',
    functionArgs: [Cl.uint(141)],
    nonce: 0,
    ...extra,
  });

describe('contract-call post conditions', () => {
  it('defaults to Allow, preserving the previous behaviour', async () => {
    const tx = deserializeTransaction(await build());
    expect(tx.postConditionMode).toBe(PostConditionMode.Allow);
    expect(tx.postConditions.values).toHaveLength(0);
  });

  // SIP-040 / epoch 3.4. Without this the simulator never runs the
  // unchecked-asset sweep, so it can succeed where the real transaction
  // aborts — a false negative on the safety-critical direction.
  it('encodes Originator mode', async () => {
    const tx = deserializeTransaction(
      await build({ postConditionMode: PostConditionMode.Originator }),
    );
    expect(tx.postConditionMode).toBe(PostConditionMode.Originator);
  });

  it('encodes an always-passing NFT condition on the origin', async () => {
    const tx = deserializeTransaction(
      await build({
        postConditionMode: PostConditionMode.Originator,
        postConditions: [
          Pc.origin()
            .willMaybeSendAsset()
            .nft(`${SENDER}.my-token`, 'leo', Cl.uint(1)),
        ],
      }),
    );

    expect(tx.postConditionMode).toBe(PostConditionMode.Originator);
    expect(tx.postConditions.values).toHaveLength(1);
    const pc = tx.postConditions.values[0];
    // Under Deny/Originator this code is an opt-in that exempts the asset
    // from the sweep, not a no-op — it has to reach the wire intact.
    expect(pc).toMatchObject({
      conditionCode: NonFungibleConditionCode.MaybeSent,
    });
  });

  it('encodes an amount-bounded STX condition', async () => {
    const tx = deserializeTransaction(
      await build({
        postConditionMode: PostConditionMode.Deny,
        postConditions: [Pc.principal(SENDER).willSendLte(1_000_000).ustx()],
      }),
    );
    expect(tx.postConditionMode).toBe(PostConditionMode.Deny);
    expect(tx.postConditions.values).toHaveLength(1);
  });
});

// The builder is the surface most callers use, and everything up to `run()`
// is offline. This is the README's quick-start shape: if these options stop
// being accepted, the documented example stops compiling.
describe('SimulationBuilder post-condition options', () => {
  it('accepts a mode and conditions on the transaction steps', () => {
    const builder = SimulationBuilder.new({ network: 'mainnet' })
      .withSender(SENDER)
      .addContractCall({
        contract_id: CONTRACT,
        function_name: 'pox-claim-rewards',
        function_args: [Cl.uint(141)],
        post_condition_mode: PostConditionMode.Originator,
        post_conditions: [Pc.origin().willSendLte(1_000_000).ustx()],
      })
      .addContractDeploy({
        contract_name: 'probe',
        source_code: '(define-read-only (f) u1)',
        post_condition_mode: PostConditionMode.Deny,
        post_conditions: [Pc.principal(SENDER).willSendEq(1).ustx()],
      });

    expect(builder).toBeInstanceOf(SimulationBuilder);
  });
});
