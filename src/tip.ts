/**
 * WARNING:
 *
 * this file will be used in cross-runtime environments (browser, cloudflare workers, XLinkSDK, etc.),
 * so please be careful when adding `import`s to it.
 */

import { DEFAULT_STXER_API } from './constants';
import type { SidecarTip } from './types';

export interface TipOptions {
  stxerApi?: string;
}

/**
 * Fetch the current tip information from the sidecar.
 * @param options - Optional API endpoint configuration
 * @returns The current chain tip information
 */
export async function getTip(options: TipOptions = {}): Promise<SidecarTip> {
  const url = `${options.stxerApi ?? DEFAULT_STXER_API}/sidecar/tip`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch tip: ${response.status} ${response.statusText}`,
    );
  }

  const text = await response.text();
  if (!text.startsWith('{')) {
    throw new Error(`Invalid response from tip endpoint: ${text}`);
  }

  return JSON.parse(text) as SidecarTip;
}
