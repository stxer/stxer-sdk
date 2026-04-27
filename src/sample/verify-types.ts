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
  createSimulationSession,
  getSimulationResult,
  getTip,
  instantSimulation,
  type ReadResult,
  type ReadStep,
  type SidecarTip,
  type SimulationStepInput,
  simulationBatchReads,
  submitSimulationSteps,
} from '..';
import { bytesToHex, getNonce, setSender } from './_helpers';

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
    });
  } else {
    check(`${label}.events: array`, false);
  }
}

const SENDER = 'SP212Y5JKN59YP3GYG07K3S8W5SSGE4KH6B5STXER';
const CONTRACT_NAME = 'verify-types-counter';
const CONTRACT_ID = `${SENDER}.${CONTRACT_NAME}`;
const SOURCE = `
(define-data-var counter uint u0)
(define-public (bump)
  (begin
    (print { event: "bump" })
    (var-set counter (+ (var-get counter) u1))
    (ok (var-get counter))))
(define-read-only (get-counter)
  (ok (var-get counter)))
`;

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

  let nonce = await getNonce(SENDER, tip.index_block_hash);
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
  // variant lands in the response.
  const steps: SimulationStepInput[] = [
    { Transaction: await buildTx() },
    { Transaction: await buildTx('bump') },
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
    } else {
      // TenureExtendStepSummary — only Result present.
      checkExecutionCost(
        `summary.steps[${i}].Result.TenureExtend`,
        s.Result.TenureExtend,
      );
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
  const nonce = await getNonce(SENDER, tip.index_block_hash);
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
  check('sidecar.tip: hex(64)', isHex(result.tip, 64));
  check('sidecar.vars: array', Array.isArray(result.vars));
  check('sidecar.maps: array', Array.isArray(result.maps));
  check('sidecar.readonly: array', Array.isArray(result.readonly));
}

async function main() {
  const tip = await checkTip();
  await checkInstant(tip);
  await checkSession(tip);
  await checkSidecarBatch();

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
