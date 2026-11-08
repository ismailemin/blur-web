// Case runner and outcome taxonomy for the ROBUST1 harness.
//
// A case declares the contract it exercises and whether the input must be
// rejected. The runner records what actually happened:
//
//   detected-typed     a typed rejection (ChunkLoadError / NetError / validator
//                      result / PropManifestError / MpMapError)
//   detected-untyped   an explicit Error without a code (loud, but not
//                      machine-readable and usually without a location)
//   crash              TypeError / RangeError / SyntaxError / ReferenceError
//                      (a console exception, the blank-page failure mode)
//   silent-accepted    the invalid input was accepted (a bug)
//   accepted-ok        a valid input was accepted
//   over-strict        a valid input was rejected (a bug in the other direction)

export class ValidationRejection extends Error {
  constructor(errors, label = 'validation') {
    const list = Array.isArray(errors) ? errors : [String(errors)];
    super(label + ': ' + list.join('; '));
    this.name = 'ValidationRejection';
    this.code = 'VALIDATOR_REJECTED';
    this.errors = list;
  }
}

/** Turn a `{ok, errors}` validator result into a rejection or a pass. */
export function rejectOnErrors(result, label) {
  if (!result || result.ok !== true) throw new ValidationRejection(result?.errors ?? ['no result'], label);
  return result;
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const CRASH_NAMES = new Set(['TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError']);

export async function runCase(definition) {
  const started = process.hrtime.bigint();
  const base = {
    id: definition.id,
    group: definition.group,
    input: definition.input,
    stage: definition.stage,
    description: definition.description,
    expected: definition.expected,
    impact: definition.impact ?? 1,
    remediation: definition.remediation ?? null,
    evidence: definition.evidence ?? null
  };
  try {
    const value = await definition.run();
    return {
      ...base,
      outcome: definition.expected === 'accept' ? 'accepted-ok' : 'silent-accepted',
      category: definition.expected === 'accept' ? 'ok' : 'silent',
      error: null,
      code: null,
      detail: value === undefined ? null : value,
      ms: Number(process.hrtime.bigint() - started) / 1e6
    };
  } catch (error) {
    const name = error?.name ?? 'Error';
    const code = typeof error?.code === 'string' ? error.code : null;
    let category;
    if (name === 'ValidationRejection') category = 'detected-typed';
    else if (typeof error?.code === 'string') category = 'detected-typed';
    else if (CRASH_NAMES.has(name)) category = 'crash';
    else category = 'detected-untyped';
    if (definition.expected === 'accept') category = 'over-strict';
    return {
      ...base,
      outcome: category,
      category,
      error: String(error?.message ?? error),
      code,
      errorName: name,
      detail: error?.errors ?? null,
      ms: Number(process.hrtime.bigint() - started) / 1e6
    };
  }
}

/** Risk score used to rank findings; silent > crash > over-strict. */
export function riskScore(row) {
  const weight = row.category === 'silent' ? 2 : row.category === 'crash' ? 1.6 : row.category === 'over-strict' ? 1 : 0;
  return Number(((row.impact ?? 1) * weight).toFixed(2));
}

export function summarise(rows) {
  const counts = {
    total: rows.length,
    ok: 0,
    detectedTyped: 0,
    detectedUntyped: 0,
    silent: 0,
    crash: 0,
    overStrict: 0
  };
  for (const row of rows) {
    if (row.category === 'ok') counts.ok++;
    else if (row.category === 'detected-typed') counts.detectedTyped++;
    else if (row.category === 'detected-untyped') counts.detectedUntyped++;
    else if (row.category === 'silent') counts.silent++;
    else if (row.category === 'crash') counts.crash++;
    else if (row.category === 'over-strict') counts.overStrict++;
  }
  return counts;
}

export function rankFindings(rows) {
  return rows
    .filter((row) => row.category === 'silent' || row.category === 'crash' || row.category === 'over-strict')
    .map((row) => ({ ...row, risk: riskScore(row) }))
    .sort((a, b) => b.risk - a.risk || a.id.localeCompare(b.id));
}
