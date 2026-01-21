# stxer SDK

A powerful SDK for Stacks blockchain that provides batch operations, transaction simulation, contract AST parsing, and chain tip information.

## Installation

```bash
npm install stxer
# or
yarn add stxer
```

## Features

### 1. Transaction Simulation (V2 API)

Simulate complex transaction sequences before executing them on-chain:

```typescript
import { SimulationBuilder } from 'stxer';

const simulationId = await SimulationBuilder.new({
  network: 'mainnet', // or 'testnet'
  skipTracing: false, // Set to true for faster simulations without debug info
})
  .withSender('ST...') // Set default sender
  .addContractCall({
    contract_id: 'ST...contract-name',
    function_name: 'my-function',
    function_args: [/* clarity values */]
  })
  .addSTXTransfer({
    recipient: 'ST...',
    amount: 1000000 // in microSTX
  })
  .addContractDeploy({
    contract_name: 'my-contract',
    source_code: '(define-public (hello) (ok "world"))'
  })
  .run();

// View simulation results at: https://stxer.xyz/simulations/{network}/{simulationId}
```

### 2. Get Chain Tip

Fetch the current chain tip information:

```typescript
import { getTip, type SidecarTip } from 'stxer';

const tip: SidecarTip = await getTip();
console.log(`Current block: ${tip.block_height}`);
console.log(`Block hash: ${tip.block_hash}`);
console.log(`Bitcoin height: ${tip.bitcoin_height}`);
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
  contractId: 'ST...contract-name',
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

## Breaking Changes from Previous Version

This version uses the **V2 Simulation API** which is incompatible with the previous V1 binary format:

1. **SimulationBuilder** now uses JSON-based V2 API (`/devtools/v2/simulations`)
2. **`inlineSimulation()`** is not yet supported in V2 - please run simulations from scratch
3. New `skipTracing` option for faster simulations without debug information

## API Reference

### Simulation

- `SimulationBuilder.new(options)` - Create a new simulation builder
- `builder.useBlockHeight(height)` - Set block height for simulation
- `builder.withSender(address)` - Set default sender address
- `builder.addContractCall(params)` - Add a contract call step
- `builder.addSTXTransfer(params)` - Add an STX transfer step
- `builder.addContractDeploy(params)` - Add a contract deployment step
- `builder.addEvalCode(contractId, code)` - Add arbitrary code evaluation
- `builder.run()` - Execute the simulation

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
