/**
 * Transaction-building helpers for the simulator.
 *
 * The simulator does NOT verify signatures — it derives `tx-sender`
 * from the `signer` field (= hash160 of the public key) plus the
 * `hashMode` byte. By overriding those two fields on an *unsigned*
 * transaction, you can simulate any sender without a private key.
 *
 * {@link setSender} performs the override; {@link buildUnsignedContractCallHex}
 * combines the unsigned-tx builder from `@stacks/transactions` with
 * `setSender` and returns a hex string ready to drop into a
 * `{ Transaction: <hex> }` simulation step.
 */
import { AddressVersion, type StacksNetworkName } from '@stacks/network';
import {
  AddressHashMode,
  Cl,
  type ClarityValue,
  type MultiSigSpendingCondition,
  makeUnsignedContractCall,
  type PostCondition,
  PostConditionMode,
  type StacksTransactionWire,
  serializeTransaction,
} from '@stacks/transactions';
import { c32addressDecode } from 'c32check';

/**
 * Override the spending condition's `signer` (and `hashMode`) so the
 * simulator treats `tx-sender` as `sender`.
 *
 * Single-sig and multi-sig flavours are both handled — the multi-sig
 * spending condition is rebuilt with empty signature fields because
 * the simulator never validates signatures.
 */
export function setSender(
  tx: StacksTransactionWire,
  sender: string,
): StacksTransactionWire {
  const [addressVersion, signer] = c32addressDecode(sender);
  switch (addressVersion) {
    case AddressVersion.MainnetSingleSig:
    case AddressVersion.TestnetSingleSig:
      tx.auth.spendingCondition.hashMode = AddressHashMode.P2PKH;
      tx.auth.spendingCondition.signer = signer;
      break;
    case AddressVersion.MainnetMultiSig:
    case AddressVersion.TestnetMultiSig: {
      const sc = tx.auth.spendingCondition;
      tx.auth.spendingCondition = {
        hashMode: AddressHashMode.P2SH,
        signer,
        fields: [],
        signaturesRequired: 0,
        nonce: sc.nonce,
        fee: sc.fee,
      } as MultiSigSpendingCondition;
      break;
    }
    default:
      throw new Error(`unsupported address version: ${addressVersion}`);
  }
  return tx;
}

export interface ContractCallTxArgs {
  /** Principal to set as `tx-sender`. */
  sender: string;
  /** Fully-qualified contract id, e.g. `"SP1G48….dia-oracle"`. */
  contract: string;
  functionName: string;
  functionArgs: ClarityValue[];
  /** microSTX. Defaults to 1_000. */
  fee?: number;
  /** Nonce to declare. Caller is responsible for sequencing. */
  nonce: number;
  network?: StacksNetworkName;
  /**
   * Post-condition mode. Defaults to `Allow` so the simulator runs
   * the call regardless of asset movements; switch to `Deny` + an
   * explicit list when a test wants to assert post-condition
   * enforcement, or to `Originator` (SIP-040, epoch 3.4) to sweep
   * only the sender's own assets while leaving the called contract
   * unconstrained.
   */
  postConditionMode?: PostConditionMode;
  /**
   * Post conditions to attach. Under `Deny` and `Originator` these are
   * also the opt-in list: an asset a condition covers is exempt from
   * the unchecked-asset sweep, which is what makes the always-passing
   * codes (`maybe-sent`, `may-perform`) meaningful rather than inert.
   */
  postConditions?: PostCondition[];
}

/**
 * Build an unsigned contract-call transaction with `sender` patched
 * in via {@link setSender}, then return the serialized hex (no `0x`
 * prefix). Drop the result directly into `{ Transaction: <hex> }`.
 *
 * @example
 * ```typescript
 * import { Cl } from '@stacks/transactions';
 * import { buildUnsignedContractCallHex } from 'stxer';
 *
 * const txHex = await buildUnsignedContractCallHex({
 *   sender: 'SP3573...',
 *   contract: 'SM3VDXK...sbtc-deposit',
 *   functionName: 'complete-deposit-wrapper',
 *   functionArgs: [Cl.bufferFromHex(txid), Cl.uint(0), Cl.uint(amount), ...],
 *   nonce: 5,
 * });
 * await submitSimulationSteps(sim, { steps: [{ Transaction: txHex }] });
 * ```
 */
export async function buildUnsignedContractCallHex(
  args: ContractCallTxArgs,
): Promise<string> {
  const [contractAddress, contractName] = args.contract.split('.');
  if (!contractName) {
    throw new Error(`bad contract id "${args.contract}" — expected SP….name`);
  }
  const tx = await makeUnsignedContractCall({
    contractAddress,
    contractName,
    functionName: args.functionName,
    functionArgs: args.functionArgs,
    fee: args.fee ?? 1_000,
    nonce: args.nonce,
    // Dummy 33-byte compressed pubkey. The simulator never validates
    // the signature; setSender overwrites the derived signer hash.
    publicKey: '0'.repeat(66),
    network: args.network ?? 'mainnet',
    postConditionMode: args.postConditionMode ?? PostConditionMode.Allow,
    postConditions: args.postConditions,
  });
  setSender(tx, args.sender);
  return serializeTransaction(tx);
}

/**
 * Build a `Cl.contractPrincipal` from a `"SP….name"` id string.
 * Trips on standard principals or malformed ids — those should use
 * `Cl.principal` directly.
 */
export function ftPrincipal(contractId: string): ClarityValue {
  const [addr, name] = contractId.split('.');
  if (!name) {
    throw new Error(`bad contract id "${contractId}" — expected SP….name`);
  }
  return Cl.contractPrincipal(addr, name);
}
