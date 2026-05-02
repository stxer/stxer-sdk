/**
 * Higher-level helpers that bind to a simulation session.
 *
 * These wrap `submitSimulationSteps` / `simulationBatchReads` for the
 * common patterns simulation tests reach for: read a fungible-token
 * balance, read a principal's STX balance / nonce, send a contract
 * call and decode the result.
 *
 * Errors:
 *  - Wire-level failures (HTTP non-2xx) propagate as the typed
 *    {@link SimulationError} from {@link simulation-api}.
 *  - Per-step `Err` results (validation failures) throw a normal
 *    `Error` carrying the upstream message.
 *  - VM-level failures (`vm_error`) and post-condition aborts are
 *    returned via {@link CallContractResult.vmError} /
 *    `pcAborted` — they do NOT throw, so callers can assert on them.
 */
import {
  Cl,
  ClarityType,
  type ClarityValue,
  cvToString,
  deserializeCV,
  type PostConditionMode,
  serializeCV,
} from '@stacks/transactions';
import {
  type SimulationApiOptions,
  simulationBatchReads,
  submitSimulationSteps,
} from './simulation-api';
import {
  buildUnsignedContractCallHex,
  type ContractCallTxArgs,
} from './transaction';
import type { TransactionReceipt } from './types';

export interface CallContractResult {
  /** Decoded Clarity result (e.g. `(ok true)`, `(err u100)`, `u5`). */
  result: string;
  /** Hex-encoded raw Clarity result (SIP-005). */
  resultHex: string;
  /** VM-level error message, if any (e.g. arithmetic overflow). */
  vmError: string | null;
  /** True when one or more post-conditions tripped. */
  pcAborted: boolean;
  /** Full upstream receipt for callers that need more detail. */
  receipt: TransactionReceipt;
}

/**
 * Build, submit, and decode a contract-call transaction. The caller
 * supplies the principal to use as `tx-sender`; nonce is auto-fetched
 * via {@link getNonce} unless `nonce` is explicitly provided.
 */
export async function callContract(
  sessionId: string,
  args: Omit<ContractCallTxArgs, 'nonce'> & {
    nonce?: number;
    postConditionMode?: PostConditionMode;
  },
  options: SimulationApiOptions = {},
): Promise<CallContractResult> {
  const nonce =
    args.nonce ?? Number(await getNonce(sessionId, args.sender, options));
  const txHex = await buildUnsignedContractCallHex({ ...args, nonce });
  const r = await submitSimulationSteps(
    sessionId,
    { steps: [{ Transaction: txHex }] },
    options,
  );
  const step = r.steps[0];
  if (!('Transaction' in step)) {
    throw new Error(
      `expected Transaction step, got ${JSON.stringify(step).slice(0, 200)}`,
    );
  }
  if ('Err' in step.Transaction) {
    throw new Error(`Transaction Err: ${step.Transaction.Err}`);
  }
  const receipt = step.Transaction.Ok;
  return {
    result: cvToString(deserializeCV(receipt.result)),
    resultHex: receipt.result,
    vmError: receipt.vm_error,
    pcAborted: receipt.post_condition_aborted,
    receipt,
  };
}

/**
 * Read the SIP-010 / hBTC-style `(get-balance principal)` value.
 * Returns 0n if the read returns `(err …)`. Throws on infra failures.
 */
export async function getFtBalance(
  sessionId: string,
  contractId: string,
  principal: string,
  options: SimulationApiOptions = {},
): Promise<bigint> {
  const r = await simulationBatchReads(
    sessionId,
    {
      readonly: [
        [contractId, 'get-balance', serializeCV(Cl.principal(principal))],
      ],
    },
    options,
  );
  const v = r.readonly?.[0];
  if (!v || !('Ok' in v)) {
    throw new Error(`get-balance(${contractId}) failed: ${JSON.stringify(v)}`);
  }
  const decoded = deserializeCV(v.Ok);
  if (decoded.type === ClarityType.ResponseErr) {
    return 0n;
  }
  if (decoded.type !== ClarityType.ResponseOk) {
    throw new Error(`unexpected get-balance shape: ${cvToString(decoded)}`);
  }
  if (decoded.value.type !== ClarityType.UInt) {
    throw new Error(`expected uint inside (ok …), got ${decoded.value.type}`);
  }
  return BigInt(decoded.value.value);
}

/** Read a principal's STX balance (uSTX) from a simulation session. */
export async function getStxBalance(
  sessionId: string,
  principal: string,
  options: SimulationApiOptions = {},
): Promise<bigint> {
  const r = await simulationBatchReads(
    sessionId,
    { stx: [principal] },
    options,
  );
  const v = r.stx?.[0];
  if (!v || !('Ok' in v)) {
    throw new Error(`stx balance read for ${principal} failed`);
  }
  return BigInt(v.Ok);
}

/** Read a principal's current nonce. Returns 0n if never seen. */
export async function getNonce(
  sessionId: string,
  principal: string,
  options: SimulationApiOptions = {},
): Promise<bigint> {
  const r = await simulationBatchReads(
    sessionId,
    { nonces: [principal] },
    options,
  );
  const v = r.nonces?.[0];
  if (!v || !('Ok' in v)) return 0n;
  return BigInt(v.Ok);
}

/**
 * Read a Clarity data variable. Returns the decoded `ClarityValue`,
 * or throws if the read failed.
 */
export async function readDataVar(
  sessionId: string,
  contractId: string,
  varName: string,
  options: SimulationApiOptions = {},
): Promise<ClarityValue> {
  const r = await simulationBatchReads(
    sessionId,
    { vars: [[contractId, varName]] },
    options,
  );
  const v = r.vars?.[0];
  if (!v || !('Ok' in v)) {
    throw new Error(
      `var-get ${contractId} ${varName} failed: ${JSON.stringify(v)}`,
    );
  }
  return deserializeCV(v.Ok);
}
