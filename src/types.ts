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

export interface TransactionReceipt {
  result: string;
  stx_burned: number;
  tx_index: number;
  vm_error: string | null;
  post_condition_aborted: boolean;
  costs: number;
  execution_cost: ExecutionCost;
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
  MapEntry: [string, string, string]; // [contract_id, map_name, key_hex]
}

export interface DataVarStep {
  DataVar: [string, string]; // [contract_id, variable_name]
}

export interface EvalReadonlyStep {
  EvalReadonly: [string, string, string, string]; // [sender, sponsor, contract_id, code]
}

export interface StxBalanceStep {
  StxBalance: string; // principal
}

export interface FtBalanceStep {
  FtBalance: [string, string, string]; // [contract_id, token_name, principal]
}

export interface FtSupplyStep {
  FtSupply: [string, string]; // [contract_id, token_name]
}

export interface NonceStep {
  Nonce: string; // principal
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

// Simulation step types (summary format from GET /devtools/v2/simulations/{id})
export interface TransactionStepSummary {
  Transaction: string; // tx hex
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
  SetContractCode: [string, string, number]; // [contract_id, code, clarity_version]
  Result: {
    SetContractCode: { Ok: null } | { Err: string };
  };
}

export interface EvalStepSummary {
  Eval: [string, string, string, string]; // [sender, sponsor, contract_id, code]
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
  | { Transaction: string } // tx hex
  | { Eval: [string, string, string, string] } // [sender, sponsor, contract_id, code]
  | { SetContractCode: [string, string, number] } // [contract_id, code, clarity_version]
  | { Reads: ReadStep[] }
  | { TenureExtend: [] };

export interface SubmitSimulationStepsRequest {
  steps: SimulationStepInput[];
}

export type SubmitSimulationStepsResponse = SimulationStepSummary[];

// Batch reads from simulation
export interface SimulationBatchReadsRequest {
  vars?: [string, string][]; // [contract_id, variable_name]
  maps?: [string, string, string][]; // [contract_id, map_name, key_hex]
  readonly?: Array<string | [string, string, string, string]>; // [contract_id, function_name, ...args]
  readonly_with_sender?: Array<
    // [sender, sponsor, contract_id, function_name, ...args]
    [string, string, string, string, ...string[]]
  >;
  stx?: string[]; // principals
  nonces?: string[]; // principals
  ft_balance?: [string, string][]; // [token_identifier, principal]
  ft_supply?: [string, string][]; // [token_identifier, token_identifier]
}

export interface SimulationBatchReadsResponse {
  vars: ReadResult[];
  maps: ReadResult[];
  readonly: ReadResult[];
  readonly_with_sender: ReadResult[];
  stx: ReadResult[];
  nonces: ReadResult[];
  ft_balance: ReadResult[];
  ft_supply: ReadResult[];
}

// Instant simulation
export interface InstantSimulationRequest {
  transaction: string; // tx hex
  block_height?: number;
  block_hash?: string;
  reads?: ReadStep[];
}

export interface InstantSimulationResponse {
  reads?: ReadResult[];
  receipt: TransactionReceipt;
}
