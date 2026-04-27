/**
 * Exercises every batch-read shape the SDK exposes:
 *
 *   - `simulationBatchReads(sessionId, ...)` against a v2 session covers
 *     all 8 categories (vars / maps / readonly / readonly_with_sender /
 *     stx / nonces / ft_balance / ft_supply). Demonstrates the labeled
 *     rest tuples for `readonly` / `readonly_with_sender`, the flat
 *     `ft_supply: string[]`, and defensive iteration over the optional
 *     response keys.
 *
 *   - `batchRead({ ... })` against the sidecar exposes
 *     `result.index_block_hash` (renamed from the previous SDK field
 *     `tip`, which was undefined on the wire and silently broken).
 */
import {
  contractPrincipalCV,
  principalCV,
  serializeCV,
  tupleCV,
  uintCV,
} from '@stacks/transactions';
import {
  batchRead,
  createSimulationSession,
  getTip,
  type ReadResult,
  simulationBatchReads,
} from '..';

// Mainnet fixtures.
const ALEX_TOKEN = 'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.token-alex';
const ALEX_VAULT = 'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.amm-vault-v2-01';
const ALEX_REGISTRY =
  'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.amm-registry-v2-01';
const SBTC_TOKEN = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
const HOLDER = 'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM';

// Shape of `pools-data-map` keys on ALEX_REGISTRY: { token-x, token-y, factor }.
const POOL_KEY = serializeCV(
  tupleCV({
    'token-x': principalCV(
      'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.token-wstx-v2',
    ),
    'token-y': principalCV(ALEX_TOKEN),
    factor: uintCV(1e8),
  }),
);

function describe(label: string, rs: ReadResult[] | undefined) {
  // Each category is optional on the wire — fold absent and empty to
  // the same output so callers don't need an extra null check.
  const items = (rs ?? []).map((r) => ('Ok' in r ? r.Ok : `Err: ${r.Err}`));
  console.log(
    `${label.padEnd(22)} ${items.length ? items.join(' | ') : '<absent>'}`,
  );
}

async function simulationBatchReadsExample() {
  const tip = await getTip();
  const simulationId = await createSimulationSession({
    block_height: tip.block_height,
    block_hash: tip.block_hash,
    skip_tracing: true,
  });

  const reads = await simulationBatchReads(simulationId, {
    // [contract_id, variable_name] per entry.
    vars: [[ALEX_VAULT, 'paused']],
    // [contract_id, map_name, key_hex] per entry.
    maps: [[ALEX_REGISTRY, 'pools-data-map', POOL_KEY]],
    // Labeled rest tuple: [contract_id, function_name, ...arg_hex].
    // First two slots are fixed; remaining slots are hex-encoded Clarity
    // values, one per function argument.
    readonly: [
      [ALEX_TOKEN, 'get-total-supply'],
      [ALEX_TOKEN, 'get-balance', serializeCV(principalCV(ALEX_VAULT))],
    ],
    // Labeled rest tuple: [sender, sponsor, contract_id, function_name, ...arg_hex].
    // `sponsor` is `""` when there is no sponsor.
    readonly_with_sender: [[HOLDER, '', ALEX_TOKEN, 'get-name']],
    stx: [HOLDER],
    nonces: [HOLDER],
    // Per-entry [<contract_id>::<token_name>, principal].
    ft_balance: [[`${ALEX_TOKEN}::alex`, ALEX_VAULT]],
    // Flat string[] of <contract_id>::<token_name> identifiers, one per
    // token to look up. Any length.
    ft_supply: [`${ALEX_TOKEN}::alex`, `${SBTC_TOKEN}::sbtc-token`],
  });

  console.log('--- simulationBatchReads ---');
  describe('vars:', reads.vars);
  describe('maps:', reads.maps);
  describe('readonly:', reads.readonly);
  describe('readonly_with_sender:', reads.readonly_with_sender);
  describe('stx:', reads.stx);
  describe('nonces:', reads.nonces);
  describe('ft_balance:', reads.ft_balance);
  describe('ft_supply:', reads.ft_supply);
}

async function sidecarBatchReadExample() {
  const result = await batchRead({
    variables: [
      {
        contract: contractPrincipalCV(
          'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM',
          'amm-vault-v2-01',
        ),
        variableName: 'paused',
      },
    ],
    maps: [
      {
        contract: contractPrincipalCV(
          'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM',
          'amm-registry-v2-01',
        ),
        mapName: 'pools-data-map',
        mapKey: tupleCV({
          'token-x': principalCV(
            'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.token-wstx-v2',
          ),
          'token-y': principalCV(ALEX_TOKEN),
          factor: uintCV(1e8),
        }),
      },
    ],
    readonly: [
      {
        contract: contractPrincipalCV(
          'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM',
          'token-alex',
        ),
        functionName: 'get-total-supply',
        functionArgs: [],
      },
    ],
  });

  console.log('--- batchRead (sidecar) ---');
  // result.index_block_hash matches the upstream wire field; used to be
  // exposed as `tip` and silently `undefined` before the SDK fix.
  console.log(`index_block_hash: ${result.index_block_hash || '<empty>'}`);
  console.log(`vars: ${result.vars.length}`);
  console.log(`maps: ${result.maps.length}`);
  console.log(`readonly: ${result.readonly.length}`);
}

async function main() {
  await simulationBatchReadsExample();
  await sidecarBatchReadExample();
}

if (require.main === module) {
  main().catch(console.error);
}
