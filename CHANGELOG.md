# Changelog

All notable changes to the `stxer` SDK are documented here. The format
loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning is [SemVer](https://semver.org/).

## 0.8.0

Pairs with **stxer-api ≥ schema-v2** (the simulator build that ships
`AdvanceBlocks` + `/tip` + the typed 409 / 410 status codes). Older
deployments respond `404` for `getSimulationTip` and reject
`AdvanceBlocks` step variants.

### Added

- **`addAdvanceBlocks(request)` on `SimulationBuilder`** plus the
  `{ AdvanceBlocks: AdvanceBlocksRequest }` variant on
  `SimulationStepInput`. Synthesizes bitcoin / stacks blocks on top of
  the simulation's pinned parent tip — used to model burn-block /
  tenure boundaries (PoX cycles, locked-STX unlock, time-locked
  redemptions, bridge contract finalization). See the
  [`AdvanceBlocks` section in the README](./README.md#advanceblocks-burn-block-scenarios)
  and the worked examples under `src/sample/`.
- **`getSimulationTip(sessionId, options?)`** — reads the current tip
  of a simulation session. Returns the latest synthetic tip when at
  least one `AdvanceBlocks` step has run (`synthetic: true`, includes
  `vrf_seed` and `tenure_change`); otherwise returns the parent
  metadata pinned at session start.
- **Typed `SimulationError`** thrown by every `simulation-api.ts`
  fetch wrapper. Carries `.status` (HTTP code), `.marker` (typed
  `'simulation_busy' | 'simulation_outdated' | null`), and `.body`
  (raw upstream message). Branch on `.marker` to distinguish a
  retry-the-same-request 409 from a start-a-new-session 410. Pre-0.8.0
  threw plain `Error`; the message format
  (`${operation} (HTTP ${status}): ${body}`) is preserved so log
  scrapers keep working.
- **`src/sim-helpers.ts`** — session-bound wrappers: `callContract`,
  `getStxBalance`, `getFtBalance`, `getNonce`, `readDataVar`. Uses
  `simulationBatchReads` underneath so demos can lean on typed reads
  without hand-rolling the batch envelope.
- **`src/transaction.ts`** — `setSender`, `buildUnsignedContractCallHex`,
  `ftPrincipal`, `ContractCallTxArgs`. Extracted from `simulation.ts`
  and the old `sample/_helpers.ts` so consumers can build unsigned tx
  hex without instantiating `SimulationBuilder`.
- **`src/bitcoin.ts`** — SPV / merkle-proof / forged-tx primitives used
  by the bridge demos: `sha256`, `sha256d`, `hexToBytes`, `bytesToHex`,
  `p2wpkhScript`, `p2pkhScript`, `opReturnScript`, `forgeBitcoinTx`,
  `buildBitcoinHeader`, `singleTxMerkleRoot`, `merkleProof`,
  `verifyMerkleProof`. Pairs with `addAdvanceBlocks`'
  `burn_header_hashes` override for sBTC / Brotocol bridge scenarios.
- **`addTenureExtend(cause?)`** now accepts an optional
  `TenureExtendCause` (`'Extended' | 'ExtendedRuntime' | ...`) so
  callers can reset a single SIP-034 cost dimension.
- **Six new vitest demos** under `src/sample/*-vitest.test.ts`:
  `locked-stx`, `sbtc-deposit`, `brotocol-pegin`, `hbtc-vault`,
  `zest-borrow`, `granite-leverage`. **The `src/sample` directory is
  intentionally excluded from the npm tarball** to keep package size
  down — browse them on
  [GitHub](https://github.com/stxer/stxer-sdk/tree/master/src/sample).

### Changed (breaking)

- **`addTenureExtend()` zero-arg now emits the modern wire shape**
  (`{ TenureExtend: { cause: 'Extended' } }`) instead of the legacy
  `{ TenureExtend: [] }`. The TypeScript signature is back-compat —
  zero-arg call sites keep compiling — but anyone snapshotting JSON
  request bodies will see the new shape. The server still parses the
  legacy `[]` form for raw consumers.
- **`SimulationStepResult.TenureExtend` summaries always carry
  `{ cause }`.** Previously typed as `[] | { cause }`; the server
  normalizes legacy `[]` inputs to `{ cause: 'Extended' }` at parse
  time, so the summary echo can never carry `[]`. The narrower type
  is now reflected on `TenureExtendStepSummary.TenureExtend`.
- **HTTP responses now propagate as 4xx where they used to be masked
  as 200.** The stxer-api proxy was forwarding upstream
  `simulation_busy:` / `simulation_outdated:` / 4xx bodies with status
  200; the proxy now forwards the upstream status verbatim. SDK
  callers are unaffected (the fetch wrappers already threw on `!ok`),
  but raw-curl consumers reading 200 as success will now see
  exceptions on those paths. The body content is unchanged.
- **`BatchReadsResult.tip` renamed to `BatchReadsResult.index_block_hash`**
  to match the wire field name.
- **Numeric u64 / u128 fields are typed as `U64` / `U128`** (`number |
  string`) instead of plain `number` to avoid silent precision loss
  above 2^53. Affected fields: `TransactionReceipt.stx_burned`
  (u128), `ExecutionCost.{read_count,read_length,write_count,
  write_length,runtime}` (u64), `AdvancedBlockSummary.{stacks_height,
  block_time,burn_block_time}` (u64), `SimulationTipResponse.
  {stacks_height,block_time,burn_block_time}` (u64),
  `SimulationMetadata.block_height` (u64), `SidecarTip.
  {block_height,block_time,burn_block_time,tenure_height}` (u64),
  `TenureCost.*` (u64), `AdvanceBlocksRequest.bitcoin_interval_secs`
  and `AdvanceBlocksStepEcho.bitcoin_interval_secs` (u64),
  `CreateSimulationRequest.block_height` /
  `InstantSimulationRequest.block_height` (u64). Use `BigInt(x)` to
  normalize before arithmetic.
- **`ClarityVersion` (the SDK string-literal type) renamed to
  `ClarityVersionName`** to disambiguate from the numeric enum
  re-exported by `@stacks/transactions`. The old name is preserved as
  a deprecated alias for one major; use `ClarityVersionName` for
  `ClarityAbi.clarity_version` matches and `@stacks/transactions`'s
  numeric `ClarityVersion` enum (`ClarityVersion.Clarity4` → `4`) for
  builder calls.

### Server-side note

This release is paired with a server-side schema bump (`v=2`).
Simulation sessions created against an older simulator are rejected
with **HTTP 410 `simulation_outdated:`** after the cutover; SDK callers
see this as `SimulationError` with `marker: 'simulation_outdated'` and
should start a new session. Sim ids are random per-session and never
expected to persist across releases by design.

## 0.7.0

See `git log` for prior releases. 0.7.0 was the last release without
`AdvanceBlocks` / `getSimulationTip` and treated all upstream errors as
plain `Error`.
