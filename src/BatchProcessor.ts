/**
 * WARNING:
 *
 * this file will be used in cross-runtime environments (browser, cloudflare workers, XLinkSDK, etc.),
 * so please be careful when adding `import`s to it.
 */

import {
  type ClarityValue,
  contractPrincipalCV,
  type OptionalCV,
} from '@stacks/transactions';
import { type BatchReads, batchRead } from './BatchAPI';

export interface ReadOnlyRequest {
  mode: 'readonly';
  contractAddress: string;
  contractName: string;
  functionName: string;
  functionArgs: ClarityValue[];
}

export interface MapEntryRequest {
  mode: 'mapEntry';
  contractAddress: string;
  contractName: string;
  mapName: string;
  mapKey: ClarityValue;
}

export interface VariableRequest {
  mode: 'variable';
  contractAddress: string;
  contractName: string;
  variableName: string;
}

export type BatchRequest = MapEntryRequest | VariableRequest | ReadOnlyRequest;

export interface QueuedRequest {
  request: BatchRequest;
  tip?: string;
  resolve: (value: ClarityValue | OptionalCV) => void;
  reject: (error: Error) => void;
}

export class BatchProcessor {
  private queues = new Map<string, QueuedRequest[]>();
  private timeoutIds = new Map<string, ReturnType<typeof setTimeout>>();

  private readonly stxerAPIEndpoint: string;
  private readonly batchDelayMs: number;

  constructor(options: { stxerAPIEndpoint?: string; batchDelayMs: number }) {
    this.stxerAPIEndpoint = options.stxerAPIEndpoint ?? 'https://api.stxer.xyz';
    this.batchDelayMs = options.batchDelayMs;
  }

  private getQueueKey(tip?: string): string {
    return tip ?? '_undefined';
  }

  read(request: BatchRequest): Promise<ClarityValue | OptionalCV> {
    return new Promise((resolve, reject) => {
      this.enqueue({ request, resolve, reject });
    });
  }

  enqueue(request: QueuedRequest): void {
    const queueKey = this.getQueueKey(request.tip);

    const queue = this.queues.get(queueKey) ?? [];
    if (!this.queues.has(queueKey)) {
      this.queues.set(queueKey, queue);
    }
    queue.push(request);

    if (!this.timeoutIds.has(queueKey)) {
      const timeoutId = setTimeout(
        () => this.processBatch(queueKey),
        this.batchDelayMs,
      );
      this.timeoutIds.set(queueKey, timeoutId);
    }
  }

  private async processBatch(queueKey: string): Promise<void> {
    const currentQueue = this.queues.get(queueKey) ?? [];
    this.queues.delete(queueKey);

    const timeoutId = this.timeoutIds.get(queueKey);
    if (timeoutId) {
      clearTimeout(timeoutId);
      this.timeoutIds.delete(queueKey);
    }

    if (currentQueue.length === 0) return;

    try {
      const readonlyRequests = currentQueue.filter(
        (q): q is QueuedRequest & { request: ReadOnlyRequest } =>
          q.request.mode === 'readonly',
      );
      const mapRequests = currentQueue.filter(
        (q): q is QueuedRequest & { request: MapEntryRequest } =>
          q.request.mode === 'mapEntry',
      );
      const variableRequests = currentQueue.filter(
        (q): q is QueuedRequest & { request: VariableRequest } =>
          q.request.mode === 'variable',
      );

      const tip = queueKey === '_undefined' ? undefined : queueKey;

      const batchRequest: BatchReads = {
        readonly: readonlyRequests.map(({ request }) => ({
          contract: contractPrincipalCV(
            request.contractAddress,
            request.contractName,
          ),
          functionName: request.functionName,
          functionArgs: request.functionArgs,
        })),
        maps: mapRequests.map(({ request }) => ({
          contract: contractPrincipalCV(
            request.contractAddress,
            request.contractName,
          ),
          mapName: request.mapName,
          mapKey: request.mapKey,
        })),
        variables: variableRequests.map(({ request }) => ({
          contract: contractPrincipalCV(
            request.contractAddress,
            request.contractName,
          ),
          variableName: request.variableName,
        })),
        index_block_hash: tip,
      };

      const results = await batchRead(batchRequest, {
        stxerApi: this.stxerAPIEndpoint,
      });

      // Handle readonly results
      for (const [index, result] of results.readonly.entries()) {
        if (result instanceof Error) {
          readonlyRequests[index].reject(result);
        } else {
          readonlyRequests[index].resolve(result);
        }
      }

      // Handle variable results
      for (const [index, result] of results.vars.entries()) {
        if (result instanceof Error) {
          variableRequests[index].reject(result);
        } else {
          variableRequests[index].resolve(result);
        }
      }

      // Handle map results
      for (const [index, result] of results.maps.entries()) {
        if (result instanceof Error) {
          mapRequests[index].reject(result);
        } else {
          mapRequests[index].resolve(result);
        }
      }
    } catch (error) {
      for (const item of currentQueue) {
        item.reject(error as Error);
      }
    }
  }
}
