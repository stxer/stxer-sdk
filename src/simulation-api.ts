/**
 * Low-level programmatic simulation APIs
 *
 * These functions provide direct access to the stxer V2 simulation endpoints
 * for programmatic use cases where you need more control than SimulationBuilder provides.
 */

import { DEFAULT_STXER_API } from './constants';
import type {
  InstantSimulationRequest,
  InstantSimulationResponse,
  SimulationBatchReadsRequest,
  SimulationBatchReadsResponse,
  SimulationResult,
  SubmitSimulationStepsRequest,
  SubmitSimulationStepsResponse,
} from './types';

/**
 * Options for API calls
 */
export interface SimulationApiOptions {
  /** stxer API endpoint (default: https://api.stxer.xyz) */
  stxerApi?: string;
}

/**
 * Create simulation session options
 */
export interface CreateSessionOptions {
  /** Block height for simulation (optional, uses tip if not provided) */
  block_height?: number;
  /** Block hash corresponding to block_height */
  block_hash?: string;
  /** Skip debug tracing for faster simulations */
  skip_tracing?: boolean;
}

/**
 * Instantly simulate a transaction
 *
 * This is useful for apps/wallets to get the result of a transaction before sending it.
 * Lightweight - no debug tracing information.
 *
 * @param request - Instant simulation request
 * @param options - API options
 * @returns Instant simulation response with receipt and optional reads
 *
 * @example
 * ```typescript
 * import { instantSimulation } from 'stxer';
 *
 * const result = await instantSimulation({
 *   transaction: '0x...',
 *   block_height: 130818,
 *   block_hash: '0x...',
 *   reads: [
 *     { DataVar: ['SP...contract', 'my-var'] },
 *     { StxBalance: 'SP...' }
 *   ]
 * });
 * console.log(result.receipt.result);
 * ```
 */
export async function instantSimulation(
  request: InstantSimulationRequest,
  options: SimulationApiOptions = {},
): Promise<InstantSimulationResponse> {
  const apiEndpoint = options.stxerApi ?? DEFAULT_STXER_API;

  const response = await fetch(
    `${apiEndpoint}/devtools/v2/simulations:instant`,
    {
      method: 'POST',
      body: JSON.stringify(request),
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Instant simulation failed: ${text}`);
  }

  return response.json() as Promise<InstantSimulationResponse>;
}

/**
 * Create a new simulation session
 *
 * A session allows you to run multiple steps in a forked chain state.
 *
 * @param options - Create session options
 * @param apiOptions - API options
 * @returns Session ID
 *
 * @example
 * ```typescript
 * import { createSimulationSession } from 'stxer';
 *
 * const sessionId = await createSimulationSession({
 *   block_height: 130818,
 *   skip_tracing: false
 * });
 * ```
 */
export async function createSimulationSession(
  options: CreateSessionOptions = {},
  apiOptions: SimulationApiOptions = {},
): Promise<string> {
  const apiEndpoint = apiOptions.stxerApi ?? DEFAULT_STXER_API;

  const response = await fetch(`${apiEndpoint}/devtools/v2/simulations`, {
    method: 'POST',
    body: JSON.stringify(options),
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to create simulation session: ${text}`);
  }

  const result = (await response.json()) as { id: string };
  return result.id;
}

/**
 * Submit steps to a simulation session
 *
 * Steps are executed sequentially in the session's forked chain state.
 *
 * @param sessionId - Simulation session ID
 * @param request - Steps to submit
 * @param options - API options
 * @returns Array of step results
 *
 * @example
 * ```typescript
 * import { submitSimulationSteps } from 'stxer';
 *
 * const results = await submitSimulationSteps(sessionId, {
 *   steps: [
 *     { Transaction: '0x...' },
 *     { Eval: ['SP...', '', 'SP...contract', '(var-get my-var)'] },
 *     { Reads: [{ DataVar: ['SP...contract', 'my-var'] }] }
 *   ]
 * });
 * ```
 */
export async function submitSimulationSteps(
  sessionId: string,
  request: SubmitSimulationStepsRequest,
  options: SimulationApiOptions = {},
): Promise<SubmitSimulationStepsResponse> {
  const apiEndpoint = options.stxerApi ?? DEFAULT_STXER_API;

  const response = await fetch(
    `${apiEndpoint}/devtools/v2/simulations/${sessionId}`,
    {
      method: 'POST',
      body: JSON.stringify(request),
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to submit simulation steps: ${text}`);
  }

  return response.json() as Promise<SubmitSimulationStepsResponse>;
}

/**
 * Get simulation session results
 *
 * Returns the full simulation result including metadata and all step results.
 *
 * @param sessionId - Simulation session ID
 * @param options - API options
 * @returns Complete simulation result
 *
 * @example
 * ```typescript
 * import { getSimulationResult } from 'stxer';
 *
 * const result = await getSimulationResult(sessionId);
 * console.log(result.metadata);
 * console.log(result.steps);
 * ```
 */
export async function getSimulationResult(
  sessionId: string,
  options: SimulationApiOptions = {},
): Promise<SimulationResult> {
  const apiEndpoint = options.stxerApi ?? DEFAULT_STXER_API;

  const response = await fetch(
    `${apiEndpoint}/devtools/v2/simulations/${sessionId}`,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to get simulation result: ${text}`);
  }

  return response.json() as Promise<SimulationResult>;
}

/**
 * Batch reads from a simulation session
 *
 * Similar to sidecar batch reads, but reads from the simulation's forked state.
 *
 * @param sessionId - Simulation session ID
 * @param request - Batch reads request
 * @param options - API options
 * @returns Batch read results
 *
 * @example
 * ```typescript
 * import { simulationBatchReads } from 'stxer';
 *
 * const results = await simulationBatchReads(sessionId, {
 *   vars: [['SP...contract', 'my-var']],
 *   maps: [['SP...contract', 'my-map', '0x...']],
 *   stx: ['SP...']
 * });
 * console.log(results.vars);
 * ```
 */
export async function simulationBatchReads(
  sessionId: string,
  request: SimulationBatchReadsRequest,
  options: SimulationApiOptions = {},
): Promise<SimulationBatchReadsResponse> {
  const apiEndpoint = options.stxerApi ?? DEFAULT_STXER_API;

  const response = await fetch(
    `${apiEndpoint}/devtools/v2/simulations/${sessionId}/reads`,
    {
      method: 'POST',
      body: JSON.stringify(request),
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to batch reads from simulation: ${text}`);
  }

  return response.json() as Promise<SimulationBatchReadsResponse>;
}
