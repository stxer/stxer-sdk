import {
  AddressVersion,
  STACKS_MAINNET,
  STACKS_TESTNET,
  type StacksNetworkName,
} from '@stacks/network';
import type { Block } from '@stacks/stacks-blockchain-api-types';
import {
  AddressHashMode,
  bufferCV,
  type ClarityValue,
  ClarityVersion,
  contractPrincipalCV,
  deserializeTransaction,
  type MultiSigSpendingCondition,
  makeUnsignedContractCall,
  makeUnsignedContractDeploy,
  makeUnsignedSTXTokenTransfer,
  PostConditionMode,
  type StacksTransactionWire,
  serializeCVBytes,
  stringAsciiCV,
  tupleCV,
  uintCV,
} from '@stacks/transactions';
import { c32addressDecode } from 'c32check';
import { type AccountDataResponse, getNodeInfo, richFetch } from 'ts-clarity';

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

function runTx(tx: StacksTransactionWire) {
  // type 0: run transaction
  return tupleCV({ type: uintCV(0), data: bufferCV(tx.serializeBytes()) });
}

export interface SimulationEval {
  contract_id: string;
  code: string;
}

export function runEval({ contract_id, code }: SimulationEval) {
  const [contract_address, contract_name] = contract_id.split('.');
  // type 1: eval arbitrary code inside a contract
  return tupleCV({
    type: uintCV(1),
    data: bufferCV(
      serializeCVBytes(
        tupleCV({
          contract: contractPrincipalCV(contract_address, contract_name),
          code: stringAsciiCV(code),
        }),
      ),
    ),
  });
}

export async function runSimulation(
  apiEndpoint: string,
  block_hash: string,
  block_height: number,
  txs: (StacksTransactionWire | SimulationEval)[],
) {
  // Convert 'sim-v1' to Uint8Array
  const header = new TextEncoder().encode('sim-v1');
  // Create 8 bytes for block height
  const heightBytes = new Uint8Array(8);
  // Convert block height to bytes
  const view = new DataView(heightBytes.buffer);
  view.setBigUint64(0, BigInt(block_height), false); // false for big-endian

  // Convert block hash to bytes
  const hashHex = block_hash.startsWith('0x')
    ? block_hash.substring(2)
    : block_hash;
  // Replace non-null assertion with null check
  const matches = hashHex.match(/.{1,2}/g);
  if (!matches) {
    throw new Error('Invalid block hash format');
  }
  const hashBytes = new Uint8Array(
    matches.map((byte) => Number.parseInt(byte, 16)),
  );

  // Convert transactions to bytes
  const txBytes = txs
    .map((t) => ('contract_id' in t && 'code' in t ? runEval(t) : runTx(t)))
    .map((t) => serializeCVBytes(t));

  // Combine all byte arrays
  const totalLength =
    header.length +
    heightBytes.length +
    hashBytes.length +
    txBytes.reduce((acc, curr) => acc + curr.length, 0);
  const body = new Uint8Array(totalLength);

  let offset = 0;
  body.set(header, offset);
  offset += header.length;
  body.set(heightBytes, offset);
  offset += heightBytes.length;
  body.set(hashBytes, offset);
  offset += hashBytes.length;
  for (const tx of txBytes) {
    body.set(tx, offset);
    offset += tx.length;
  }

  const rs = await fetch(apiEndpoint, {
    method: 'POST',
    body,
  }).then(async (rs) => {
    const response = await rs.text();
    if (!response.startsWith('{')) {
      throw new Error(`failed to submit simulation: ${response}`);
    }
    return JSON.parse(response) as { id: string };
  });
  return rs.id;
}

interface SimulationBuilderOptions {
  apiEndpoint?: string;
  stacksNodeAPI?: string;
  network?: StacksNetworkName | string;
}

export class SimulationBuilder {
  private apiEndpoint: string;
  private stacksNodeAPI: string;
  private network: StacksNetworkName | string;

  private constructor(options: SimulationBuilderOptions = {}) {
    this.network = options.network ?? 'mainnet';
    const isTestnet = this.network === 'testnet';

    this.apiEndpoint =
      options.apiEndpoint ??
      (isTestnet ? 'https://testnet-api.stxer.xyz' : 'https://api.stxer.xyz');
    this.stacksNodeAPI =
      options.stacksNodeAPI ??
      (isTestnet ? 'https://api.testnet.hiro.so' : 'https://api.hiro.so');
  }

  public static new(options?: SimulationBuilderOptions) {
    return new SimulationBuilder(options);
  }

  // biome-ignore lint/style/useNumberNamespace: ignore this
  private block = NaN;
  private sender = '';
  private steps: (
    | {
        // inline simulation
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
      clarity_version: params.clarity_version ?? ClarityVersion.Clarity3,
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

  public async run() {
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
    const txs: (StacksTransactionWire | SimulationEval)[] = [];
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
        const previousSimulation: {
          steps: ({ tx: string } | { code: string; contract: string })[];
        } = await fetch(
          `https://api.stxer.xyz/simulations/${step.simulationId}/request`,
        ).then(async (rs) => {
          const body = await rs.text();
          if (!body.startsWith('{')) {
            throw new Error(
              `failed to get simulation ${step.simulationId}: ${body}`,
            );
          }
          return JSON.parse(body) as {
            steps: ({ tx: string } | { code: string; contract: string })[];
          };
        });
        for (const step of previousSimulation.steps) {
          if ('tx' in step) {
            txs.push(deserializeTransaction(step.tx));
          } else if ('code' in step && 'contract' in step) {
            txs.push({
              contract_id: step.contract,
              code: step.code,
            });
          }
        }
      } else if ('sender' in step && 'function_name' in step) {
        const nonce = await nextNonce(step.sender);
        const [contractAddress, contractName] = step.contract_id.split('.');
        const tx = await makeUnsignedContractCall({
          contractAddress,
          contractName,
          functionName: step.function_name,
          functionArgs: step.function_args ?? [],
          nonce,
          network,
          publicKey: '',
          postConditionMode: PostConditionMode.Allow,
          fee: step.fee,
        });
        setSender(tx, step.sender);
        txs.push(tx);
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
        txs.push(tx);
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
        });
        setSender(tx, step.deployer);
        txs.push(tx);
      } else if ('code' in step) {
        txs.push(step);
      } else {
        console.log(`Invalid simulation step: ${step}`);
      }
    }
    const id = await runSimulation(
      `${this.apiEndpoint}/simulations`,
      block.block_hash,
      block.block_height,
      txs,
    );
    console.log(
      `Simulation will be available at: https://stxer.xyz/simulations/${this.network}/${id}`,
    );
    return id;
  }

  public pipe(
    transform: (builder: SimulationBuilder) => SimulationBuilder,
  ): SimulationBuilder {
    return transform(this);
  }
}
