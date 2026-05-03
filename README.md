# STXER SDK

A powerful SDK for Stacks blockchain that provides transaction simulation, batch operations, contract AST parsing, and chain tip information.

Pairs with the [stxer-api](https://api.stxer.xyz) (mainnet) and
[testnet-api](https://testnet-api.stxer.xyz). See
[`CHANGELOG.md`](./CHANGELOG.md) for release notes.

## Installation

```bash
npm install stxer
# or
yarn add stxer
```

## When to use what

Pick the right tool for the task — these are not interchangeable:

| Goal | Use |
|---|---|
| Wallet preview / pre-broadcast safety check (single tx, no session, **no debug tracing**) | [`instantSimulation`](#instant-simulation) |
| Quick scripted multi-step simulation, browsable in the [stxer debug UI](https://stxer.xyz) | [`SimulationBuilder`](#1-transaction-simulation-v2-api) |
| CI / Vitest contract test with custom assertions on per-step results | [`createSimulationSession`](#session-based-simulation) + [`submitSimulationSteps`](#session-based-simulation) + [`sim-helpers`](#sim-helpers-callcontract-getstxbalance-getftbalance-getnonce-readdatavar) |
| Burn-block / tenure scenarios (PoX cycles, locked-STX unlock, time-locked redemptions) | [`addAdvanceBlocks`](#advanceblocks-burn-block-scenarios) + [`getSimulationTip`](#advanceblocks-burn-block-scenarios) |
| Bridge / SPV peg-in (sBTC, Brotocol) | raw API + [`bitcoin.ts`](#bitcoin-spv--bridge-primitives) + [`transaction.ts`](#transaction-builders) — see the bridge demos in [`src/sample`](https://github.com/stxer/stxer-sdk/tree/master/src/sample) |
| Bulk read against current chain state | [`batchRead`](#batch-operations) (sidecar) or [`simulationBatchReads`](#session-based-simulation) (against a session's forked state) |
| Read-only contract calls with ABI decoding | [`callReadonly`](#clarity-api) / [`readVariable`](#clarity-api) / [`readMap`](#clarity-api) |

`instantSimulation` is intentionally transient — it has **no debug
tracing** and the simulation isn't viewable in the stxer UI. Use
sessions when you need either of those.

The bridge / `AdvanceBlocks` patterns deliberately bypass
`SimulationBuilder` because they need typed access to per-step results
(builder only returns the final `simulation_id`). The decision table
above is the canonical mapping; the in-tree bridge vitest demos are
the canonical worked examples.

## Features

### 1. Transaction Simulation (V2 API)

Simulate complex transaction sequences before executing them on-chain. The SDK supports all V2 step types:

#### Basic Simulation

```typescript
import { SimulationBuilder } from 'stxer';

const simulationId = await SimulationBuilder.new({
  network: 'mainnet', // or 'testnet'
  skipTracing: false, // Set to true for faster simulations without debug info
})
  .useBlockHeight(130818) // Optional: use specific block height
  .withSender('SP...') // Set default sender
  .addContractCall({
    contract_id: 'SP...contract-name',
    function_name: 'my-function',
    function_args: [/* clarity values */],
    sender: 'SP...', // Optional: overrides default sender
    fee: 100, // Optional: fee in microSTX
  })
  .addSTXTransfer({
    recipient: 'SP...',
    amount: 1000000, // in microSTX
  })
  .addContractDeploy({
    contract_name: 'my-contract',
    source_code: '(define-public (hello) (ok "world"))',
    deployer: 'SP...', // Optional: overrides default sender
    clarity_version: 4, // 1 / 2 / 3 / 4 — or `ClarityVersion.Clarity4` from `@stacks/transactions`
  })
  .run();

// View simulation results at: https://stxer.xyz/simulations/mainnet/{simulationId}
```

#### Advanced V2 Step Types

The SDK supports all V2 simulation step types. Three of them — `Transaction`, `Eval`, and `EvalReadonly` (a `Reads` sub-type) — all execute Clarity but differ on side-effects, cost, and what they emit. Pick by **what you need to come out of the step**:

| Step | Side effects | Receipt + events | Fee / nonce | Post-conditions | When to use |
|---|---|---|---|---|---|
| `Transaction` | full tx execution | ✅ `TransactionReceipt` | ✅ | ✅ | Simulating a real user action; need a receipt; want PCs enforced |
| `Eval` | **write access** | ❌ | ❌ | ❌ | Stub state mid-session, run code with side-effects without tx ceremony |
| `EvalReadonly` (in `Reads`) | none — analyzer-enforced read-only | ❌ | ❌ | ❌ | Read-only contract calls / projections / custom expressions that need sender-context |

Cost order, cheapest first: `EvalReadonly` < `Eval` < `Transaction`. Use the cheapest variant that gives you what you need — running a `(var-get counter)` projection through `Eval` is wasteful when an `EvalReadonly` (or a plain `DataVar` read) gets the same answer for less.

```typescript
import { SimulationBuilder } from 'stxer';
import { ClarityVersion } from '@stacks/transactions';

const simulationId = await SimulationBuilder.new()
  .withSender('SP...')

  // === Transaction Steps ===
  // STX Transfer
  .addSTXTransfer({ recipient: 'SP...', amount: 1000 })

  // Contract Call
  .addContractCall({
    contract_id: 'SP...contract',
    function_name: 'my-function',
    function_args: [boolCV(true), uintCV(123)],
  })

  // Contract Deploy
  .addContractDeploy({
    contract_name: 'my-contract',
    source_code: '(define-data-var counter uint u0)',
    clarity_version: ClarityVersion.Clarity4,
  })

  // === Eval Step (write access, no tx ceremony) ===
  // Use Eval when you need to mutate contract state WITHOUT a real tx —
  // no fee, no nonce, no post-conditions, no receipt; just the Clarity
  // value or err. For pure reads, prefer the `Reads` batch below
  // (`EvalReadonly` is cheaper and analyzer-enforced read-only).
  .addEvalCode('SP...contract', '(var-set counter u100)')

  // === SetContractCode Step ===
  // Directly set contract code without a transaction
  .addSetContractCode({
    contract_id: 'SP...contract',
    source_code: '(define-data-var enabled bool false)',
    clarity_version: ClarityVersion.Clarity4,
  })

  // === Reads Batch Step ===
  // Batch multiple read operations into one step. `EvalReadonly` is the
  // sender-context read variant — analyzer-enforced no writes; use it
  // for read-only contract calls / projections / custom expressions
  // that need a specific sender principal in scope.
  .addReads([
    { DataVar: ['SP...contract', 'counter'] },
    { DataVar: ['SP...contract', 'enabled'] },
    { StxBalance: 'SP...' },
    { Nonce: 'SP...' },
    { EvalReadonly: ['SP...', '', 'SP...contract', '(get-counter)'] },
    {
      EvalReadonly: [
        'SP...',
        '',
        'SP...oracle',
        "(contract-call? .oracle get-value 'STX-USD)",
      ],
    },
  ])

  // === TenureExtend Step ===
  // Extend tenure (resets execution cost). Defaults to 'Extended'
  // (full reset); pass a SIP-034 cause to reset only one dimension.
  .addTenureExtend('ExtendedRuntime')

  // === AdvanceBlocks Step ===
  // Synthesize bitcoin and stacks blocks on top of the pinned parent
  // tip — used to model burn-block / tenure boundaries (bridge
  // contracts, time-locked redemptions, locked-STX unlock).
  .addAdvanceBlocks({ bitcoin_blocks: 1, stacks_blocks_per_bitcoin: 1 })

  .run();
```

#### Schema cutover (v0.8.0)

The 0.8.0 release coincides with a server-side schema bump for
simulation sessions. **Existing simulation session ids started before
the upgrade return `HTTP 410 Gone`** — start a fresh session via
`SimulationBuilder.run()` / `createSimulationSession()` to get a
schema-v=2 id. Sim ids are random per-call and not persisted across
releases by design, so this only affects in-flight callers.

The fetch wrappers in `simulation-api` now throw a typed
`SimulationError` (with `status` and `marker` fields) on non-2xx
responses; `marker` is `'simulation_busy'` (HTTP 409),
`'simulation_outdated'` (HTTP 410), or `null`. Pre-0.8.0 the SDK
threw a plain `Error` whose message embedded the body — message format
is unchanged so existing log scrapers keep working.

`addTenureExtend(cause?)` now accepts an optional `TenureExtendCause`.
The on-the-wire request shape is `{ TenureExtend: { cause } }`; the
legacy `{ TenureExtend: [] }` shape stays parseable on the server but
the SDK builder no longer emits it.

#### Reads Batch Sub-Types

The `Reads` step supports multiple read operation types:

```typescript
.addReads([
  // Read a data variable
  { DataVar: ['SP...contract', 'my-var'] },

  // Read a map entry (key must be hex-encoded Clarity value)
  { MapEntry: ['SP...contract', 'my-map', '0x0...'] },

  // Call a read-only function
  { EvalReadonly: ['SP...', '', 'SP...contract', '(my-function)'] },

  // Read STX balance
  { StxBalance: 'SP...' },

  // Read fungible token balance
  { FtBalance: ['SP...token-contract', 'token-name', 'SP...principal'] },

  // Read fungible token supply
  { FtSupply: ['SP...token-contract', 'token-name'] },

  // Read account nonce
  { Nonce: 'SP...' },
])
```

### 2. Programmatic Simulation APIs

For advanced use cases where you need more control than `SimulationBuilder` provides, the SDK exposes low-level programmatic APIs that directly map to the stxer V2 simulation endpoints.

#### Instant Simulation

Simulate a single transaction without creating a session. Useful for apps/wallets to preview transaction results before sending:

```typescript
import { instantSimulation } from 'stxer';

const result = await instantSimulation({
  transaction: '0x...', // Hex-encoded transaction
  reads: [
    { DataVar: ['SP...contract', 'my-var'] },
    { StxBalance: 'SP...' }
  ]
});

console.log(result.receipt.result); // Transaction result
console.log(result.reads); // Optional read results
```

#### Session-Based Simulation

For more complex scenarios with multiple steps:

```typescript
import {
  createSimulationSession,
  submitSimulationSteps,
  getSimulationResult,
  getSimulationTip,
  simulationBatchReads
} from 'stxer';

// 1. Create a simulation session
const sessionId = await createSimulationSession({
  skip_tracing: false // Set to true for faster simulations
});

// 2. Submit steps to the session
const stepResults = await submitSimulationSteps(sessionId, {
  steps: [
    { Transaction: '0x...' },
    { Eval: ['SP...', '', 'SP...contract', '(var-get my-var)'] },
    { SetContractCode: ['SP...contract', '(define-data-var x uint u0)', 4] },
    { Reads: [
      { DataVar: ['SP...contract', 'my-var'] },
      { StxBalance: 'SP...' }
    ]},
    { TenureExtend: { cause: 'Extended' } },
    { AdvanceBlocks: { bitcoin_blocks: 1, stacks_blocks_per_bitcoin: 1 } }
  ]
});

console.log(`Executed ${stepResults.steps.length} steps`);

// 3. Inspect the current tip — `synthetic` flips to `true` once
//    `AdvanceBlocks` has run; `vrf_seed` and `tenure_change` are
//    populated only on synthetic tips.
const tip = await getSimulationTip(sessionId);
console.log(tip.synthetic, tip.stacks_height, tip.burn_height);

// 4. Get full simulation results
const result = await getSimulationResult(sessionId);
console.log(result.metadata);
console.log(result.steps);

// 5. Batch reads from simulation state
const reads = await simulationBatchReads(sessionId, {
  vars: [['SP...contract', 'my-var']],
  maps: [['SP...contract', 'my-map', '0x...']],
  stx: ['SP...']
});
console.log(reads.vars);
console.log(reads.stx);
```

#### API Options

All programmatic APIs accept an optional `stxerApi` parameter to customize the endpoint:

```typescript
const sessionId = await createSimulationSession(
  { skip_tracing: true },
  { stxerApi: 'https://testnet-api.stxer.xyz' }
);
```

#### TransactionReceipt: failure signals & events

When a step lands as `{ Transaction: { Ok: receipt } }`, the engine ran the transaction to completion — but that does **not** mean the contract logic succeeded. There are four failure signals on or around a receipt; check them in this order:

| Signal | Where | Meaning |
|---|---|---|
| Outer `Err` | `Result.Transaction = { Err: string }` | Engine refused the tx (deserialization, etc.). No receipt is produced. |
| `post_condition_aborted: true` | on the receipt | Execution ran, a post-condition tripped, state was rolled back. |
| `vm_error: string` (without PC abort) | on the receipt | Clarity VM raised a runtime error (overflow, unwrap on `none`, etc.) or static analysis failed. |
| `(err uX)` inside `result` | on the receipt | Contract returned a Clarity error response. Not signalled by any flag — decode `result` to detect (response::err prefix is `08`). |

**`post_condition_aborted` and `vm_error` are not independent.** When a post-condition trips, the upstream sets `post_condition_aborted: true` *and* writes the PC abort reason into `vm_error` as a side effect — so `vm_error` is also non-null in that case. The reverse is not true: `vm_error` alone (with `post_condition_aborted: false`) means a VM/runtime/analysis failure that is *not* a PC abort. A clean way to narrow:

```typescript
if (receipt.post_condition_aborted) {
  // PC abort. receipt.vm_error holds the abort reason.
} else if (receipt.vm_error != null) {
  // Runtime / analysis failure (not a PC abort).
} else if (receipt.result.startsWith('08')) {
  // Contract returned (err uX). Decode receipt.result for the value.
} else {
  // Clean success.
}
```

**Events are JSON-encoded strings, not objects.** `receipt.events` is `string[]`; each entry is a JSON-encoded event payload. Call `JSON.parse(receipt.events[i])` to inspect — iterating without parsing yields opaque strings.

```typescript
for (const ev of receipt.events) {
  const event = JSON.parse(ev) as { type: string; contract_event?: { ... } };
  if (event.type === 'contract_event') { /* handle print/log */ }
}
```

### 3. Get Chain Tip

Fetch the current chain tip information:

```typescript
import { getTip, type SidecarTip } from 'stxer';

const tip: SidecarTip = await getTip();
console.log(`Current block: ${tip.block_height}`);
console.log(`Block hash: ${tip.block_hash}`);
console.log(`Bitcoin height: ${tip.bitcoin_height}`);
console.log(`Tenure cost: ${tip.tenure_cost}`);
```

### 4. Contract AST Operations

Fetch or parse contract Abstract Syntax Trees:

```typescript
import { getContractAST, parseContract } from 'stxer';

// Fetch on-chain contract AST
const ast = await getContractAST({
  contractId: 'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.amm-pool-v2-01'
});
console.log(ast.source_code);
console.log(ast.abi);

// Parse local source code
const parsed = await parseContract({
  contractId: 'SP...contract-name',
  sourceCode: '(define-public (hello) (ok "world"))',
  clarityVersion: '4', // Optional: '1' | '2' | '3' | '4'
  epoch: 'Epoch33' // Optional
});
```

### 5. Batch Operations

The SDK provides two approaches for efficient batch reading from the Stacks blockchain:

#### Direct Batch Reading

```typescript
import { batchRead, type BatchReadsResult } from 'stxer';

// Batch read variables and maps
const result: BatchReadsResult = await batchRead({
  variables: [{
    contract: contractPrincipalCV(...),
    variableName: 'my-var'
  }],
  maps: [{
    contract: contractPrincipalCV(...),
    mapName: 'my-map',
    mapKey: someCV
  }],
  readonly: [{
    contract: contractPrincipalCV(...),
    functionName: 'my-function',
    functionArgs: [/* clarity values */]
  }]
});

// Result shape — `index_block_hash` matches the upstream wire field
// (the SDK previously aliased this as `tip`; renamed to remove the
// indirection).
result.index_block_hash;       // string — the block the batch ran against
result.vars;                   // (ClarityValue | Error)[]
result.maps;                   // (ClarityValue | Error)[]
result.readonly;               // (ClarityValue | Error)[]
```

#### BatchProcessor for Queue-based Operations

The BatchProcessor allows you to queue multiple read operations and automatically batch them together after a specified delay:

```typescript
import { BatchProcessor } from 'stxer';

const processor = new BatchProcessor({
  stxerAPIEndpoint: 'https://api.stxer.xyz', // optional
  batchDelayMs: 1000, // delay before processing batch
});

// Queue multiple operations that will be batched together
const [resultA, resultB] = await Promise.all([
  processor.read({
    mode: 'variable',
    contractAddress: 'SP...',
    contractName: 'my-contract',
    variableName: 'variable-a'
  }),
  processor.read({
    mode: 'variable',
    contractAddress: 'SP...',
    contractName: 'my-contract',
    variableName: 'variable-b'
  })
]);

// You can also queue different types of operations
processor.read({
  mode: 'readonly',
  contractAddress: 'SP...',
  contractName: 'my-contract',
  functionName: 'get-value',
  functionArgs: []
});

processor.read({
  mode: 'mapEntry',
  contractAddress: 'SP...',
  contractName: 'my-contract',
  mapName: 'my-map',
  mapKey: someKey
});
```

The BatchProcessor automatically:
- Queues read operations
- Batches them together after the specified delay
- Makes a single API call for all queued operations
- Distributes results back to the respective promises

This is particularly useful when you need to make multiple blockchain reads and want to optimize network calls.

### 6. Clarity API Utilities

The SDK provides convenient utilities for reading data from Clarity contracts:

```typescript
import { callReadonly, readVariable, readMap } from 'stxer';
import { SIP010TraitABI } from 'clarity-abi/abis';
import { unwrapResponse } from 'ts-clarity';

// Read from a contract function
const supply = await callReadonly({
  abi: SIP010TraitABI.functions,
  functionName: 'get-total-supply',
  contract: 'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.token-alex',
}).then(unwrapResponse);

// Read a contract variable
const paused = await readVariable({
  abi: [{ name: 'paused', type: 'bool', access: 'variable' }],
  variableName: 'paused',
  contract: 'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.amm-vault-v2-01',
});

// Read from a contract map
const approved = await readMap({
  abi: [{ key: 'principal', name: 'approved-tokens', value: 'bool' }],
  mapName: 'approved-tokens',
  key: 'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.token-alex',
  contract: 'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.amm-vault-v2-01',
});
```

These utilities provide type-safe ways to interact with Clarity contracts, with built-in ABI support and response unwrapping.

## Configuration

### API Endpoint Constants

The SDK exports constants for stxer API endpoints:

```typescript
import { STXER_API_MAINNET, STXER_API_TESTNET } from 'stxer';

console.log(STXER_API_MAINNET); // https://api.stxer.xyz
console.log(STXER_API_TESTNET); // https://testnet-api.stxer.xyz
```

### Customizing API Endpoints

You can customize the API endpoints for all operations:

```typescript
import { SimulationBuilder, STXER_API_TESTNET } from 'stxer';

const builder = SimulationBuilder.new({
  apiEndpoint: STXER_API_TESTNET, // Use testnet
  stacksNodeAPI: 'https://api.testnet.hiro.so', // Testnet Stacks API
  network: 'testnet',
  skipTracing: false, // Set to true for faster simulations (no debug UI support)
});
```

For `getTip` and AST operations:

```typescript
import { getTip, getContractAST, parseContract, STXER_API_MAINNET } from 'stxer';

const tip = await getTip({
  stxerApi: STXER_API_MAINNET // Optional, defaults to mainnet
});

const ast = await getContractAST({
  contractId: 'SP...contract',
  stxerApi: STXER_API_MAINNET // Optional
});
```

## Samples

Runnable end-to-end examples live in
[`src/sample/`](https://github.com/stxer/stxer-sdk/tree/master/src/sample)
on GitHub. **The `src/sample/` directory is intentionally excluded from
the published npm tarball** to keep the package size down — clone the
repo to run them locally. Samples track `master` and may evolve faster
than published SDK versions; if you pin a specific SDK version, browse
the matching git tag.

### Core flows

| Sample | What it demonstrates |
|---|---|
| [`counter.ts`](https://github.com/stxer/stxer-sdk/blob/master/src/sample/counter.ts) | Full Simulation v2 lifecycle without `SimulationBuilder` — every `SimulationStepInput` variant (Transaction / Eval / SetContractCode / Reads / TenureExtend), narrowing on `SimulationStepResult`, and `SimulationStepSummary`. |
| [`instant.ts`](https://github.com/stxer/stxer-sdk/blob/master/src/sample/instant.ts) | `instantSimulation` with all 7 `ReadStep` variants. |
| [`failure-modes.ts`](https://github.com/stxer/stxer-sdk/blob/master/src/sample/failure-modes.ts) | The four failure signals on a `TransactionReceipt`, with bug-zoo triggers for each. |
| [`batch-categories.ts`](https://github.com/stxer/stxer-sdk/blob/master/src/sample/batch-categories.ts) | Every `simulationBatchReads` category and the sidecar `batchRead`. |
| [`contract-vitest.test.ts`](https://github.com/stxer/stxer-sdk/blob/master/src/sample/contract-vitest.test.ts) | Vitest suite that drives a Clarity contract through Simulation v2 — copy-pasteable CI test template. Pinned fork point so assertions stay deterministic. |
| [`verify-types.ts`](https://github.com/stxer/stxer-sdk/blob/master/src/sample/verify-types.ts) | Runtime type-drift detector. Hits every endpoint, dereferences every documented field, asserts each value's runtime type matches the declared SDK type. Run it before publishing your client after upstream changes. |
| [`read.ts`](https://github.com/stxer/stxer-sdk/blob/master/src/sample/read.ts) | `batchRead`, `BatchProcessor`, and the high-level `clarity-api` helpers (`callReadonly`, `readVariable`, `readMap`). |

### `AdvanceBlocks` + bridge / time-locked scenarios (0.8.0)

The vitest demos below are the canonical reference for the new
`addAdvanceBlocks` / `getSimulationTip` / `bitcoin.ts` / `sim-helpers`
patterns. All target real **mainnet** contracts at pinned settled
blocks — every assertion is exact.

| Sample | What it demonstrates |
|---|---|
| [`locked-stx-vitest.test.ts`](https://github.com/stxer/stxer-sdk/blob/master/src/sample/locked-stx-vitest.test.ts) | PoX-4 locked-STX unlock: read `(stx-account ...)`, attempt pre-unlock transfer (`err u1`), `addAdvanceBlocks` past `unlock_height`, transfer the now-released amount. Includes the parent-burn-probe trick (advance with `bitcoin_blocks: 0` first to learn the parent burn height before computing N). |
| [`sbtc-deposit-vitest.test.ts`](https://github.com/stxer/stxer-sdk/blob/master/src/sample/sbtc-deposit-vitest.test.ts) | sBTC bridge deposit, end-to-end. Uses `forgeBitcoinTx` + `AdvanceBlocks { burn_header_hashes: ... }` so `(get-burn-block-info? header-hash …)` resolves to a value we control. |
| [`brotocol-pegin-vitest.test.ts`](https://github.com/stxer/stxer-sdk/blob/master/src/sample/brotocol-pegin-vitest.test.ts) | Brotocol BTC peg-in. Forges a Bitcoin tx + 2-tx Merkle proof + 80-byte block header; calls `finalize-peg-in-0`; asserts mint and replay rejection. The full `bitcoin.ts` SPV pipeline. |
| [`hbtc-vault-vitest.test.ts`](https://github.com/stxer/stxer-sdk/blob/master/src/sample/hbtc-vault-vitest.test.ts) | hBTC yield-bearing vault: deposit, request-redeem, `AdvanceBlocks +1 day` to cross the rewarder window, `log-reward`, fund-claim, `AdvanceBlocks +3 days` to clear the cooldown, redeem, transfer. Exact yield arithmetic. |
| [`zest-borrow-vitest.test.ts`](https://github.com/stxer/stxer-sdk/blob/master/src/sample/zest-borrow-vitest.test.ts) | Zest V2 lend / borrow / repay with a forged Pyth v4 price update. Patches `pyth-pnau-decoder-v3` via `SetContractCode` to bypass the Wormhole quorum / Merkle / data-source checks; `AdvanceBlocks +1` so storage's freshness gate has a synthetic-tip block_time. |
| [`granite-leverage-vitest.test.ts`](https://github.com/stxer/stxer-sdk/blob/master/src/sample/granite-leverage-vitest.test.ts) | Granite leverage open with a forged Pyth v3 price update. Same patch-decoder pattern as Zest, applied through Granite's gl-api → gl-oracle → pyth-oracle-v3 chain. |

Run any of them locally by cloning the SDK repo and:

```bash
pnpm install
pnpm sample:counter           # or sample:instant / failure-modes / batch-categories / verify-types
pnpm sample:vitest            # run the Vitest sample suite (counter + 6 bridge / locked-STX demos)
```

## API Reference

### Constants

- `STXER_API_MAINNET` — Mainnet API endpoint (`https://api.stxer.xyz`)
- `STXER_API_TESTNET` — Testnet API endpoint (`https://testnet-api.stxer.xyz`)
- `DEFAULT_STXER_API` — Default API endpoint (same as `STXER_API_MAINNET`)

### Simulation Builder (high-level)

- `SimulationBuilder.new(options)` — Create a new simulation builder
- `builder.useBlockHeight(height)` — Pin the parent block to fork at
- `builder.withSender(address)` — Default sender address for unsigned txs

**Transaction Steps:**
- `builder.addContractCall(params)` — Add a contract call step
- `builder.addSTXTransfer(params)` — Add an STX transfer step
- `builder.addContractDeploy(params)` — Add a contract deployment step

**V2 Step Types:**
- `builder.addEvalCode(contractId, code)` — Arbitrary code evaluation with write access
- `builder.addSetContractCode(params)` — Replace contract code without a transaction
- `builder.addReads(reads[])` — Batch read operations interleaved with other steps
- `builder.addTenureExtend(cause?)` — Reset execution cost. Default `'Extended'` resets all dimensions; pass an explicit `TenureExtendCause` to reset only one SIP-034 dimension
- `builder.addAdvanceBlocks(request)` — *(0.8.0)* Synthesize bitcoin / stacks blocks on the fork. See the [`AdvanceBlocks` section](#advanceblocks-burn-block-scenarios)

**Execution:**
- `builder.run()` — Submit the session and return the `simulation_id`. Note: returns only the id; if you need typed per-step results, use the low-level API + `sim-helpers` instead

### Programmatic simulation APIs (low-level)

**Instant simulation:**
- `instantSimulation(request, options?)` — Simulate a single transaction without a session. Transient: **no debug tracing**, not viewable in the stxer UI

**Session management:**
- `createSimulationSession(options?, apiOptions?)` — Create a new session, returns `id: string`
- `submitSimulationSteps(sessionId, request, options?)` — Submit one or more steps; returns typed per-step results
- `getSimulationResult(sessionId, options?)` — Get full session results (metadata + step summaries)
- `getSimulationTip(sessionId, options?)` — *(0.8.0)* Read the current synthetic tip after `AdvanceBlocks` steps. See the [`AdvanceBlocks` section](#advanceblocks-burn-block-scenarios)
- `simulationBatchReads(sessionId, request, options?)` — Batch-read the session's forked state without consuming a step slot

**Errors:**
- `class SimulationError extends Error` — *(0.8.0)* Typed error thrown by every fetch wrapper. Fields:
  - `.status: number` — HTTP status (409 retry, 410 start-new-session, 400 validation, 404 not found, ...)
  - `.marker: 'simulation_busy' | 'simulation_outdated' | null` — server-side classification
  - `.body: string` — raw upstream message
  - `.message: string` — formatted as `"${operation} (HTTP ${status}): ${body}"`
- `type SimulationErrorMarker` — *(0.8.0)* Exported union for `.marker`

### Sim helpers (`callContract`, `getStxBalance`, `getFtBalance`, `getNonce`, `readDataVar`)

*New in 0.8.0.* Session-bound wrappers around `simulationBatchReads`
that produce typed reads without hand-rolling the batch envelope. Useful
for vitest-style tests that interleave reads with mutating steps.

- `callContract(sessionId, args, options?)` — Build an unsigned contract-call tx, submit it as one step, decode the result. Returns `{ result, vmError, pcAborted, events, txid, executionCost }` for direct `expect(...)` assertions
- `getStxBalance(sessionId, principal, options?): Promise<bigint>`
- `getFtBalance(sessionId, contractAndToken, principal, options?): Promise<bigint>`
- `getNonce(sessionId, principal, options?): Promise<bigint>` — session-bound (do not confuse with the Hiro-API `getOnChainNonce` in `src/sample/_helpers.ts`)
- `readDataVar(sessionId, contractId, varName, options?)` — Returns the deserialized Clarity value
- `parseSimulationEvent(eventJson)` — Parse one entry from `TransactionReceipt.events[]` into a typed `SimulationEvent`

### Transaction builders

*New in 0.8.0.* Build unsigned transaction hex without `SimulationBuilder`
— useful when you want to control sender via the simulator's
no-signature trust model.

- `setSender(tx, sender)` — Rewrite an unsigned `StacksTransactionWire`'s spending condition so the simulator treats `sender` as the origin. Mutates and returns `tx`
- `buildUnsignedContractCallHex(args)` — `args: { sender, contract, functionName, functionArgs, fee?, nonce? }` → hex string
- `ftPrincipal(contractAndToken: 'SP....contract::token-name'): ClarityValue` — Build a `(contract-of (use-trait <ft-trait>))` literal for FT contract calls

### Bitcoin SPV / bridge primitives

*New in 0.8.0.* Forge Bitcoin transactions and SPV proofs for bridge
peg-in scenarios. Pairs with `addAdvanceBlocks`'
`burn_header_hashes` override so on-chain
`(get-burn-block-info? header-hash …)` resolves to a value you control.

- `forgeBitcoinTx(opts)` — Build a Bitcoin tx with chosen inputs / outputs / OP_RETURN. Returns `{ rawTx, txid, inputs, outputs }`
- `buildBitcoinHeader(opts)` — 80-byte BTC block header with chosen prev-hash / merkle root / time / bits / nonce. Returns `{ rawHeader, hash }` where `hash` is the double-sha256 (display order, ready for `burn_header_hashes`)
- `singleTxMerkleRoot(txid: Uint8Array): Uint8Array` — 1-tx merkle root (the txid itself)
- `merkleProof(txids, txIndex): { hashes: Uint8Array[], treeDepth: number }`
- `verifyMerkleProof(txid, proof, root): boolean`
- `p2wpkhScript(pubKeyHash20)` / `p2pkhScript(pubKeyHash20)` / `opReturnScript(data)` — scriptPubKey builders
- `sha256(data)` / `sha256d(data)` / `hexToBytes(s)` / `bytesToHex(b)`

### `AdvanceBlocks` (burn-block scenarios)

*New in 0.8.0.* Synthesize bitcoin / stacks blocks on top of the
simulation's pinned parent tip — used to model burn-block / tenure
boundaries (PoX cycles, locked-STX unlock, time-locked redemptions,
bridge contract finalization).

- `builder.addAdvanceBlocks(request)` — builder method
- `submitSimulationSteps(id, { steps: [{ AdvanceBlocks: ... }] }, opts)` — raw step
- `getSimulationTip(id, opts?)` — read the current synthetic tip; `synthetic: true` after at least one `AdvanceBlocks` step has run
- `AdvanceBlocksRequest` (key fields):
  - `bitcoin_blocks: number` — burn blocks to synthesize
  - `stacks_blocks_per_bitcoin: number`
  - `bitcoin_interval_secs?: U64` — burn-block-time delta; defaults to 600s
  - `burn_header_hashes?: Record<string, string>` — per-burn-index hash override (32-byte hex), keyed by 0-based index
  - `pox_addrs?: Record<string, [PoxAddrInput[], U128]>` — per-burn-index PoX-payout override
  - `vrf_seeds?: Record<string, string>` — per-burn-index VRF-seed override

For the canonical worked examples — including the parent-burn-probe
trick for computing N, the `burn_header_hashes` + Merkle-proof bridge
pattern, and the `SetContractCode` + `AdvanceBlocks` Pyth-decoder
pattern — see the
[bridge / time-locked vitest demos](#advanceblocks--bridge--time-locked-scenarios-080)
on GitHub.

### Chain tip

- `getTip(options?)` — Global mainnet chain tip (sidecar). Distinct from `getSimulationTip` (per-session synthetic tip)

### Contract AST

- `getContractAST({ contractId, stxerApi? })` — Fetch on-chain contract AST
- `parseContract({ sourceCode, contractId, clarityVersion?, epoch?, stxerApi? })` — Parse source code to AST. `clarityVersion` is `ClarityVersionName` (`'Clarity1' | ... | 'Clarity4'`) — distinct from `@stacks/transactions`'s numeric `ClarityVersion` enum

### Batch operations

- `batchRead(reads, options?)` — Execute batch read operations against current chain state via the sidecar
- `new BatchProcessor({ stxerAPIEndpoint?, batchDelayMs })` — Queue-based batch processor for high-throughput read pipelines

### Clarity API

- `callReadonly(params)` — Call a read-only contract function
- `readVariable(params)` — Read a contract variable
- `readMap(params)` — Read from a contract map

## Support

This product is made possible through community support. Consider supporting the development:

```
SP212Y5JKN59YP3GYG07K3S8W5SSGE4KH6B5STXER
```

For feedback and feature requests, contact: contact@stxer.xyz

## License

MIT
