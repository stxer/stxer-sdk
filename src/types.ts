/**
 * Type definitions for stxer-api V2 endpoints
 * Hand-written types based on OpenAPI spec at https://api.stxer.xyz/openapi.json
 */

// =============================================================================
// Sidecar Tip Types
// =============================================================================

export interface TenureCost {
  read_count: number;
  read_length: number;
  write_count: number;
  write_length: number;
  runtime: number;
}

export interface SidecarTip {
  bitcoin_height: number;
  block_hash: string;
  block_height: number;
  block_time: number;
  burn_block_height: number;
  burn_block_time: number;
  consensus_hash: string;
  index_block_hash: string;
  is_nakamoto: boolean;
  tenure_cost: TenureCost;
  tenure_height: number;
  sortition_id: string;
  epoch_id: string;
}

// =============================================================================
// AST Types
// =============================================================================

export interface ClarityAbiType {
  readonly?: { type: ClarityAbiTypeName; length?: number } | string;
  tuple?: { name: string; type: ClarityAbiType }[];
  list?: { type: ClarityAbiType; length: number };
  buffer?: { length: number };
  string_ascii?: { length: number };
  string_utf8?: { length: number };
  principal?: [];
  bool?: [];
  int?: { length: number };
  uint?: { length: number };
  response?: { ok: ClarityAbiType; error: ClarityAbiType };
  optional?: ClarityAbiType;
  contract?: { name: string; address: string };
}

export type ClarityAbiTypeName =
  | 'optional'
  | 'response'
  | 'bool'
  | 'int'
  | 'uint'
  | 'string-ascii'
  | 'string-utf8'
  | 'buff'
  | 'list'
  | 'tuple'
  | 'principal'
  | 'trait-reference'
  | 'contract';

export interface ClarityAbiFunction {
  name: string;
  access: 'private' | 'public' | 'read_only';
  args: Array<{ name: string; type: ClarityAbiType }>;
  outputs: { type: ClarityAbiType };
}

export interface ClarityAbiVariable {
  name: string;
  access: 'variable' | 'constant';
  type: ClarityAbiType;
}

export interface ClarityAbiMap {
  name: string;
  key: ClarityAbiType;
  value: ClarityAbiType;
}

export interface ClarityAbiFungibleToken {
  name: string;
}

export interface ClarityAbiNonFungibleToken {
  name: string;
  type: ClarityAbiType;
}

export type ClarityEpoch =
  | 'Epoch10'
  | 'Epoch20'
  | 'Epoch2_05'
  | 'Epoch21'
  | 'Epoch22'
  | 'Epoch23'
  | 'Epoch24'
  | 'Epoch25'
  | 'Epoch30'
  | 'Epoch31'
  | 'Epoch32'
  | 'Epoch33'
  | 'Epoch34'
  | 'Epoch35';

export type ClarityVersion = 'Clarity1' | 'Clarity2' | 'Clarity3' | 'Clarity4';

export interface ClarityAbi {
  functions: ClarityAbiFunction[];
  variables: ClarityAbiVariable[];
  maps: ClarityAbiMap[];
  fungible_tokens: ClarityAbiFungibleToken[];
  non_fungible_tokens: ClarityAbiNonFungibleToken[];
  epoch: ClarityEpoch;
  clarity_version: ClarityVersion;
}

export interface SymbolicExpressionField {
  field: string;
}

export interface SymbolicExpressionTraitReference {
  trait_reference: {
    clarity_name: string;
    trait_definition: string;
    trait_definition_type: 'Defined' | 'Imported';
  };
}

export interface SymbolicExpressionAtom {
  atom: string;
}

export interface SymbolicExpressionAtomValue {
  atom_value: string;
}

export interface SymbolicExpressionLiteralValue {
  literal_value: string;
}

export interface SymbolicExpressionList {
  list: SymbolicExpression[];
}

export type SymbolicExpression = {
  id: number;
  span: string;
  expr:
    | SymbolicExpressionAtom
    | SymbolicExpressionAtomValue
    | SymbolicExpressionLiteralValue
    | SymbolicExpressionList
    | SymbolicExpressionField
    | SymbolicExpressionTraitReference;
  pre_comments?: Array<{ comment: string; span: string }>;
  post_comments?: Array<{ comment: string; span: string }>;
  end_line_comment?: string;
};

export interface ContractAST {
  contract_identifier: string;
  expressions: SymbolicExpression[];
  top_level_expression_sorting: number[];
  referenced_traits: Record<
    string,
    { trait_definition: string; trait_definition_type: 'Defined' | 'Imported' }
  >;
  implemented_traits: string[];
  tx_id?: string;
  canonical?: boolean;
  contract_id?: string;
  block_height?: number;
  source_code?: string;
  abi?: ClarityAbi;
}

// =============================================================================
// V2 Simulation Types
// =============================================================================

export interface ExecutionCost {
  read_count: number;
  read_length: number;
  write_count: number;
  write_length: number;
  runtime: number;
}

/**
 * Receipt for a transaction that the engine executed to completion.
 *
 * "Successful execution" does NOT imply contract-level success. There are
 * four distinct failure signals, in increasing depth:
 *   1. Outer `Err` on `Result.Transaction` — engine could not run the tx
 *      at all (deserialization failure etc.); no receipt is produced.
 *   2. `post_condition_aborted: true` — execution ran, post-condition
 *      tripped, state was rolled back.
 *   3. `vm_error: string` — Clarity VM raised a runtime error.
 *   4. `(err uX)` inside `result` — contract returned a Clarity error
 *      response. Application-level; NOT signalled by any field above.
 *      Decode `result` to detect.
 *
 * (2) and (3) are independent — both may be set on the same receipt.
 */
export interface TransactionReceipt {
  /**
   * Clarity return value, SIP-005 hex-serialized. For contract-call txs
   * this includes the `(ok ...)` / `(err ...)` response wrapper —
   * Clarity-level `(err uX)` lives here, NOT on `vm_error` or the outer
   * `Err`.
   */
  result: string;
  stx_burned: number;
  tx_index: number;
  /**
   * VM-level runtime error message (e.g. `Runtime(...)` from the Clarity
   * interpreter). `null` when the tx did not raise a runtime error.
   * Independent of `post_condition_aborted` — both may be set.
   */
  vm_error: string | null;
  /**
   * `true` when one or more post-conditions failed and the tx was
   * aborted. Independent of `vm_error` — both may be set.
   */
  post_condition_aborted: boolean;
  /** Wall-clock simulation time in milliseconds. */
  costs: number;
  execution_cost: ExecutionCost;
  /**
   * Events emitted during execution (contract logs, STX transfers,
   * FT/NFT events, etc.). Each entry is a JSON-encoded **string** —
   * call `JSON.parse(events[i])` to get the event object. Items are
   * NOT JSON objects in the array.
   */
  events: string[];
}

export interface TransactionOkResult {
  Ok: TransactionReceipt;
}

export interface TransactionErrResult {
  Err: string;
}

// Read step types
export interface MapEntryStep {
  MapEntry: [contract_id: string, map_name: string, key_hex: string];
}

export interface DataVarStep {
  DataVar: [contract_id: string, variable_name: string];
}

export interface EvalReadonlyStep {
  /** `sponsor` is `""` (empty string) when there is no sponsor. */
  EvalReadonly: [
    sender: string,
    sponsor: string,
    contract_id: string,
    code: string,
  ];
}

export interface StxBalanceStep {
  /** Principal whose STX balance to read. */
  StxBalance: string;
}

export interface FtBalanceStep {
  /**
   * Reads the FT balance via three separate parameters. Note: the batch
   * `ft_balance` field on `SimulationBatchReadsRequest` uses a different
   * `<contract_id>::<token_name>` combined identifier shape.
   */
  FtBalance: [contract_id: string, token_name: string, principal: string];
}

export interface FtSupplyStep {
  FtSupply: [contract_id: string, token_name: string];
}

export interface NonceStep {
  /** Principal whose nonce to read. */
  Nonce: string;
}

export type ReadStep =
  | MapEntryStep
  | DataVarStep
  | EvalReadonlyStep
  | StxBalanceStep
  | FtBalanceStep
  | FtSupplyStep
  | NonceStep;

export interface ReadOkResult {
  Ok: string; // clarity value hex OR number string for balances/nonces
}

export interface ReadErrResult {
  Err: string;
}

export type ReadResult = ReadOkResult | ReadErrResult;

/**
 * Per-step result returned by `POST /devtools/v2/simulations/{id}` (the
 * "submit steps" endpoint). Mirrors the rust `RunSimulationStepResult`
 * enum — externally tagged, exactly one variant key present.
 *
 * Distinct from `SimulationStepSummary`, which is what
 * `GET /devtools/v2/simulations/{id}` returns and includes the original
 * step input alongside the result.
 */
export type SimulationStepResult =
  | { Transaction: TransactionOkResult | TransactionErrResult }
  | { Eval: { Ok: string } | { Err: string } }
  | { SetContractCode: { Ok: null } | { Err: string } }
  | { Reads: ReadResult[] }
  | { TenureExtend: ExecutionCost };

// Simulation step types (summary format from GET /devtools/v2/simulations/{id})
export interface TransactionStepSummary {
  /** Transaction serialized to hex. */
  Transaction: string;
  /** Hex-encoded txid. Empty string `""` when the tx failed engine-level. */
  TxId: string;
  Result: {
    Transaction: TransactionOkResult | TransactionErrResult;
  };
  ExecutionCost: ExecutionCost;
}

export interface ReadsStepSummary {
  Reads: ReadStep[];
  Result: {
    Reads: ReadResult[];
  };
}

export interface SetContractCodeStepSummary {
  SetContractCode: [contract_id: string, code: string, clarity_version: number];
  Result: {
    SetContractCode: { Ok: null } | { Err: string };
  };
}

export interface EvalStepSummary {
  /** `sponsor` is `""` (empty string) when there is no sponsor. */
  Eval: [sender: string, sponsor: string, contract_id: string, code: string];
  Result: {
    Eval: { Ok: string } | { Err: string };
  };
}

export interface TenureExtendStepSummary {
  Result: {
    TenureExtend: ExecutionCost;
  };
}

export type SimulationStepSummary =
  | TransactionStepSummary
  | ReadsStepSummary
  | SetContractCodeStepSummary
  | EvalStepSummary
  | TenureExtendStepSummary;

// Simulation metadata
export interface SimulationMetadata {
  ast_rules: 0 | 1;
  block_height: number;
  block_hash: string;
  burn_block_height: number;
  burn_block_hash: string;
  consensus_hash: string;
  epoch: string;
  index_block_hash: string;
  skip_tracing: boolean;
  sortition_id: string;
}

// Full simulation result
export interface SimulationResult {
  metadata: SimulationMetadata;
  steps: SimulationStepSummary[];
}

// Create session request
export interface CreateSimulationRequest {
  block_height?: number;
  block_hash?: string;
  skip_tracing?: boolean;
}

export interface CreateSimulationResponse {
  id: string;
}

// Submit steps request
export type SimulationStepInput =
  | { Transaction: string }
  | {
      /** `sponsor` is `""` when there is no sponsor. */
      Eval: [
        sender: string,
        sponsor: string,
        contract_id: string,
        code: string,
      ];
    }
  | {
      SetContractCode: [
        contract_id: string,
        code: string,
        clarity_version: number,
      ];
    }
  | { Reads: ReadStep[] }
  | { TenureExtend: [] };

export interface SubmitSimulationStepsRequest {
  steps: SimulationStepInput[];
}

export interface SubmitSimulationStepsResponse {
  steps: SimulationStepResult[];
}

// Batch reads from simulation
export interface SimulationBatchReadsRequest {
  /** `[contract_id, variable_name]` per entry. */
  vars?: [contract_id: string, variable_name: string][];
  /** `[contract_id, map_name, key_hex]` per entry. */
  maps?: [contract_id: string, map_name: string, key_hex: string][];
  /**
   * `[contract_id, function_name, ...arg_hex]` per entry. The first two
   * positions are fixed; remaining elements are hex-encoded Clarity
   * values, one per function argument (so the length matches the
   * function's arity, not arbitrary).
   */
  readonly?: [
    contract_id: string,
    function_name: string,
    ...args_hex: string[],
  ][];
  /**
   * `[sender, sponsor, contract_id, function_name, ...arg_hex]` per
   * entry. The first four positions are fixed (`sponsor` is `""` when
   * there is no sponsor); remaining elements are hex-encoded Clarity
   * values, one per function argument.
   */
  readonly_with_sender?: [
    sender: string,
    sponsor: string,
    contract_id: string,
    function_name: string,
    ...args_hex: string[],
  ][];
  /** Principals to read STX balances for. */
  stx?: string[];
  /** Principals to read nonces for. */
  nonces?: string[];
  /** `[<contract_id>::<token_name>, principal]` per entry. */
  ft_balance?: [token_identifier: string, principal: string][];
  /**
   * Flat array of FT identifiers in `<contract_id>::<token_name>` form,
   * one entry per token to look up. Any length.
   */
  ft_supply?: string[];
}

/**
 * Each category is omitted from the JSON response when the corresponding
 * request field was empty/absent (rust uses
 * `serde(skip_serializing_if = "Vec::is_empty")` per field).
 */
export interface SimulationBatchReadsResponse {
  vars?: ReadResult[];
  maps?: ReadResult[];
  readonly?: ReadResult[];
  readonly_with_sender?: ReadResult[];
  stx?: ReadResult[];
  nonces?: ReadResult[];
  ft_balance?: ReadResult[];
  ft_supply?: ReadResult[];
}

// Instant simulation
export interface InstantSimulationRequest {
  /** Transaction serialized to hex. */
  transaction: string;
  block_height?: number;
  block_hash?: string;
  reads?: ReadStep[];
}

export interface InstantSimulationResponse {
  /** Always present (may be `[]`). Aligned positionally with the request `reads`. */
  reads: ReadResult[];
  receipt: TransactionReceipt;
}
