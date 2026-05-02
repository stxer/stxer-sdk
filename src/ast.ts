/**
 * WARNING:
 *
 * this file will be used in cross-runtime environments (browser, cloudflare workers, XLinkSDK, etc.),
 * so please be careful when adding `import`s to it.
 */

import { DEFAULT_STXER_API } from './constants';
import type { ClarityEpoch, ContractAST } from './types';

export interface AstOptions {
  stxerApi?: string;
}

export interface GetContractAstOptions extends AstOptions {
  contractId: string;
}

/**
 * Fetch the AST for an on-chain contract.
 * @param options - Contract ID and optional API endpoint
 * @returns The contract AST with metadata
 */
export async function getContractAST(
  options: GetContractAstOptions,
): Promise<ContractAST> {
  const url = `${options.stxerApi ?? DEFAULT_STXER_API}/contracts/${options.contractId}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch contract AST: ${response.status} ${response.statusText}`,
    );
  }

  const text = await response.text();
  if (!text.startsWith('{')) {
    throw new Error(`Invalid response from contracts endpoint: ${text}`);
  }

  return JSON.parse(text) as ContractAST;
}

export interface ParseContractOptions extends AstOptions {
  sourceCode: string;
  contractId: string;
  clarityVersion?: '1' | '2' | '3' | '4' | '5';
  epoch?: ClarityEpoch;
}

/**
 * Parse contract source code into an AST.
 * @param options - Source code, contract ID, and optional configuration
 * @returns The parsed contract AST
 */
export async function parseContract(
  options: ParseContractOptions,
): Promise<ContractAST> {
  const url = `${options.stxerApi ?? DEFAULT_STXER_API}/contracts:parse`;

  const payload: {
    contract_id: string;
    source_code: string;
    clarity_version?: string;
    epoch?: string;
  } = {
    contract_id: options.contractId,
    source_code: options.sourceCode,
  };

  if (options.clarityVersion !== undefined) {
    payload.clarity_version = options.clarityVersion;
  }
  if (options.epoch !== undefined) {
    payload.epoch = options.epoch;
  }

  const response = await fetch(url, {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to parse contract: ${response.status} ${response.statusText}`,
    );
  }

  const text = await response.text();
  if (!text.startsWith('{')) {
    throw new Error(`Invalid response from contract parse endpoint: ${text}`);
  }

  return JSON.parse(text) as ContractAST;
}

// Re-export AST-related types for convenience
export type {
  ClarityAbi,
  ClarityAbiFunction,
  ClarityAbiFungibleToken,
  ClarityAbiMap,
  ClarityAbiNonFungibleToken,
  ClarityAbiType,
  ClarityAbiVariable,
  ClarityEpoch,
  ClarityVersion,
  ContractAST,
  SymbolicExpression,
} from './types';
