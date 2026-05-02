/**
 * Sample-only helpers — env-driven endpoint resolution and a Stacks
 * nonce lookup. Everything else the samples use is imported directly
 * from the SDK barrel (`'..'`).
 */
import { STXER_API_MAINNET } from '../constants';
import type { SimulationApiOptions } from '../simulation-api';

const STACKS_API_DEFAULT = 'https://api.hiro.so';

/**
 * Read `STXER_API` from the environment and return it as a
 * {@link SimulationApiOptions} value. Falls back to mainnet
 * (`https://api.stxer.xyz`) when the env var is unset, matching the
 * SDK's own default.
 */
export const apiOptions = (): SimulationApiOptions => ({
  stxerApi: process.env.STXER_API ?? STXER_API_MAINNET,
});

/**
 * Stacks node / extended-API endpoint used by the samples for
 * non-simulator lookups (block info, nonces, etc.). Reads the
 * `STACKS_API` env var so a custom run can point this at a stacks-api
 * co-located with the same chainstate the simulator is using; defaults
 * to the public Hiro node otherwise.
 */
export const stacksApi = (): string =>
  process.env.STACKS_API ?? STACKS_API_DEFAULT;

/**
 * Look up `sender`'s on-chain nonce at the given `indexBlockHash` via
 * the Stacks node API selected by {@link stacksApi}. Used by samples
 * that build `instantSimulation` transactions before any simulation
 * session exists — once a session is in flight, prefer the SDK's
 * session-bound `getNonce(sessionId, principal)` from `'stxer'`
 * instead.
 *
 * Named `getOnChainNonce` to avoid collision with the SDK-exported
 * `getNonce(sessionId, principal, options)` (different signature).
 */
export async function getOnChainNonce(
  sender: string,
  indexBlockHash: string,
): Promise<bigint> {
  const url = `${stacksApi()}/v2/accounts/${sender}?proof=false&tip=${indexBlockHash}`;
  const r = await fetch(url);
  if (!r.ok) {
    throw new Error(`failed to fetch nonce for ${sender}: ${r.status}`);
  }
  const { nonce } = (await r.json()) as { nonce: number };
  return BigInt(nonce);
}
