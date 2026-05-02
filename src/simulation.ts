import {
  STACKS_MAINNET,
  STACKS_TESTNET,
  type StacksNetworkName,
} from '@stacks/network';
import type { Block } from '@stacks/stacks-blockchain-api-types';
import {
  Cl,
  ClarityType,
  type ClarityValue,
  ClarityVersion,
  cvToString,
  deserializeCV,
  makeUnsignedContractCall,
  makeUnsignedContractDeploy,
  makeUnsignedSTXTokenTransfer,
  PostConditionMode,
  serializeCV,
} from '@stacks/transactions';
import { type AccountDataResponse, getNodeInfo, richFetch } from 'ts-clarity';
import { bytesToHex } from './bitcoin';
import { STXER_API_MAINNET, STXER_API_TESTNET } from './constants';
import {
  createSimulationSession,
  type SimulationApiOptions,
  simulationBatchReads,
  submitSimulationSteps,
} from './simulation-api';
import {
  buildUnsignedContractCallHex,
  type ContractCallTxArgs,
  setSender,
} from './transaction';
import type {
  AdvanceBlocksRequest,
  ReadStep,
  SimulationStepInput,
  TenureExtendCause,
  TransactionReceipt,
} from './types';

export interface SimulationEval {
  contract_id: string;
  code: string;
}

interface SimulationBuilderOptions {
  apiEndpoint?: string;
  stacksNodeAPI?: string;
  network?: StacksNetworkName | string;
  skipTracing?: boolean;
}

export class SimulationBuilder {
  private apiEndpoint: string;
  private stacksNodeAPI: string;
  private network: StacksNetworkName | string;
  private skipTracing: boolean;

  private constructor(options: SimulationBuilderOptions = {}) {
    this.network = options.network ?? 'mainnet';
    const isTestnet = this.network === 'testnet';

    this.apiEndpoint =
      options.apiEndpoint ??
      (isTestnet ? STXER_API_TESTNET : STXER_API_MAINNET);
    this.stacksNodeAPI =
      options.stacksNodeAPI ??
      (isTestnet ? 'https://api.testnet.hiro.so' : 'https://api.hiro.so');
    this.skipTracing = options.skipTracing ?? false;
  }

  public static new(options?: SimulationBuilderOptions) {
    return new SimulationBuilder(options);
  }

  private block = Number.NaN;
  private sender = '';
  private steps: (
    | {
        // inline simulation (V1 - not supported in V2, but kept for potential future support)
        simulationId: string;
      }
    | {
        // contract call
        contract_id: string;
        function_name: string;
        function_args?: ClarityValue[];
        sender: string;
        fee: number;
      }
    | {
        // contract deploy
        contract_name: string;
        source_code: string;
        deployer: string;
        fee: number;
        clarity_version: ClarityVersion;
      }
    | {
        // STX transfer
        recipient: string;
        amount: number;
        sender: string;
        fee: number;
      }
    | SimulationEval
    | {
        // SetContractCode - V2 native step type
        type: 'SetContractCode';
        contract_id: string;
        source_code: string;
        clarity_version: ClarityVersion;
      }
    | {
        // Reads - V2 native batch reads step type
        type: 'Reads';
        reads: ReadStep[];
      }
    | {
        // TenureExtend - V2 native step type
        type: 'TenureExtend';
        cause: TenureExtendCause;
      }
    | {
        // AdvanceBlocks - V2 native step type, synthesizes blocks
        type: 'AdvanceBlocks';
        request: AdvanceBlocksRequest;
      }
  )[] = [];

  public useBlockHeight(block: number) {
    this.block = block;
    return this;
  }

  public withSender(address: string) {
    this.sender = address;
    return this;
  }

  public inlineSimulation(simulationId: string) {
    this.steps.push({
      simulationId,
    });
    return this;
  }

  public addSTXTransfer(params: {
    recipient: string;
    amount: number;
    sender?: string;
    fee?: number;
  }) {
    if (params.sender == null && this.sender === '') {
      throw new Error(
        'Please specify a sender with useSender or adding a sender paramenter',
      );
    }
    this.steps.push({
      ...params,
      sender: params.sender ?? this.sender,
      fee: params.fee ?? 0,
    });
    return this;
  }

  public addContractCall(params: {
    contract_id: string;
    function_name: string;
    function_args?: ClarityValue[];
    sender?: string;
    fee?: number;
  }) {
    if (params.sender == null && this.sender === '') {
      throw new Error(
        'Please specify a sender with useSender or adding a sender paramenter',
      );
    }
    this.steps.push({
      ...params,
      sender: params.sender ?? this.sender,
      fee: params.fee ?? 0,
    });
    return this;
  }

  public addContractDeploy(params: {
    contract_name: string;
    source_code: string;
    deployer?: string;
    fee?: number;
    clarity_version?: ClarityVersion;
  }) {
    if (params.deployer == null && this.sender === '') {
      throw new Error(
        'Please specify a deployer with useSender or adding a deployer paramenter',
      );
    }
    this.steps.push({
      ...params,
      deployer: params.deployer ?? this.sender,
      fee: params.fee ?? 0,
      clarity_version: params.clarity_version ?? ClarityVersion.Clarity5,
    });
    return this;
  }

  public addEvalCode(inside_contract_id: string, code: string) {
    this.steps.push({
      contract_id: inside_contract_id,
      code,
    });
    return this;
  }

  public addMapRead(contract_id: string, map: string, key: string) {
    this.steps.push({
      contract_id,
      code: `(map-get ${map} ${key})`,
    });
    return this;
  }

  public addVarRead(contract_id: string, variable: string) {
    this.steps.push({
      contract_id,
      code: `(var-get ${variable})`,
    });
    return this;
  }

  public addSetContractCode(params: {
    contract_id: string;
    source_code: string;
    clarity_version?: ClarityVersion;
  }) {
    this.steps.push({
      type: 'SetContractCode',
      contract_id: params.contract_id,
      source_code: params.source_code,
      clarity_version: params.clarity_version ?? ClarityVersion.Clarity5,
    });
    return this;
  }

  public addReads(reads: ReadStep[]) {
    this.steps.push({
      type: 'Reads',
      reads,
    });
    return this;
  }

  /**
   * Add a `TenureExtend` step. Defaults to `cause: 'Extended'` (full
   * cost reset) — equivalent in server-side behavior to the legacy
   * zero-arg call.
   *
   * Pass an explicit `TenureExtendCause` to reset only one SIP-034
   * dimension (`ExtendedRuntime` / `ExtendedReadCount` / etc.).
   *
   * On the wire SDK 0.8.0 emits the modern `{ TenureExtend: { cause } }`
   * shape. The server still parses the legacy `[]` shape for any
   * caller emitting raw step objects.
   */
  public addTenureExtend(cause: TenureExtendCause = 'Extended') {
    this.steps.push({
      type: 'TenureExtend',
      cause,
    });
    return this;
  }

  /**
   * Synthesize bitcoin and stacks blocks on top of the simulation's
   * pinned parent tip. Used to model burn-block / tenure boundaries
   * (bridge contracts, time-locked redemptions, locked-STX unlock).
   *
   * The simulator validates the request shape; older simulator builds
   * that don't yet support `AdvanceBlocks` reject this variant with
   * HTTP 400.
   *
   * @example
   * ```typescript
   * builder.addAdvanceBlocks({
   *   bitcoin_blocks: 1,
   *   stacks_blocks_per_bitcoin: 1,
   * });
   * ```
   */
  public addAdvanceBlocks(request: AdvanceBlocksRequest) {
    this.steps.push({
      type: 'AdvanceBlocks',
      request,
    });
    return this;
  }

  private async getBlockInfo() {
    if (Number.isNaN(this.block)) {
      const { stacks_tip_height } = await getNodeInfo({
        stacksEndpoint: this.stacksNodeAPI,
      });
      this.block = stacks_tip_height;
    }
    const info: Block = await richFetch(
      `${this.stacksNodeAPI}/extended/v1/block/by_height/${this.block}?unanchored=true`,
    ).then((r) => r.json());
    if (
      info.height !== this.block ||
      typeof info.hash !== 'string' ||
      !info.hash.startsWith('0x')
    ) {
      throw new Error(
        `failed to get block info for block height ${this.block}`,
      );
    }
    return {
      block_height: this.block,
      block_hash: info.hash.substring(2),
      index_block_hash: info.index_block_hash.substring(2),
    };
  }

  public async run(): Promise<string> {
    console.log(
      `--------------------------------
This product can never exist without your support!

We receive sponsorship funds with:
SP212Y5JKN59YP3GYG07K3S8W5SSGE4KH6B5STXER

Feedbacks and feature requests are welcome.
To get in touch: contact@stxer.xyz
--------------------------------`,
    );
    const block = await this.getBlockInfo();
    console.log(
      `Using block height ${block.block_height} hash 0x${block.block_hash} to run simulation.`,
    );

    const v2Steps: SimulationStepInput[] = [];
    const nonce_by_address = new Map<string, number>();
    const nextNonce = async (sender: string) => {
      const nonce = nonce_by_address.get(sender);
      if (nonce == null) {
        const url = `${
          this.stacksNodeAPI
        }/v2/accounts/${sender}?proof=${false}&tip=${block.index_block_hash}`;
        const account: AccountDataResponse = await richFetch(url).then((r) =>
          r.json(),
        );
        nonce_by_address.set(sender, account.nonce + 1);
        return account.nonce;
      }
      nonce_by_address.set(sender, nonce + 1);
      return nonce;
    };

    let network = this.network === 'mainnet' ? STACKS_MAINNET : STACKS_TESTNET;
    if (this.stacksNodeAPI) {
      network = {
        ...network,
        client: {
          ...network.client,
          baseUrl: this.stacksNodeAPI,
        },
      };
    }

    for (const step of this.steps) {
      if ('simulationId' in step) {
        // Inline simulation - for V2 we would need to fetch the previous simulation
        // and convert its steps to V2 format. This is complex and may not be
        // commonly used, so for now we'll throw an error.
        throw new Error(
          'inlineSimulation is not yet supported in V2 API. Please run simulations from scratch.',
        );
      }
      if ('sender' in step && 'function_name' in step) {
        const nonce = await nextNonce(step.sender);
        const tx = await makeUnsignedContractCall({
          contractAddress: step.contract_id.split('.')[0] as string,
          contractName: step.contract_id.split('.')[1] as string,
          functionName: step.function_name,
          functionArgs: step.function_args ?? [],
          nonce,
          network,
          publicKey: '',
          postConditionMode: PostConditionMode.Allow,
          fee: step.fee,
        });
        setSender(tx, step.sender);
        v2Steps.push({ Transaction: bytesToHex(tx.serializeBytes()) });
      } else if ('sender' in step && 'recipient' in step) {
        const nonce = await nextNonce(step.sender);
        const tx = await makeUnsignedSTXTokenTransfer({
          recipient: step.recipient,
          amount: step.amount,
          nonce,
          network,
          publicKey: '',
          fee: step.fee,
        });
        setSender(tx, step.sender);
        v2Steps.push({ Transaction: bytesToHex(tx.serializeBytes()) });
      } else if ('deployer' in step) {
        const nonce = await nextNonce(step.deployer);
        const tx = await makeUnsignedContractDeploy({
          contractName: step.contract_name,
          codeBody: step.source_code,
          nonce,
          network,
          publicKey: '',
          postConditionMode: PostConditionMode.Allow,
          fee: step.fee,
          clarityVersion: step.clarity_version,
        });
        setSender(tx, step.deployer);
        v2Steps.push({ Transaction: bytesToHex(tx.serializeBytes()) });
      } else if ('code' in step) {
        // Eval step - format: [sender, sponsor, contract_id, code]
        // For eval without a sender, we use empty string for sponsor
        const [contractAddress, contractName] = step.contract_id.split('.');
        v2Steps.push({
          Eval: [
            this.sender || contractAddress,
            '',
            `${contractAddress}.${contractName}`,
            step.code,
          ],
        });
      } else if (step.type === 'SetContractCode') {
        // SetContractCode - format: [contract_id, code, clarity_version]
        v2Steps.push({
          SetContractCode: [
            step.contract_id,
            step.source_code,
            clarityVersionToNumber(step.clarity_version),
          ],
        });
      } else if (step.type === 'Reads') {
        // Reads - batch read operations
        v2Steps.push({
          Reads: step.reads,
        });
      } else if (step.type === 'TenureExtend') {
        // TenureExtend - modern wire shape (legacy `[]` is still parsed
        // server-side for direct-emit consumers, but the builder always
        // emits the explicit cause).
        v2Steps.push({
          TenureExtend: { cause: step.cause },
        });
      } else if (step.type === 'AdvanceBlocks') {
        v2Steps.push({
          AdvanceBlocks: step.request,
        });
      } else {
        console.log(`Invalid simulation step: ${step}`);
      }
    }

    // Create V2 simulation session
    const simulationId = await createSimulationSession(
      {
        block_height: block.block_height,
        block_hash: block.block_hash,
        skip_tracing: this.skipTracing,
      },
      { stxerApi: this.apiEndpoint },
    );

    // Submit steps
    await submitSimulationSteps(
      simulationId,
      { steps: v2Steps },
      { stxerApi: this.apiEndpoint },
    );

    console.log(
      `Simulation will be available at: https://stxer.xyz/simulations/${this.network}/${simulationId}`,
    );
    return simulationId;
  }

  public pipe(
    transform: (builder: SimulationBuilder) => SimulationBuilder,
  ): SimulationBuilder {
    return transform(this);
  }
}

// Helper function to convert ClarityVersion to number
function clarityVersionToNumber(version: ClarityVersion): number {
  switch (version) {
    case ClarityVersion.Clarity1:
      return 1;
    case ClarityVersion.Clarity2:
      return 2;
    case ClarityVersion.Clarity3:
      return 3;
    case ClarityVersion.Clarity4:
      return 4;
    case ClarityVersion.Clarity5:
      return 5;
    default:
      return 5;
  }
}

// =============================================================================
// Session-bound helpers
// =============================================================================
//
// Higher-level helpers that bind to an existing simulation session.
// Wrap `submitSimulationSteps` / `simulationBatchReads` for the common
// patterns simulation tests reach for: read a fungible-token balance,
// read a principal's STX balance / nonce, send a contract call and
// decode the result.
//
// Errors:
//  - Wire-level failures (HTTP non-2xx) propagate as the typed
//    `SimulationError` from `./simulation-api`.
//  - Per-step `Err` results (validation failures) throw a normal
//    `Error` carrying the upstream message.
//  - VM-level failures (`vm_error`) and post-condition aborts are
//    returned via {@link CallContractResult.vmError} / `pcAborted` —
//    they do NOT throw, so callers can assert on them.

export interface CallContractResult {
  /** Decoded Clarity result (e.g. `(ok true)`, `(err u100)`, `u5`). */
  result: string;
  /** Hex-encoded raw Clarity result (SIP-005). */
  resultHex: string;
  /** VM-level error message, if any (e.g. arithmetic overflow). */
  vmError: string | null;
  /** True when one or more post-conditions tripped. */
  pcAborted: boolean;
  /** Full upstream receipt for callers that need more detail. */
  receipt: TransactionReceipt;
}

/**
 * Build, submit, and decode a contract-call transaction. The caller
 * supplies the principal to use as `tx-sender`; nonce is auto-fetched
 * via {@link getNonce} unless `nonce` is explicitly provided.
 */
export async function callContract(
  sessionId: string,
  args: Omit<ContractCallTxArgs, 'nonce'> & {
    nonce?: number;
    postConditionMode?: PostConditionMode;
  },
  options: SimulationApiOptions = {},
): Promise<CallContractResult> {
  const nonce =
    args.nonce ?? Number(await getNonce(sessionId, args.sender, options));
  const txHex = await buildUnsignedContractCallHex({ ...args, nonce });
  const r = await submitSimulationSteps(
    sessionId,
    { steps: [{ Transaction: txHex }] },
    options,
  );
  const step = r.steps[0];
  if (!('Transaction' in step)) {
    throw new Error(
      `expected Transaction step, got ${JSON.stringify(step).slice(0, 200)}`,
    );
  }
  if ('Err' in step.Transaction) {
    throw new Error(`Transaction Err: ${step.Transaction.Err}`);
  }
  const receipt = step.Transaction.Ok;
  return {
    result: cvToString(deserializeCV(receipt.result)),
    resultHex: receipt.result,
    vmError: receipt.vm_error,
    pcAborted: receipt.post_condition_aborted,
    receipt,
  };
}

/**
 * Read the SIP-010 / hBTC-style `(get-balance principal)` value.
 * Returns 0n if the read returns `(err …)`. Throws on infra failures.
 */
export async function getFtBalance(
  sessionId: string,
  contractId: string,
  principal: string,
  options: SimulationApiOptions = {},
): Promise<bigint> {
  const r = await simulationBatchReads(
    sessionId,
    {
      readonly: [
        [contractId, 'get-balance', serializeCV(Cl.principal(principal))],
      ],
    },
    options,
  );
  const v = r.readonly?.[0];
  if (!v || !('Ok' in v)) {
    throw new Error(`get-balance(${contractId}) failed: ${JSON.stringify(v)}`);
  }
  const decoded = deserializeCV(v.Ok);
  if (decoded.type === ClarityType.ResponseErr) {
    return 0n;
  }
  if (decoded.type !== ClarityType.ResponseOk) {
    throw new Error(`unexpected get-balance shape: ${cvToString(decoded)}`);
  }
  if (decoded.value.type !== ClarityType.UInt) {
    throw new Error(`expected uint inside (ok …), got ${decoded.value.type}`);
  }
  return BigInt(decoded.value.value);
}

/** Read a principal's STX balance (uSTX) from a simulation session. */
export async function getStxBalance(
  sessionId: string,
  principal: string,
  options: SimulationApiOptions = {},
): Promise<bigint> {
  const r = await simulationBatchReads(
    sessionId,
    { stx: [principal] },
    options,
  );
  const v = r.stx?.[0];
  if (!v || !('Ok' in v)) {
    throw new Error(`stx balance read for ${principal} failed`);
  }
  return BigInt(v.Ok);
}

/** Read a principal's current nonce. Returns 0n if never seen. */
export async function getNonce(
  sessionId: string,
  principal: string,
  options: SimulationApiOptions = {},
): Promise<bigint> {
  const r = await simulationBatchReads(
    sessionId,
    { nonces: [principal] },
    options,
  );
  const v = r.nonces?.[0];
  if (!v || !('Ok' in v)) return 0n;
  return BigInt(v.Ok);
}

/**
 * Read a Clarity data variable. Returns the decoded `ClarityValue`,
 * or throws if the read failed.
 */
export async function readDataVar(
  sessionId: string,
  contractId: string,
  varName: string,
  options: SimulationApiOptions = {},
): Promise<ClarityValue> {
  const r = await simulationBatchReads(
    sessionId,
    { vars: [[contractId, varName]] },
    options,
  );
  const v = r.vars?.[0];
  if (!v || !('Ok' in v)) {
    throw new Error(
      `var-get ${contractId} ${varName} failed: ${JSON.stringify(v)}`,
    );
  }
  return deserializeCV(v.Ok);
}

// Re-export simulation types
export type {
  CreateSimulationRequest,
  ExecutionCost,
  InstantSimulationRequest,
  InstantSimulationResponse,
  ReadResult,
  ReadStep,
  SimulationMetadata,
  SimulationResult,
  SimulationStepInput,
  TransactionReceipt,
} from './types';
