# stxer SDK

A powerful SDK for Stacks blockchain that provides transaction simulation, batch operations, contract AST parsing, and chain tip information.

## Installation

```bash
npm install stxer
# or
yarn add stxer
```

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
    clarity_version: 4, // Optional: Clarity1, Clarity2, Clarity3, or Clarity4
  })
  .run();

// View simulation results at: https://stxer.xyz/simulations/mainnet/{simulationId}
```

#### Advanced V2 Step Types

The SDK supports all V2 simulation step types:

```typescript
import { SimulationBuilder, ClarityVersion } from 'stxer';

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

  // === Eval Steps ===
  // Read state
  .addEvalCode('SP...contract', '(var-get counter)')

  // Modify state
  .addEvalCode('SP...contract', '(var-set counter u100)')

  // === SetContractCode Step ===
  // Directly set contract code without a transaction
  .addSetContractCode({
    contract_id: 'SP...contract',
    source_code: '(define-data-var enabled bool false)',
    clarity_version: ClarityVersion.Clarity4,
  })

  // === Reads Batch Step ===
  // Batch multiple read operations in a single step
  .addReads([
    { DataVar: ['SP...contract', 'counter'] },
    { DataVar: ['SP...contract', 'enabled'] },
    { StxBalance: 'SP...' },
    { Nonce: 'SP...' },
    { EvalReadonly: ['SP...', '', 'SP...contract', '(get-counter)'] },
  ])

  // === TenureExtend Step ===
  // Extend tenure (resets execution cost)
  .addTenureExtend()

  .run();
```

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
    { TenureExtend: [] }
  ]
});

console.log(`Executed ${stepResults.steps.length} steps`);

// 3. Get full simulation results
const result = await getSimulationResult(sessionId);
console.log(result.metadata);
console.log(result.steps);

// 4. Batch reads from simulation state
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

Runnable end-to-end examples live in [`src/sample/`](https://github.com/stxer/stxer-sdk/tree/master/src/sample) on GitHub. Samples track `master` and may evolve faster than published SDK versions; if you pin a specific SDK version, browse the matching git tag.

| Sample | What it demonstrates |
|---|---|
| [`counter.ts`](https://github.com/stxer/stxer-sdk/blob/master/src/sample/counter.ts) | Full Simulation v2 lifecycle without `SimulationBuilder` — every `SimulationStepInput` variant (Transaction / Eval / SetContractCode / Reads / TenureExtend), narrowing on `SimulationStepResult`, and `SimulationStepSummary`. |
| [`instant.ts`](https://github.com/stxer/stxer-sdk/blob/master/src/sample/instant.ts) | `instantSimulation` with all 7 `ReadStep` variants. |
| [`failure-modes.ts`](https://github.com/stxer/stxer-sdk/blob/master/src/sample/failure-modes.ts) | The four failure signals on a `TransactionReceipt`, with bug-zoo triggers for each. |
| [`batch-categories.ts`](https://github.com/stxer/stxer-sdk/blob/master/src/sample/batch-categories.ts) | Every `simulationBatchReads` category and the sidecar `batchRead`. |
| [`contract-vitest.test.ts`](https://github.com/stxer/stxer-sdk/blob/master/src/sample/contract-vitest.test.ts) | Vitest suite that drives a Clarity contract through Simulation v2 — copy-pasteable CI test template. Pinned fork point so assertions stay deterministic. |
| [`verify-types.ts`](https://github.com/stxer/stxer-sdk/blob/master/src/sample/verify-types.ts) | Runtime type-drift detector. Hits every endpoint, dereferences every documented field, asserts each value's runtime type matches the declared SDK type. Run it before publishing your client after upstream changes. |
| [`read.ts`](https://github.com/stxer/stxer-sdk/blob/master/src/sample/read.ts) | `batchRead`, `BatchProcessor`, and the high-level `clarity-api` helpers (`callReadonly`, `readVariable`, `readMap`). |

Run any of them locally by cloning the SDK repo and:

```bash
pnpm install
pnpm sample:counter           # or sample:instant / failure-modes / batch-categories / verify-types
pnpm sample:vitest            # run the Vitest contract-test sample
```

## API Reference

### Constants

- `STXER_API_MAINNET` - Mainnet API endpoint (https://api.stxer.xyz)
- `STXER_API_TESTNET` - Testnet API endpoint (https://testnet-api.stxer.xyz)
- `DEFAULT_STXER_API` - Default API endpoint (same as STXER_API_MAINNET)

### Simulation Builder (High-Level)

- `SimulationBuilder.new(options)` - Create a new simulation builder
- `builder.useBlockHeight(height)` - Set block height for simulation
- `builder.withSender(address)` - Set default sender address

**Transaction Steps:**
- `builder.addContractCall(params)` - Add a contract call step
- `builder.addSTXTransfer(params)` - Add an STX transfer step
- `builder.addContractDeploy(params)` - Add a contract deployment step

**V2 Step Types:**
- `builder.addEvalCode(contractId, code)` - Add arbitrary code evaluation (with state modification)
- `builder.addSetContractCode(params)` - Directly set contract code without transaction
- `builder.addReads(reads[])` - Batch read operations in a single step
- `builder.addTenureExtend()` - Extend tenure (resets execution cost)

**Execution:**
- `builder.run()` - Execute the simulation and return simulation ID

### Programmatic Simulation APIs (Low-Level)

**Instant Simulation:**
- `instantSimulation(request, options?)` - Simulate a single transaction without session

**Session Management:**
- `createSimulationSession(options?, apiOptions?)` - Create a new simulation session
- `submitSimulationSteps(sessionId, request, options?)` - Submit steps to a session
- `getSimulationResult(sessionId, options?)` - Get full simulation results
- `simulationBatchReads(sessionId, request, options?)` - Batch reads from simulation state

### Chain Tip

- `getTip(options?)` - Fetch current chain tip information

### Contract AST

- `getContractAST({ contractId, stxerApi? })` - Fetch on-chain contract AST
- `parseContract({ sourceCode, contractId, clarityVersion?, epoch?, stxerApi? })` - Parse source code to AST

### Batch Operations

- `batchRead(reads, options?)` - Execute batch read operations
- `new BatchProcessor({ stxerAPIEndpoint?, batchDelayMs })` - Create a batch processor

### Clarity API

- `callReadonly(params)` - Call a read-only contract function
- `readVariable(params)` - Read a contract variable
- `readMap(params)` - Read from a contract map

## Support

This product is made possible through community support. Consider supporting the development:

```
SP212Y5JKN59YP3GYG07K3S8W5SSGE4KH6B5STXER
```

For feedback and feature requests, contact: contact@stxer.xyz

## License

MIT
