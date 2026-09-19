/**
 * WARNING:
 *
 * this file will be used in cross-runtime environments (browser, cloudflare workers, XLinkSDK, etc.),
 * so please be careful when adding `import`s to it.
 */

import { DEFAULT_STXER_API } from './constants';
import type { ClarityEpoch, ContractAST, SymbolicExpression } from './types';

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
  clarityVersion?: '1' | '2' | '3' | '4' | '5' | '6';
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

/**
 * Index every expression of an AST by its `id`, descending into nested
 * lists. Ids are unique within one contract, so build one index per
 * contract.
 *
 * This is the lookup table for mapping a debug-trace node back to source:
 * a {@link TraceNode}'s `id` is the `id` of the expression that produced
 * it.
 *
 * @example
 * ```typescript
 * const ast = await getContractAST({ contractId });
 * const byId = indexExpressions(ast.expressions);
 * const expression = byId.get(node.id);
 * ```
 */
export function indexExpressions(
  expressions: SymbolicExpression[],
): Map<number, SymbolicExpression> {
  const byId = new Map<number, SymbolicExpression>();
  const pending = [...expressions];
  for (let expr = pending.pop(); expr; expr = pending.pop()) {
    byId.set(expr.id, expr);
    if ('list' in expr.expr) {
      pending.push(...expr.expr.list);
    }
  }
  return byId;
}

/**
 * A parsed {@link SymbolicExpression.span}. Lines and columns are
 * 1-based, and the end position is inclusive — it points at the last
 * character of the expression, not one past it.
 */
export interface SourceSpan {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/**
 * Parse a span string of the form `startLine:startColumn-endLine:endColumn`
 * (e.g. `"361:2-363:83"`).
 */
export function parseSpan(span: string): SourceSpan {
  const match = /^(\d+):(\d+)-(\d+):(\d+)$/.exec(span);
  if (!match) {
    throw new Error(`Invalid source span: "${span}"`);
  }
  const [startLine, startColumn, endLine, endColumn] = match
    .slice(1)
    .map(Number);
  return { startLine, startColumn, endLine, endColumn };
}

// Offsets at which each line of the most recently sliced source begins.
// Slicing every node of a trace means thousands of lookups into the same
// few sources, so one remembered entry removes nearly all the rescans.
let lineStartsCache: { sourceCode: string; lineStarts: number[] } | undefined;

function lineStartsOf(sourceCode: string): number[] {
  if (lineStartsCache?.sourceCode !== sourceCode) {
    const lineStarts = [0];
    for (
      let newline = sourceCode.indexOf('\n');
      newline !== -1;
      newline = sourceCode.indexOf('\n', newline + 1)
    ) {
      lineStarts.push(newline + 1);
    }
    lineStartsCache = { sourceCode, lineStarts };
  }
  return lineStartsCache.lineStarts;
}

/**
 * Extract the source text an expression's span covers.
 *
 * Returns an empty string for a span that does not fall inside the
 * source.
 *
 * @param sourceCode - The contract source, e.g. {@link ContractAST.source_code}
 * @param span - A {@link SymbolicExpression.span}
 *
 * @example
 * ```typescript
 * sliceSpan(ast.source_code, '361:6-361:95');
 * // '(is-some (get-pool-exists (contract-of token-x-trait) …))'
 * ```
 */
export function sliceSpan(sourceCode: string, span: string): string {
  const { startLine, startColumn, endLine, endColumn } = parseSpan(span);
  const lineStarts = lineStartsOf(sourceCode);
  if (
    startLine < 1 ||
    startColumn < 1 ||
    endLine < startLine ||
    endLine > lineStarts.length
  ) {
    return '';
  }
  return sourceCode.slice(
    lineStarts[startLine - 1] + startColumn - 1,
    lineStarts[endLine - 1] + endColumn,
  );
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
