import {
  ClarityType,
  type ClarityValue,
  type OptionalCV,
} from '@stacks/transactions';
import type {
  ClarityAbiFunction,
  ClarityAbiMap,
  ClarityAbiVariable,
  TContractPrincipal,
  TPrincipal,
} from 'clarity-abi';
import type {
  InferMapValueType,
  InferReadMapParameterType,
  InferReadonlyCallParameterType,
  InferReadonlyCallResultType,
  InferReadVariableParameterType,
  InferVariableType,
} from 'ts-clarity';
import { decodeAbi, encodeAbi } from 'ts-clarity';
import { BatchProcessor } from './BatchProcessor';

// Shared processor instance with default settings
const defaultProcessor = new BatchProcessor({
  batchDelayMs: 100,
});

export type ReadonlyCallRuntimeOptions = {
  sender?: TPrincipal;
  contract: TContractPrincipal;
  stacksEndpoint?: string;
  indexBlockHash?: string;
  batchProcessor?: BatchProcessor;
};

export type ReadMapRuntimeParameters = {
  contract: TContractPrincipal;
  stacksEndpoint?: string;
  proof?: boolean;
  indexBlockHash?: string;
  batchProcessor?: BatchProcessor;
};

export type ReadVariableRuntimeParameterType = {
  contract: TContractPrincipal;
  stacksEndpoint?: string;
  proof?: boolean;
  indexBlockHash?: string;
  batchProcessor?: BatchProcessor;
};

export async function callReadonly<
  Functions extends readonly ClarityAbiFunction[] | readonly unknown[],
  FunctionName extends string,
>(
  params: InferReadonlyCallParameterType<Functions, FunctionName> &
    ReadonlyCallRuntimeOptions,
): Promise<InferReadonlyCallResultType<Functions, FunctionName>> {
  const processor = params.batchProcessor ?? defaultProcessor;
  const [deployer, contractName] = params.contract.split('.', 2);
  const fn = String(params.functionName);

  const functionDef = (params.abi as readonly ClarityAbiFunction[]).find(
    (def) => def.name === params.functionName,
  );
  if (!functionDef) {
    throw new Error(
      `failed to find function definition for ${params.functionName}`,
    );
  }

  const argsKV = (params as unknown as { args: Record<string, unknown> }).args;
  const args: ClarityValue[] = [];
  for (const argDef of functionDef.args) {
    args.push(encodeAbi(argDef.type, argsKV[argDef.name]));
  }

  return new Promise((resolve, reject) => {
    processor.enqueue({
      request: {
        mode: 'readonly',
        contractAddress: deployer,
        contractName: contractName,
        functionName: fn,
        functionArgs: args,
      },
      tip: params.indexBlockHash,
      resolve: (result: ClarityValue | OptionalCV) => {
        try {
          const decoded = decodeAbi(functionDef.outputs.type, result);
          resolve(
            decoded as InferReadonlyCallResultType<Functions, FunctionName>,
          );
        } catch (error) {
          reject(error);
        }
      },
      reject,
    });
  });
}

export async function readMap<
  Maps extends
    | readonly ClarityAbiMap[]
    | readonly unknown[] = readonly ClarityAbiMap[],
  MapName extends string = string,
>(
  params: InferReadMapParameterType<Maps, MapName> & ReadMapRuntimeParameters,
): Promise<InferMapValueType<Maps, MapName> | null> {
  const processor = params.batchProcessor ?? defaultProcessor;
  const [deployer, contractName] = params.contract.split('.', 2);

  const mapDef = (params.abi as readonly ClarityAbiMap[]).find(
    (m) => m.name === params.mapName,
  );
  if (!mapDef) {
    throw new Error(`failed to find map definition for ${params.mapName}`);
  }

  const key: ClarityValue = encodeAbi(mapDef.key, params.key);

  return new Promise((resolve, reject) => {
    processor.enqueue({
      request: {
        mode: 'mapEntry',
        contractAddress: deployer,
        contractName: contractName,
        mapName: params.mapName,
        mapKey: key,
      },
      tip: params.indexBlockHash,
      resolve: (result: ClarityValue | OptionalCV) => {
        try {
          if (result.type === ClarityType.OptionalNone) {
            resolve(null);
            return;
          }
          if (result.type !== ClarityType.OptionalSome) {
            throw new Error(`unexpected map value: ${result}`);
          }
          const someCV = result as {
            type: ClarityType.OptionalSome;
            value: ClarityValue;
          };
          const decoded = decodeAbi(mapDef.value, someCV.value);
          resolve(decoded as InferMapValueType<Maps, MapName>);
        } catch (error) {
          reject(error);
        }
      },
      reject,
    });
  });
}

export async function readVariable<
  Variables extends
    | readonly ClarityAbiVariable[]
    | readonly unknown[] = readonly ClarityAbiVariable[],
  VariableName extends string = string,
>(
  params: InferReadVariableParameterType<Variables, VariableName> &
    ReadVariableRuntimeParameterType,
): Promise<InferVariableType<Variables, VariableName>> {
  const processor = params.batchProcessor ?? defaultProcessor;
  const [deployer, contractName] = params.contract.split('.', 2);

  const varDef = (params.abi as readonly ClarityAbiVariable[]).find(
    (def) => def.name === params.variableName,
  );
  if (!varDef) {
    throw new Error(
      `failed to find variable definition for ${params.variableName}`,
    );
  }

  return new Promise((resolve, reject) => {
    processor.enqueue({
      request: {
        mode: 'variable',
        contractAddress: deployer,
        contractName: contractName,
        variableName: params.variableName,
      },
      tip: params.indexBlockHash,
      resolve: (result: ClarityValue | OptionalCV) => {
        try {
          const decoded = decodeAbi(varDef.type, result);
          resolve(decoded as InferVariableType<Variables, VariableName>);
        } catch (error) {
          reject(error);
        }
      },
      reject,
    });
  });
}
