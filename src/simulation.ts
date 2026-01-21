import {
  AddressVersion,
  STACKS_MAINNET,
  STACKS_TESTNET,
  type StacksNetworkName,
} from '@stacks/network';
import type { Block } from '@stacks/stacks-blockchain-api-types';
import {
  AddressHashMode,
  type ClarityValue,
  ClarityVersion,
  type MultiSigSpendingCondition,
  makeUnsignedContractCall,
  makeUnsignedContractDeploy,
  makeUnsignedSTXTokenTransfer,
  PostConditionMode,
  type StacksTransactionWire,
} from '@stacks/transactions';
import { c32addressDecode } from 'c32check';
import { type AccountDataResponse, getNodeInfo, richFetch } from 'ts-clarity';
import { STXER_API_MAINNET, STXER_API_TESTNET } from './constants';
import {
  createSimulationSession,
  submitSimulationSteps,
} from './simulation-api';
import type { ReadStep, SimulationStepInput } from './types';

function setSender(tx: StacksTransactionWire, sender: string) {
  const [addressVersion, signer] = c32addressDecode(sender);
  switch (addressVersion) {
    case AddressVersion.MainnetSingleSig:
    case AddressVersion.TestnetSingleSig:
      tx.auth.spendingCondition.hashMode = AddressHashMode.P2PKH;
      tx.auth.spendingCondition.signer = signer;
      break;
    case AddressVersion.MainnetMultiSig:
    case AddressVersion.TestnetMultiSig: {
      const sc = tx.auth.spendingCondition;
      tx.auth.spendingCondition = {
        hashMode: AddressHashMode.P2SH,
        signer,
        fields: [],
        signaturesRequired: 0,
        nonce: sc.nonce,
        fee: sc.fee,
      } as MultiSigSpendingCondition;
      break;
    }
  }
  return tx;
}

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

  // biome-ignore lint/style/useNumberNamespace: ignore this
  private block = NaN;
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
      clarity_version: params.clarity_version ?? ClarityVersion.Clarity4,
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
      clarity_version: params.clarity_version ?? ClarityVersion.Clarity4,
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

  public addTenureExtend() {
    this.steps.push({
      type: 'TenureExtend',
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
        // TenureExtend - format: []
        v2Steps.push({
          TenureExtend: [],
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

// Helper function to convert Uint8Array to hex string
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
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
    default:
      return 4;
  }
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
