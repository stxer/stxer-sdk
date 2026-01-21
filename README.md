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

### 2. Get Chain Tip

Fetch the current chain tip information:

```typescript
import { getTip, type SidecarTip } from 'stxer';

const tip: SidecarTip = await getTip();
console.log(`Current block: ${tip.block_height}`);
console.log(`Block hash: ${tip.block_hash}`);
console.log(`Bitcoin height: ${tip.bitcoin_height}`);
console.log(`Tenure cost: ${tip.tenure_cost}`);
```

### 3. Contract AST Operations

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

### 4. Batch Operations

The SDK provides two approaches for efficient batch reading from the Stacks blockchain:

#### Direct Batch Reading

```typescript
import { batchRead } from 'stxer';

// Batch read variables and maps
const result = await batchRead({
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

### 5. Clarity API Utilities

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

You can customize the API endpoints:

```typescript
const builder = SimulationBuilder.new({
  apiEndpoint: 'https://api.stxer.xyz', // Default stxer API endpoint
  stacksNodeAPI: 'https://api.hiro.so', // Default Stacks API endpoint
  network: 'mainnet' // or 'testnet'
  skipTracing: false, // Set to true for faster simulations (no debug UI support)
});
```

For `getTip` and AST operations:

```typescript
import { getTip, getContractAST, parseContract } from 'stxer';

const tip = await getTip({
  stxerApi: 'https://api.stxer.xyz' // Optional
});

const ast = await getContractAST({
  contractId: 'SP...contract',
  stxerApi: 'https://api.stxer.xyz' // Optional
});
```

## API Reference

### Simulation

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
