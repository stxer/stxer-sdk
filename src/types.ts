/**
 * Type definitions for stxer-api V2 endpoints
 * Hand-written types based on OpenAPI spec at https://api.stxer.xyz/openapi.json
 */

// =============================================================================
// Sidecar Tip Types
// =============================================================================

/**
 * Rust `u64` / `u128` fields serialize as JSON numbers but can exceed JS
 * `Number.MAX_SAFE_INTEGER` (2^53 - 1). Accept either form: numbers are
 * convenient for small values, decimal strings preserve full precision
 * for large ones. Mirrors how `pox_addrs[k].payout` (u128) is typed.
 *
 * In practice nearly all values fit in `Number` — this typing exists so
 * code that *might* see a large value (post-genesis cumulative cost
 * counters, accumulated stx_burned in long simulations) cannot silently
 * lose precision. Use `BigInt(x)` to normalize before arithmetic when in
 * doubt.
 */
export type U64 = number | string;
/** Rust `u128`. See {@link U64} for usage notes. */
export type U128 = number | string;

export interface TenureCost {
  read_count: U64;
  read_length: U64;
  write_count: U64;
  write_length: U64;
  runtime: U64;
}

export interface SidecarTip {
  bitcoin_height: number;
  block_hash: string;
  block_height: U64;
  block_time: U64;
  burn_block_height: number;
  burn_block_time: U64;
  consensus_hash: string;
  index_block_hash: string;
  is_nakamoto: boolean;
  tenure_cost: TenureCost;
  tenure_height: U64;
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

/**
 * Wire-format Clarity version name as emitted by the stxer AST parser
 * (`/contracts:parse-ast`). Used in {@link ClarityAbi.clarity_version}.
 *
 * **Distinct from the numeric `ClarityVersion` enum re-exported by
 * `@stacks/transactions`** (1..5), which is what the SDK builder
 * methods (`addContractDeploy`, `makeUnsignedContractDeploy`, etc.)
 * accept. To build transactions:
 *
 *     import { ClarityVersion } from '@stacks/transactions';
 *     // ClarityVersion.Clarity5 -> 5
 *
 * To check an AST response:
 *
 *     import type { ClarityVersionName } from 'stxer';
 *     if (abi.clarity_version === 'Clarity5') { ... }
 */
export type ClarityVersionName =
  | 'Clarity1'
  | 'Clarity2'
  | 'Clarity3'
  | 'Clarity4'
  | 'Clarity5';

/** @deprecated Renamed to {@link ClarityVersionName} in 0.8.0 to avoid collision with `@stacks/transactions`'s numeric `ClarityVersion` enum. Re-exported for back-compat — will be removed in a future major. */
export type ClarityVersion = ClarityVersionName;

export interface ClarityAbi {
  functions: ClarityAbiFunction[];
  variables: ClarityAbiVariable[];
  maps: ClarityAbiMap[];
  fungible_tokens: ClarityAbiFungibleToken[];
  non_fungible_tokens: ClarityAbiNonFungibleToken[];
  epoch: ClarityEpoch;
  clarity_version: ClarityVersionName;
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
  read_count: U64;
  read_length: U64;
  write_count: U64;
  write_length: U64;
  runtime: U64;
}

/**
 * Receipt for a transaction that the engine executed to completion.
 *
 * "Successful execution" does NOT imply contract-level success. Four
 * failure signals to check, in this order:
 *   1. Outer `Err` on `Result.Transaction` — engine could not run the tx
 *      at all (deserialization failure etc.); no receipt is produced.
 *   2. `post_condition_aborted: true` — execution ran, post-condition
 *      tripped, state was rolled back.
 *   3. `vm_error: string` (without `post_condition_aborted`) — Clarity
 *      VM raised a runtime error or static analysis failed.
 *   4. `(err uX)` inside `result` — contract returned a Clarity error
 *      response. Application-level; NOT signalled by any field above.
 *      Decode `result` to detect.
 *
 * `post_condition_aborted` and `vm_error` are NOT independent: when a
 * PC trips the upstream sets `post_condition_aborted: true` AND writes
 * the PC abort reason into `vm_error` as a side effect. The reverse is
 * not true — `vm_error` alone (with `post_condition_aborted: false`)
 * means a VM / analysis failure that is not a PC abort.
 */
export interface TransactionReceipt {
  /**
   * Clarity return value, SIP-005 hex-serialized. For contract-call txs
   * this includes the `(ok ...)` / `(err ...)` response wrapper —
   * Clarity-level `(err uX)` lives here, NOT on `vm_error` or the outer
   * `Err`.
   */
  result: string;
  /**
   * STX (in micro-STX) burned by this transaction. u128 — accept as
   * `number | string` to preserve precision above 2^53.
   */
  stx_burned: U128;
  tx_index: number;
  /**
   * Error message from the upstream Clarity VM. `null` when the tx had
   * no VM-level issue. When `post_condition_aborted` is `true` this
   * field is also populated with the PC abort reason — check
   * `post_condition_aborted` first to disambiguate.
   */
  vm_error: string | null;
  /**
   * `true` when one or more post-conditions failed and the tx was
   * aborted. Implies `vm_error` is also set (to the abort reason); the
   * reverse does not hold.
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
   *
   * For typed access, use {@link parseSimulationEvent} or cast:
   *   `JSON.parse(events[i]) as SimulationEvent`.
   */
  events: string[];
}

export interface TransactionOkResult {
  Ok: TransactionReceipt;
}

export interface TransactionErrResult {
  Err: string;
}

// =============================================================================
// Simulation Events
// =============================================================================
// Wire format for entries inside `TransactionReceipt.events[]` (each entry
// there is a JSON-encoded string carrying one of these payloads).
//
// Source of truth: `clarity/src/vm/events.rs` in
// https://github.com/stacks-network/stacks-core —
// `StacksTransactionEvent::json_serialize`. These types intentionally
// differ from `@stacks/stacks-blockchain-api-types.TransactionEvent`,
// which describes Hiro API responses with a different envelope.
//
// Numeric fields that the rust source emits via `format!("{}", u128)` /
// `format!("{}", u64)` are typed as `string`, not `number` — the wire
// carries them as decimal strings to preserve full precision.

/** Common envelope present on every event variant. */
interface SimulationEventBase {
  /** Hex txid with leading `0x`. */
  txid: string;
  event_index: number;
  /**
   * `true` when the event was emitted from successfully committed code.
   * `false` when the tx was rolled back (post-condition abort, vm_error).
   * Tracks rust `tx_receipt.vm_error.is_none() && !post_condition_aborted`.
   */
  committed: boolean;
}

/** Payload for `print` events and other contract-emitted events. */
export interface SmartContractEventData {
  /** `<address>.<contract_name>` of the contract that emitted the event. */
  contract_identifier: string;
  /** Topic key — `"print"` for `(print …)` calls. */
  topic: string;
  /**
   * Structured Clarity Value JSON (the rust `Value` enum's serde output).
   * The shape is complex and varies by Clarity type; prefer `raw_value`
   * for typed decoding.
   */
  value: unknown;
  /**
   * SIP-005 hex of the value, with leading `0x`. Pass to
   * `deserializeCV()` from `@stacks/transactions` for typed decoding.
   */
  raw_value: string;
}

export interface StxTransferEventData {
  sender: string;
  recipient: string;
  /** uSTX amount as a decimal string (rust serializes u128 via Display). */
  amount: string;
  /** Hex memo, possibly empty. */
  memo: string;
}

export interface StxMintEventData {
  recipient: string;
  amount: string;
}

export interface StxBurnEventData {
  sender: string;
  amount: string;
}

export interface StxLockEventData {
  locked_amount: string;
  /** Decimal string (rust serializes u64 via Display). */
  unlock_height: string;
  locked_address: string;
  contract_identifier: string;
}

export interface NftTransferEventData {
  /** `<contract_id>::<asset_name>`. */
  asset_identifier: string;
  sender: string;
  recipient: string;
  value: unknown;
  raw_value: string;
}

export interface NftMintEventData {
  asset_identifier: string;
  recipient: string;
  value: unknown;
  raw_value: string;
}

export interface NftBurnEventData {
  asset_identifier: string;
  sender: string;
  value: unknown;
  raw_value: string;
}

export interface FtTransferEventData {
  asset_identifier: string;
  sender: string;
  recipient: string;
  amount: string;
}

export interface FtMintEventData {
  asset_identifier: string;
  recipient: string;
  amount: string;
}

export interface FtBurnEventData {
  asset_identifier: string;
  sender: string;
  amount: string;
}

/**
 * Discriminated union of every event variant the simulator emits.
 * The `type` discriminator names the per-variant payload key — e.g.
 * `type: 'contract_event'` carries the payload at `event.contract_event`.
 *
 * ```ts
 * const event = parseSimulationEvent(receipt.events[0]);
 * if (event.type === 'contract_event') {
 *   // event.contract_event.{contract_identifier, topic, raw_value, value}
 * }
 * ```
 */
export type SimulationEvent =
  | (SimulationEventBase & {
      type: 'contract_event';
      contract_event: SmartContractEventData;
    })
  | (SimulationEventBase & {
      type: 'stx_transfer_event';
      stx_transfer_event: StxTransferEventData;
    })
  | (SimulationEventBase & {
      type: 'stx_mint_event';
      stx_mint_event: StxMintEventData;
    })
  | (SimulationEventBase & {
      type: 'stx_burn_event';
      stx_burn_event: StxBurnEventData;
    })
  | (SimulationEventBase & {
      type: 'stx_lock_event';
      stx_lock_event: StxLockEventData;
    })
  | (SimulationEventBase & {
      type: 'nft_transfer_event';
      nft_transfer_event: NftTransferEventData;
    })
  | (SimulationEventBase & {
      type: 'nft_mint_event';
      nft_mint_event: NftMintEventData;
    })
  | (SimulationEventBase & {
      type: 'nft_burn_event';
      nft_burn_event: NftBurnEventData;
    })
  | (SimulationEventBase & {
      type: 'ft_transfer_event';
      ft_transfer_event: FtTransferEventData;
    })
  | (SimulationEventBase & {
      type: 'ft_mint_event';
      ft_mint_event: FtMintEventData;
    })
  | (SimulationEventBase & {
      type: 'ft_burn_event';
      ft_burn_event: FtBurnEventData;
    });

/** Convenience parser for `TransactionReceipt.events[i]`. */
export function parseSimulationEvent(raw: string): SimulationEvent {
  return JSON.parse(raw) as SimulationEvent;
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
 * Tenure-extend cause. `Extended` resets all cost dimensions; the
 * SIP-034 variants reset a single dimension only.
 */
export type TenureExtendCause =
  | 'Extended'
  | 'ExtendedRuntime'
  | 'ExtendedReadCount'
  | 'ExtendedReadLength'
  | 'ExtendedWriteCount'
  | 'ExtendedWriteLength';

/** PoX address used inside `AdvanceBlocksRequest.pox_addrs`. */
export interface PoxAddrInput {
  /** Address version byte (0..255). */
  version: number;
  /** Address hashbytes as hex (no `0x` prefix). */
  hashbytes: string;
}

/**
 * Request payload for the `AdvanceBlocks` step variant. Synthesizes
 * bitcoin and stacks blocks on top of the simulation's pinned parent
 * tip. Hex strings for 32-byte hashes / VRF seeds; PoX address
 * overrides use the tuple form `[addrs, payout_ustx]` on the wire.
 */
export interface AdvanceBlocksRequest {
  bitcoin_blocks: number;
  stacks_blocks_per_bitcoin: number;
  /** Defaults to 600 (mainnet target) upstream when omitted. */
  bitcoin_interval_secs?: U64;
  /**
   * Per-burn-index burn-header-hash overrides, keyed by 0-based burn
   * index within this batch. Hex strings (32 bytes, with or without
   * `0x` prefix).
   */
  burn_header_hashes?: Record<string, string>;
  /**
   * Per-burn-index PoX address overrides as `[addrs, payout_ustx]`.
   * `payout_ustx` is `u128` upstream — see {@link U128}.
   */
  pox_addrs?: Record<string, [PoxAddrInput[], U128]>;
  /** Per-burn-index VRF-seed overrides as 32-byte hex strings. */
  vrf_seeds?: Record<string, string>;
}

/**
 * One synthesized block produced by an `AdvanceBlocks` step. Returned
 * inside `SimulationStepResult.AdvanceBlocks.Ok` and as the `tip`
 * fields when synthetic.
 */
export interface AdvancedBlockSummary {
  stacks_height: U64;
  burn_height: number;
  coinbase_height: number;
  index_block_hash: string;
  burn_header_hash: string;
  vrf_seed: string;
  block_time: U64;
  burn_block_time: U64;
  /**
   * `true` when this synthetic block is the first stacks block in a
   * new tenure (i.e. follows a synthesized bitcoin block).
   */
  tenure_change: boolean;
}

/**
 * Response shape for `GET /devtools/v2/simulations/{id}/tip`. When
 * `synthetic` is `false`, fields mirror the parent metadata pinned at
 * session start; `vrf_seed` and `tenure_change` are omitted in that
 * case.
 */
export interface SimulationTipResponse {
  synthetic: boolean;
  stacks_height: U64;
  burn_height: number;
  coinbase_height: number;
  block_time: U64;
  burn_block_time: U64;
  index_block_hash: string;
  consensus_hash: string;
  burn_header_hash: string;
  sortition_id: string;
  epoch: string;
  /** Only present when `synthetic` is `true`. */
  vrf_seed?: string;
  /** Only present when `synthetic` is `true`. */
  tenure_change?: boolean;
}

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
  | { TenureExtend: ExecutionCost }
  | {
      AdvanceBlocks: { Ok: AdvancedBlockSummary[] } | { Err: string };
    };

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

/**
 * Echoed `AdvanceBlocks` input as serialized in the summary response.
 * Differs from the request shape ({@link AdvanceBlocksRequest}) in two
 * places: `bitcoin_interval_secs` is nullable (serde `Option`); each
 * `pox_addrs` value is the `{addrs, payout}` object form (vs. the
 * request's tuple form).
 */
export interface AdvanceBlocksStepEcho {
  bitcoin_blocks: number;
  stacks_blocks_per_bitcoin: number;
  bitcoin_interval_secs: U64 | null;
  burn_header_hashes: Record<string, string>;
  pox_addrs: Record<string, { addrs: PoxAddrInput[]; payout: U128 }>;
  vrf_seeds: Record<string, string>;
}

export interface TenureExtendStepSummary {
  /**
   * Echoed input shape. The server normalizes legacy `{TenureExtend: []}`
   * inputs to `{cause: 'Extended'}` at parse time, so the summary always
   * carries the modern form regardless of how the step was submitted.
   */
  TenureExtend: { cause: TenureExtendCause };
  Result: {
    TenureExtend: ExecutionCost;
  };
}

export interface AdvanceBlocksStepSummary {
  AdvanceBlocks: AdvanceBlocksStepEcho;
  Result: {
    AdvanceBlocks: { Ok: AdvancedBlockSummary[] } | { Err: string };
  };
}

export type SimulationStepSummary =
  | TransactionStepSummary
  | ReadsStepSummary
  | SetContractCodeStepSummary
  | EvalStepSummary
  | TenureExtendStepSummary
  | AdvanceBlocksStepSummary;

// Simulation metadata
export interface SimulationMetadata {
  block_height: U64;
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
  block_height?: U64;
  block_hash?: string;
  skip_tracing?: boolean;
}

export interface CreateSimulationResponse {
  id: string;
}

// Submit steps request
//
// `TenureExtend` accepts both legacy `[]` (treated server-side as
// `cause: 'Extended'`) and modern `{ cause }` shapes. SDK 0.8.0 emits
// the modern form via {@link SimulationBuilder.addTenureExtend}; the
// legacy shape stays in this union so consumers passing literal step
// objects (not via the builder) still type-check.
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
  | { TenureExtend: [] | { cause: TenureExtendCause } }
  | { AdvanceBlocks: AdvanceBlocksRequest };

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
  block_height?: U64;
  block_hash?: string;
  reads?: ReadStep[];
}

export interface InstantSimulationResponse {
  /** Always present (may be `[]`). Aligned positionally with the request `reads`. */
  reads: ReadResult[];
  receipt: TransactionReceipt;
}
