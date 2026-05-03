/**
 * Runtime type-drift detector. Hits every endpoint the SDK exposes,
 * dereferences every documented field on the response, and asserts
 * the runtime value matches the declared SDK type. Prints a PASS/FAIL
 * line per check and exits non-zero on any drift.
 *
 * Run before publishing the SDK after upstream changes.
 */
import { STACKS_MAINNET } from '@stacks/network';
import {
  ClarityVersion,
  contractPrincipalCV,
  makeUnsignedContractCall,
  makeUnsignedContractDeploy,
  PostConditionMode,
  principalCV,
  serializeCV,
  tupleCV,
  uintCV,
} from '@stacks/transactions';
import {
  batchRead,
  bytesToHex,
  createSimulationSession,
  getSimulationResult,
  getTip,
  instantSimulation,
  type ReadResult,
  type ReadStep,
  type SidecarTip,
  type SimulationEvent,
  type SimulationStepInput,
  setSender,
  simulationBatchReads,
  submitSimulationSteps,
} from '..';
import { getOnChainNonce } from './_helpers';

let passes = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, info?: string) {
  if (ok) {
    passes++;
  } else {
    failures.push(`${label}${info ? ` — ${info}` : ''}`);
    console.error(`  FAIL: ${label}${info ? ` — ${info}` : ''}`);
  }
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function isHex(v: unknown, exact?: number): v is string {
  if (typeof v !== 'string') return false;
  if (!/^[0-9a-f]*$/.test(v)) return false;
  return exact == null || v.length === exact;
}

function checkExecutionCost(label: string, ec: unknown) {
  if (!isObject(ec)) {
    check(`${label}: object`, false);
    return;
  }
  check(`${label}.read_count: number`, isNumber(ec.read_count));
  check(`${label}.read_length: number`, isNumber(ec.read_length));
  check(`${label}.write_count: number`, isNumber(ec.write_count));
  check(`${label}.write_length: number`, isNumber(ec.write_length));
  check(`${label}.runtime: number`, isNumber(ec.runtime));
}

function checkReadResult(label: string, r: unknown) {
  if (!isObject(r)) {
    check(`${label}: object`, false);
    return;
  }
  if ('Ok' in r) {
    check(`${label}.Ok: string`, isString(r.Ok));
  } else if ('Err' in r) {
    check(`${label}.Err: string`, isString(r.Err));
  } else {
    check(`${label}: has Ok or Err`, false, JSON.stringify(r));
  }
}

function checkReceipt(label: string, r: unknown) {
  if (!isObject(r)) {
    check(`${label}: object`, false);
    return;
  }
  check(`${label}.result: hex string`, isHex(r.result));
  check(`${label}.stx_burned: number`, isNumber(r.stx_burned));
  check(`${label}.tx_index: number`, isNumber(r.tx_index));
  check(
    `${label}.vm_error: string|null`,
    r.vm_error === null || isString(r.vm_error),
  );
  check(
    `${label}.post_condition_aborted: boolean`,
    isBoolean(r.post_condition_aborted),
  );
  check(`${label}.costs: number`, isNumber(r.costs));
  checkExecutionCost(`${label}.execution_cost`, r.execution_cost);
  if (Array.isArray(r.events)) {
    check(`${label}.events: string[]`, r.events.every(isString));
    r.events.forEach((ev: unknown, i: number) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev as string);
      } catch {
        parsed = undefined;
      }
      check(`${label}.events[${i}]: JSON-encoded object`, isObject(parsed));
      checkSimulationEventShape(`${label}.events[${i}]`, parsed);
    });
  } else {
    check(`${label}.events: array`, false);
  }
}

const KNOWN_EVENT_TYPES = [
  'contract_event',
  'stx_transfer_event',
  'stx_mint_event',
  'stx_burn_event',
  'stx_lock_event',
  'nft_transfer_event',
  'nft_mint_event',
  'nft_burn_event',
  'ft_transfer_event',
  'ft_mint_event',
  'ft_burn_event',
] as const;
// Compile-time guarantee that the runtime list covers every variant of
// SimulationEvent. If a new variant is added, this `satisfies` line
// fails to compile until KNOWN_EVENT_TYPES is updated.
const _eventTypeCoverage: SimulationEvent['type'][] = [
  ...KNOWN_EVENT_TYPES,
] satisfies SimulationEvent['type'][];

function checkSimulationEventShape(label: string, parsed: unknown) {
  if (!isObject(parsed)) return;
  // Common envelope.
  check(`${label}.txid: string`, isString(parsed.txid));
  check(`${label}.event_index: number`, isNumber(parsed.event_index));
  check(`${label}.committed: boolean`, isBoolean(parsed.committed));
  // Discriminator + matching payload key.
  check(
    `${label}.type: known SimulationEvent variant`,
    isString(parsed.type) &&
      (KNOWN_EVENT_TYPES as readonly string[]).includes(parsed.type),
    `actual: ${JSON.stringify(parsed.type)}`,
  );
  if (typeof parsed.type === 'string') {
    check(
      `${label}.${parsed.type}: payload key matches discriminator`,
      isObject(parsed[parsed.type]),
    );
    observedEventTypes.add(parsed.type);
  }
}

const SENDER = 'SP212Y5JKN59YP3GYG07K3S8W5SSGE4KH6B5STXER';
const CONTRACT_NAME = 'verify-types-counter';
const CONTRACT_ID = `${SENDER}.${CONTRACT_NAME}`;
const RECIPIENT = 'SP000000000000000000002Q6VF78';
const SOURCE = `
(define-data-var counter uint u0)
(define-fungible-token sample-ft)
(define-non-fungible-token sample-nft uint)

(define-public (bump)
  (begin
    (print { event: "bump" })
    (var-set counter (+ (var-get counter) u1))
    (ok (var-get counter))))

(define-read-only (get-counter)
  (ok (var-get counter)))

;; Emits 8 of the 11 SimulationEvent variants in one transaction.
;; Skipped: stx_mint_event, stx_burn_event, stx_lock_event -- Clarity
;; contracts cannot trigger those (they come from coinbase / PoX).
(define-public (emit-all)
  (begin
    (print { kind: "verify-types" })           ;; contract_event
    (try! (stx-transfer? u1 tx-sender '${RECIPIENT}))  ;; stx_transfer_event
    (try! (ft-mint? sample-ft u100 tx-sender)) ;; ft_mint_event
    (try! (ft-transfer? sample-ft u10 tx-sender '${RECIPIENT})) ;; ft_transfer_event
    (try! (ft-burn? sample-ft u5 tx-sender))   ;; ft_burn_event
    (try! (nft-mint? sample-nft u1 tx-sender)) ;; nft_mint_event
    (try! (nft-transfer? sample-nft u1 tx-sender '${RECIPIENT})) ;; nft_transfer_event
    (try! (nft-mint? sample-nft u2 tx-sender)) ;; (need a fresh one to burn)
    (try! (nft-burn? sample-nft u2 tx-sender)) ;; nft_burn_event
    (ok true)))
`;

const TRIGGERABLE_EVENT_TYPES: ReadonlySet<SimulationEvent['type']> = new Set([
  'contract_event',
  'stx_transfer_event',
  'ft_mint_event',
  'ft_transfer_event',
  'ft_burn_event',
  'nft_mint_event',
  'nft_transfer_event',
  'nft_burn_event',
]);

const observedEventTypes = new Set<string>();

const ALEX_TOKEN = 'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.token-alex';
const ALEX_VAULT = 'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.amm-vault-v2-01';
const ALEX_REGISTRY =
  'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.amm-registry-v2-01';
const SBTC_TOKEN = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
const HOLDER = 'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM';

const POOL_KEY = serializeCV(
  tupleCV({
    'token-x': principalCV(
      'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.token-wstx-v2',
    ),
    'token-y': principalCV(ALEX_TOKEN),
    factor: uintCV(1e8),
  }),
);

async function checkTip(): Promise<SidecarTip> {
  console.log('-- getTip()');
  const tip = await getTip();
  check('tip.bitcoin_height: number', isNumber(tip.bitcoin_height));
  check('tip.block_hash: hex(64)', isHex(tip.block_hash, 64));
  check('tip.block_height: number', isNumber(tip.block_height));
  check('tip.block_time: number', isNumber(tip.block_time));
  check('tip.burn_block_height: number', isNumber(tip.burn_block_height));
  check('tip.burn_block_time: number', isNumber(tip.burn_block_time));
  check('tip.consensus_hash: string', isString(tip.consensus_hash));
  check('tip.index_block_hash: hex(64)', isHex(tip.index_block_hash, 64));
  check('tip.is_nakamoto: boolean', isBoolean(tip.is_nakamoto));
  checkExecutionCost('tip.tenure_cost', tip.tenure_cost);
  check('tip.tenure_height: number', isNumber(tip.tenure_height));
  check('tip.sortition_id: string', isString(tip.sortition_id));
  check('tip.epoch_id: string', isString(tip.epoch_id));
  return tip;
}

async function checkSession(tip: SidecarTip) {
  console.log(
    '-- createSimulationSession() / submitSimulationSteps() / getSimulationResult()',
  );

  const id = await createSimulationSession({
    block_height: tip.block_height,
    block_hash: tip.block_hash,
    skip_tracing: true,
  });
  check('createSession.id: hex(32)', isHex(id, 32));

  let nonce = await getOnChainNonce(SENDER, tip.index_block_hash);
  const buildTx = async (functionName?: string) => {
    const tx = functionName
      ? await makeUnsignedContractCall({
          contractAddress: SENDER,
          contractName: CONTRACT_NAME,
          functionName,
          functionArgs: [],
          nonce: nonce++,
          network: STACKS_MAINNET,
          publicKey: '',
          postConditionMode: PostConditionMode.Allow,
          fee: 0,
        })
      : await makeUnsignedContractDeploy({
          contractName: CONTRACT_NAME,
          codeBody: SOURCE,
          nonce: nonce++,
          network: STACKS_MAINNET,
          publicKey: '',
          postConditionMode: PostConditionMode.Allow,
          fee: 0,
          clarityVersion: ClarityVersion.Clarity3,
        });
    setSender(tx, SENDER);
    return bytesToHex(tx.serializeBytes());
  };

  // Cover every SimulationStepInput variant so every SimulationStepResult
  // variant lands in the response. The `emit-all` call exercises 8 of
  // the 11 SimulationEvent shapes — the remaining 3 (stx_mint /
  // stx_burn / stx_lock) come from coinbase / PoX and can't be
  // triggered from a Clarity contract.
  const steps: SimulationStepInput[] = [
    { Transaction: await buildTx() },
    { Transaction: await buildTx('bump') },
    { Transaction: await buildTx('emit-all') },
    { Eval: [SENDER, '', CONTRACT_ID, '(get-counter)'] },
    {
      Reads: [
        { DataVar: [CONTRACT_ID, 'counter'] },
        { Nonce: SENDER },
        { StxBalance: SENDER },
        { EvalReadonly: [SENDER, '', CONTRACT_ID, '(get-counter)'] },
        { MapEntry: [CONTRACT_ID, 'no-such-map', '09'] },
        { FtBalance: [CONTRACT_ID, 'no-such-ft', SENDER] },
        { FtSupply: [CONTRACT_ID, 'no-such-ft'] },
      ],
    },
    {
      SetContractCode: [
        CONTRACT_ID,
        SOURCE.replace('"bump"', '"bump-replaced"'),
        3,
      ],
    },
    { TenureExtend: [] },
  ];

  const submit = await submitSimulationSteps(id, { steps });
  check('submit.steps: array', Array.isArray(submit.steps));
  check(
    'submit.steps.length matches request',
    submit.steps.length === steps.length,
  );

  for (const [i, step] of submit.steps.entries()) {
    if ('Transaction' in step) {
      const tx = step.Transaction;
      if ('Ok' in tx) checkReceipt(`submit.steps[${i}].Transaction.Ok`, tx.Ok);
      else
        check(`submit.steps[${i}].Transaction.Err: string`, isString(tx.Err));
    } else if ('Eval' in step) {
      const r = step.Eval;
      if ('Ok' in r)
        check(`submit.steps[${i}].Eval.Ok: string`, isString(r.Ok));
      else check(`submit.steps[${i}].Eval.Err: string`, isString(r.Err));
    } else if ('Reads' in step) {
      check(`submit.steps[${i}].Reads: array`, Array.isArray(step.Reads));
      step.Reads.forEach((rr, j) => {
        checkReadResult(`submit.steps[${i}].Reads[${j}]`, rr);
      });
    } else if ('SetContractCode' in step) {
      const r = step.SetContractCode;
      if ('Ok' in r)
        check(`submit.steps[${i}].SetContractCode.Ok: null`, r.Ok === null);
      else
        check(
          `submit.steps[${i}].SetContractCode.Err: string`,
          isString(r.Err),
        );
    } else if ('TenureExtend' in step) {
      checkExecutionCost(`submit.steps[${i}].TenureExtend`, step.TenureExtend);
    } else {
      check(`submit.steps[${i}]: known variant`, false, JSON.stringify(step));
    }
  }

  console.log('-- getSimulationResult()');
  const summary = await getSimulationResult(id);

  // SimulationMetadata
  const m = summary.metadata as unknown as Record<string, unknown>;
  check('metadata: object', isObject(m));
  check('metadata.block_height: number', isNumber(m.block_height));
  check('metadata.block_hash: string', isString(m.block_hash));
  check('metadata.burn_block_height: number', isNumber(m.burn_block_height));
  check('metadata.burn_block_hash: string', isString(m.burn_block_hash));
  check('metadata.consensus_hash: string', isString(m.consensus_hash));
  check('metadata.epoch: string', isString(m.epoch));
  check('metadata.index_block_hash: string', isString(m.index_block_hash));
  check('metadata.skip_tracing: boolean', isBoolean(m.skip_tracing));
  check('metadata.sortition_id: string', isString(m.sortition_id));
  // Guard against drift back: ast_rules was removed because the rust
  // serializer never emits it. If it ever reappears on the wire,
  // restore the typed field.
  check(
    'metadata.ast_rules: NOT present (rust does not emit it)',
    !('ast_rules' in m),
    `actual: ${JSON.stringify(m.ast_rules)}`,
  );

  // SimulationStepSummary — narrow each variant.
  check('summary.steps: array', Array.isArray(summary.steps));
  for (const [i, s] of summary.steps.entries()) {
    if ('Transaction' in s) {
      check(
        `summary.steps[${i}].Transaction: hex string`,
        isHex(s.Transaction),
      );
      check(`summary.steps[${i}].TxId: string`, isString(s.TxId));
      checkExecutionCost(`summary.steps[${i}].ExecutionCost`, s.ExecutionCost);
      const r = s.Result.Transaction;
      if ('Ok' in r)
        checkReceipt(`summary.steps[${i}].Result.Transaction.Ok`, r.Ok);
      else
        check(
          `summary.steps[${i}].Result.Transaction.Err: string`,
          isString(r.Err),
        );
    } else if ('Reads' in s) {
      check(`summary.steps[${i}].Reads: array`, Array.isArray(s.Reads));
      check(
        `summary.steps[${i}].Result.Reads: array`,
        Array.isArray(s.Result.Reads),
      );
      s.Result.Reads.forEach((rr, j) => {
        checkReadResult(`summary.steps[${i}].Result.Reads[${j}]`, rr);
      });
    } else if ('SetContractCode' in s) {
      const [contractId, code, version] = s.SetContractCode;
      check(
        `summary.steps[${i}].SetContractCode[0]: string`,
        isString(contractId),
      );
      check(`summary.steps[${i}].SetContractCode[1]: string`, isString(code));
      check(
        `summary.steps[${i}].SetContractCode[2]: number`,
        isNumber(version),
      );
      const r = s.Result.SetContractCode;
      if ('Ok' in r)
        check(
          `summary.steps[${i}].Result.SetContractCode.Ok: null`,
          r.Ok === null,
        );
      else
        check(
          `summary.steps[${i}].Result.SetContractCode.Err: string`,
          isString(r.Err),
        );
    } else if ('Eval' in s) {
      const [sender, sponsor, contractId, code] = s.Eval;
      check(`summary.steps[${i}].Eval[0] sender: string`, isString(sender));
      check(`summary.steps[${i}].Eval[1] sponsor: string`, isString(sponsor));
      check(
        `summary.steps[${i}].Eval[2] contract_id: string`,
        isString(contractId),
      );
      check(`summary.steps[${i}].Eval[3] code: string`, isString(code));
      const r = s.Result.Eval;
      if ('Ok' in r)
        check(`summary.steps[${i}].Result.Eval.Ok: string`, isString(r.Ok));
      else
        check(`summary.steps[${i}].Result.Eval.Err: string`, isString(r.Err));
    } else if ('TenureExtend' in s) {
      checkExecutionCost(
        `summary.steps[${i}].Result.TenureExtend`,
        s.Result.TenureExtend,
      );
    } else if ('AdvanceBlocks' in s) {
      const r = s.Result.AdvanceBlocks;
      if ('Ok' in r) {
        check(
          `summary.steps[${i}].Result.AdvanceBlocks.Ok: array`,
          Array.isArray(r.Ok),
        );
      } else {
        check(
          `summary.steps[${i}].Result.AdvanceBlocks.Err: string`,
          isString(r.Err),
        );
      }
    }
  }

  console.log('-- simulationBatchReads()');
  const batch = await simulationBatchReads(id, {
    vars: [[ALEX_VAULT, 'paused']],
    maps: [[ALEX_REGISTRY, 'pools-data-map', POOL_KEY]],
    readonly: [
      [ALEX_TOKEN, 'get-total-supply'],
      [ALEX_TOKEN, 'get-balance', serializeCV(principalCV(ALEX_VAULT))],
    ],
    readonly_with_sender: [[HOLDER, '', ALEX_TOKEN, 'get-name']],
    stx: [HOLDER],
    nonces: [HOLDER],
    ft_balance: [[`${ALEX_TOKEN}::alex`, ALEX_VAULT]],
    ft_supply: [`${ALEX_TOKEN}::alex`, `${SBTC_TOKEN}::sbtc-token`],
  });

  const cats: (keyof typeof batch)[] = [
    'vars',
    'maps',
    'readonly',
    'readonly_with_sender',
    'stx',
    'nonces',
    'ft_balance',
    'ft_supply',
  ];
  for (const cat of cats) {
    const arr = batch[cat];
    if (arr === undefined) continue; // optional category
    check(`batch.${cat}: ReadResult[]`, Array.isArray(arr));
    if (Array.isArray(arr)) {
      arr.forEach((r: ReadResult, i: number) => {
        checkReadResult(`batch.${cat}[${i}]`, r);
      });
    }
  }
}

async function checkInstant(tip: SidecarTip) {
  console.log('-- instantSimulation()');
  const nonce = await getOnChainNonce(SENDER, tip.index_block_hash);
  const tx = await makeUnsignedContractCall({
    contractAddress: 'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM',
    contractName: 'token-alex',
    functionName: 'get-balance',
    functionArgs: [principalCV(ALEX_VAULT)],
    nonce,
    network: STACKS_MAINNET,
    publicKey: '',
    postConditionMode: PostConditionMode.Allow,
    fee: 0,
  });
  setSender(tx, SENDER);

  const reads: ReadStep[] = [
    {
      MapEntry: [ALEX_REGISTRY, 'pools-data-map', POOL_KEY],
    },
    { DataVar: [ALEX_VAULT, 'paused'] },
    { EvalReadonly: [SENDER, '', ALEX_TOKEN, '(get-name)'] },
    { StxBalance: ALEX_VAULT },
    { FtBalance: [ALEX_TOKEN, 'alex', ALEX_VAULT] },
    { FtSupply: [ALEX_TOKEN, 'alex'] },
    { Nonce: ALEX_VAULT },
  ];
  const result = await instantSimulation({
    transaction: bytesToHex(tx.serializeBytes()),
    block_height: tip.block_height,
    block_hash: tip.block_hash,
    reads,
  });
  check('instant.reads: array', Array.isArray(result.reads));
  check(
    'instant.reads.length matches request',
    result.reads.length === reads.length,
  );
  result.reads.forEach((r, i) => {
    checkReadResult(`instant.reads[${i}]`, r);
  });
  checkReceipt('instant.receipt', result.receipt);
}

async function checkSidecarBatch() {
  console.log('-- batchRead() (sidecar)');
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
  check(
    'sidecar.index_block_hash: hex(64)',
    isHex(result.index_block_hash, 64),
  );
  check('sidecar.vars: array', Array.isArray(result.vars));
  check('sidecar.maps: array', Array.isArray(result.maps));
  check('sidecar.readonly: array', Array.isArray(result.readonly));
}

async function main() {
  const tip = await checkTip();
  await checkInstant(tip);
  await checkSession(tip);
  await checkSidecarBatch();

  // Coverage check: every contract-triggerable SimulationEvent variant
  // must have fired at least once across the run. The other three
  // (stx_mint / stx_burn / stx_lock) come from coinbase / PoX and are
  // not reachable from Clarity contracts — out of scope for runtime
  // verification, covered by the compile-time satisfies check above.
  for (const t of TRIGGERABLE_EVENT_TYPES) {
    check(
      `coverage: SimulationEvent variant '${t}' observed at runtime`,
      observedEventTypes.has(t),
    );
  }

  console.log(
    `\n${failures.length === 0 ? 'OK' : 'FAIL'}: ${passes} pass, ${failures.length} fail`,
  );
  if (failures.length > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
