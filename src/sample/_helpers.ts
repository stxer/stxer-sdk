/**
 * Tiny helpers shared by the v2 samples. Inline-equivalent to what
 * SimulationBuilder does internally — extracted here so each sample
 * can lean on the typed v2 surface without pulling in the builder.
 */
import {
  AddressHashMode,
  AddressVersion,
  type MultiSigSpendingCondition,
  type StacksTransactionWire,
} from '@stacks/transactions';
import { c32addressDecode } from 'c32check';

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Rewrite an unsigned transaction's spending condition so the upstream
 * simulator treats `sender` as the origin without requiring a real
 * signature. Mirrors the helper inside SimulationBuilder.
 */
export function setSender(tx: StacksTransactionWire, sender: string) {
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
  }
  return tx;
}

/** Look up the sender's current nonce on mainnet (Hiro public node). */
export async function getNonce(
  sender: string,
  indexBlockHash: string,
): Promise<bigint> {
  const url = `https://api.hiro.so/v2/accounts/${sender}?proof=false&tip=${indexBlockHash}`;
  const r = await fetch(url);
  if (!r.ok) {
    throw new Error(`failed to fetch nonce for ${sender}: ${r.status}`);
  }
  const { nonce } = (await r.json()) as { nonce: number };
  return BigInt(nonce);
}
