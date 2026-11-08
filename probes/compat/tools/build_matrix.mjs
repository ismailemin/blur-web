// Build the browser support matrix from the recorded capability evidence.
//
// The matrix is a pure function of the recorded files plus the committed
// requirement/vendor models: no clock, no unordered iteration, no version that
// was not measured or cited. Running it twice must produce the same bytes; the
// verifier checks that.
//
// Output: _work/compat/compat-matrix.json (+ .hash), not committed.
// Usage:  node probes/compat/tools/build_matrix.mjs

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const OUT = path.join(ROOT, '_work/compat');
const CAPS = path.join(OUT, 'capabilities');

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
}

export function sha256Text(text) {
  return 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex');
}

const ORIGIN_FAIL_API = 'isSecureContext → navigator.gpu, crypto.subtle';
const MESSAGES = {
  noWebGPU: 'WebGPU is not available in this browser. Use Microsoft Edge/Google Chrome/Brave 113 or newer on Windows, or Firefox 141 or newer on Windows. On macOS use Safari 26+ on macOS 26 Tahoe, or Chrome/Edge 113+.',
  insecureOrigin: 'This page is open over a plain-HTTP address that browsers do not trust. WebGPU and crypto.subtle are only available on https:// or on http://127.0.0.1 / http://localhost. Open the game on the host machine at http://127.0.0.1:8801, or serve it over HTTPS.',
  limits: 'This GPU reports limits below what this slice needs (see requiredLimits). The page cannot upload its geometry. A different GPU/driver or a desktop browser with hardware acceleration enabled is required.',
  boot: 'The page started but did not reach the first rendered tick. The error text below is the exact page error; report it with browser version and GPU.',
  latency: null
};

const MESSAGES_LINUX = 'WebGPU on Linux depends on the GPU driver and, before Chromium 144, is disabled by default. Start the browser with --enable-unsafe-webgpu (older builds) or use a driver/browser combination where chrome://gpu reports WebGPU as hardware accelerated. Windows or macOS is the safer choice for this slice.';

function engineOf(capability) {
  const brands = capability.uaData?.brands ?? [];
  const chromium = brands.find((brand) => brand.brand === 'Chromium');
  const brand = brands.find((brand) => !['Not-A.Brand', 'Chromium'].includes(brand.brand)) ?? null;
  return {
    brand: brand ? brand.brand : null,
    brandVersion: brand ? brand.version : null,
    chromiumVersion: chromium ? chromium.version : null,
    engine: chromium ? 'Chromium' : (brand ? brand.brand : null),
    ua: capability.ua,
    platform: capability.uaData?.platform ?? capability.platform ?? null
  };
}

function chooseRepresentative(runs) {
  const score = (run) => {
    if (run.headless === false) return 0;
    if (run.flags.length === 0) return 1;
    return 2;
  };
  return [...runs].sort((a, b) => score(a) - score(b) || a.id.localeCompare(b.id))[0];
}

function statusForLoopback(record) {
  const capability = record.capability;
  const boot = record.boot;
  if (!capability || capability.fatal) {
    return { status: 'unsupported', failApi: 'capability probe', userMessage: MESSAGES.noWebGPU, detail: capability?.error ?? 'capability page failed' };
  }
  if (!capability.secureContext) {
    return { status: 'unsupported', failApi: ORIGIN_FAIL_API, userMessage: MESSAGES.insecureOrigin, detail: 'isSecureContext is false' };
  }
  if (!capability.webgpu.present) {
    return { status: 'unsupported', failApi: 'navigator.gpu', userMessage: MESSAGES.noWebGPU, detail: capability.webgpu.error ?? 'navigator.gpu is undefined' };
  }
  if (capability.webgpu.error) {
    return { status: 'unsupported', failApi: 'GPUAdapter.requestDevice()', userMessage: MESSAGES.noWebGPU, detail: capability.webgpu.error };
  }
  if (capability.requirements && capability.requirements.ok === false) {
    const failures = capability.requirements.failures || [];
    return { status: 'partial', failApi: 'required GPU limits', userMessage: MESSAGES.limits, detail: failures.join('; ') };
  }
  if (!boot || !boot.reached) {
    return { status: 'unsupported', failApi: 'first rendered tick', userMessage: MESSAGES.boot, detail: boot?.failure ?? 'no boot record' };
  }
  if ((boot.consoleErrors ?? 0) > 0) {
    return { status: 'partial', failApi: 'console error', userMessage: MESSAGES.console, detail: (boot.messages || []).filter((m) => /error|exception/.test(m.source)).map((m) => m.text).join(' | ') };
  }
  return { status: 'supported', failApi: null, userMessage: null, detail: null };
}

function statusForLan(record) {
  const capability = record.lanCapability;
  const boot = record.lanBoot;
  if (!capability) return { status: 'unsupported', failApi: ORIGIN_FAIL_API, userMessage: MESSAGES.insecureOrigin, detail: 'no LAN capability record' };
  if (capability.secureContext) {
    return { status: 'supported', failApi: null, userMessage: null, detail: 'secure context' };
  }
  const detail = boot?.errorText || capability.webgpu?.error || capability.errors?.join('; ') || 'insecure origin';
  return { status: 'unsupported', failApi: ORIGIN_FAIL_API, userMessage: MESSAGES.insecureOrigin, detail };
}

export function buildMatrix() {
  const requirements = readJson(path.join(ROOT, 'probes/compat/reference/requirements.json'));
  const vendor = readJson(path.join(ROOT, 'probes/compat/reference/vendor-support.json'));
  const measured = existsSync(path.join(OUT, 'render-requirements.json'))
    ? readJson(path.join(OUT, 'render-requirements.json'))
    : null;
  const browsers = existsSync(path.join(OUT, 'browsers.json')) ? readJson(path.join(OUT, 'browsers.json')) : null;
  const files = existsSync(CAPS) ? readdirSync(CAPS).filter((name) => name.endsWith('.json')).sort() : [];
  const runs = files.map((name) => readJson(path.join(CAPS, name))).filter((run) => run.status === 'ok');

  const measuredRows = [];
  const seen = new Set();

  const loopbackRuns = runs.filter((run) => run.mode === 'loopback');
  const lanRuns = runs.filter((run) => run.mode === 'lan');

  for (const browserId of [...new Set(loopbackRuns.map((run) => run.browser))].sort()) {
    const group = loopbackRuns.filter((run) => run.browser === browserId);
    const record = chooseRepresentative(group);
    const verdict = statusForLoopback(record);
    const engine = engineOf(record.capability);
    const id = browserId + '-windows-loopback';
    seen.add(id);
    measuredRows.push({
      id,
      browser: record.capability.uaData?.brands?.find((b) => !['Not-A.Brand', 'Chromium'].includes(b.brand))?.brand ?? record.browser,
      browserId,
      engine: engine.engine ?? 'Chromium',
      engineVersion: engine.chromiumVersion,
      browserVersion: engine.brandVersion,
      browserVersionText: record.browserVersionText,
      os: 'Windows',
      osBuild: browsers?.os?.release ?? null,
      platform: engine.platform,
      origin: 'loopback-http',
      url: record.capabilityUrl,
      secureContext: record.capability.secureContext,
      webgpu: record.capability.webgpu.present === true && !record.capability.webgpu.error,
      adapter: record.capability.webgpu.adapter ?? null,
      requiredLimitsOk: record.capability.requirements?.ok ?? null,
      bootOk: record.boot?.reached ?? false,
      draws: record.boot?.probe?.draws ?? null,
      console: { errors: record.boot?.consoleErrors ?? null, warnings: record.boot?.consoleWarnings ?? null },
      status: verdict.status,
      basis: 'machine-tested',
      failApi: verdict.failApi,
      detail: verdict.detail,
      userMessage: verdict.userMessage,
      testedRuns: group.map((run) => run.id),
      evidence: {
        capability: rel(path.join(CAPS, record.id + '.json')),
        boot: record.boot ? rel(path.join(OUT, 'boot', record.id + '.json')) : null,
        screenshot: record.boot?.screenshot ?? null
      }
    });
  }

  for (const browserId of [...new Set(lanRuns.map((run) => run.browser))].sort()) {
    const group = lanRuns.filter((run) => run.browser === browserId);
    const record = chooseRepresentative(group);
    const verdict = statusForLan(record);
    const capability = record.capability;
    const engine = engineOf(capability);
    const id = browserId + '-windows-lan';
    seen.add(id);
    measuredRows.push({
      id,
      browser: capability.uaData?.brands?.find((b) => !['Not-A.Brand', 'Chromium'].includes(b.brand))?.brand ?? record.browser,
      browserId,
      engine: engine.engine ?? 'Chromium',
      engineVersion: engine.chromiumVersion,
      browserVersion: engine.brandVersion,
      browserVersionText: record.browserVersionText,
      os: 'Windows',
      osBuild: browsers?.os?.release ?? null,
      platform: engine.platform,
      origin: 'lan-http',
      url: record.lanCapabilityUrl,
      secureContext: record.lanCapability?.secureContext ?? null,
      webgpu: record.lanCapability?.webgpu?.present ?? null,
      adapter: record.lanCapability?.webgpu?.adapter ?? null,
      requiredLimitsOk: null,
      bootOk: false,
      draws: null,
      console: { errors: record.lanBoot?.consoleErrors ?? null, warnings: 0 },
      status: verdict.status,
      basis: 'machine-tested',
      failApi: verdict.failApi,
      detail: verdict.detail,
      userMessage: verdict.userMessage,
      testedRuns: group.map((run) => run.id),
      evidence: { capability: rel(path.join(CAPS, record.id + '.json')), boot: null, screenshot: null }
    });
  }

  // WebGL2 fallback feasibility measured in the same browsers.
  const webgl = [];
  for (const browserId of [...new Set(runs.map((run) => run.browser))].sort()) {
    const record = chooseRepresentative(runs.filter((run) => run.browser === browserId && run.mode === 'loopback'));
    const gl = record.capability?.webgl?.value ?? null;
    if (!gl) continue;
    const reasons = [];
    if (!gl.webgl2) reasons.push('WebGL2 context unavailable');
    if ((gl.params?.MAX_TEXTURE_SIZE ?? 0) < (requirements.webgpu.requiredLimits.maxTextureDimension2D ?? 0)) reasons.push('MAX_TEXTURE_SIZE below the largest uploaded texture');
    if ((gl.params?.MAX_UNIFORM_BLOCK_SIZE ?? 0) < 160) reasons.push('MAX_UNIFORM_BLOCK_SIZE below the 160-byte draw block');
    if ((gl.params?.MAX_VERTEX_UNIFORM_BLOCKS ?? 0) < 1) reasons.push('no vertex uniform blocks');
    if ((gl.params?.MAX_FRAGMENT_UNIFORM_BLOCKS ?? 0) < 2) reasons.push('fewer than two fragment uniform blocks');
    if ((gl.params?.MAX_TEXTURE_IMAGE_UNITS ?? 0) < 1) reasons.push('no fragment texture units');
    webgl.push({
      browserId,
      webgl2: gl.webgl2 === true,
      renderer: gl.renderer ?? null,
      version: gl.version ?? null,
      maxTextureSize: gl.params?.MAX_TEXTURE_SIZE ?? null,
      maxUniformBlockSize: gl.params?.MAX_UNIFORM_BLOCK_SIZE ?? null,
      maxVertexUniformBlocks: gl.params?.MAX_VERTEX_UNIFORM_BLOCKS ?? null,
      maxFragmentUniformBlocks: gl.params?.MAX_FRAGMENT_UNIFORM_BLOCKS ?? null,
      maxTextureImageUnits: gl.params?.MAX_TEXTURE_IMAGE_UNITS ?? null,
      anisotropic: gl.anisotropic ?? null,
      feasible: reasons.length === 0,
      reasons
    });
  }

  const vendorRows = vendor.rows
    .map((row) => ({
      id: row.id,
      browser: row.browser,
      engine: row.engine,
      os: row.os,
      minVersion: row.minVersion,
      maxVersion: row.maxVersion ?? null,
      status: row.status,
      basis: row.basis,
      sources: row.sources,
      note: row.note,
      failApi: row.status === 'supported' ? null : 'navigator.gpu',
      userMessage: row.status === 'supported' ? null : MESSAGES.noWebGPU
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const summary = {
    measuredBrowsers: [...new Set(measuredRows.map((row) => row.browserId))].sort(),
    measuredRows: measuredRows.length,
    supported: measuredRows.filter((row) => row.status === 'supported').length,
    partial: measuredRows.filter((row) => row.status === 'partial').length,
    unsupported: measuredRows.filter((row) => row.status === 'unsupported').length,
    vendorRows: vendorRows.length,
    vendorSupported: vendorRows.filter((row) => row.status === 'supported').length,
    vendorPartial: vendorRows.filter((row) => row.status === 'partial').length,
    vendorUnsupported: vendorRows.filter((row) => row.status === 'unsupported').length
  };

  const matrix = {
    schema: 'blur.compat.matrix',
    version: 1,
    generatedBy: 'probes/compat/tools/build_matrix.mjs',
    rule: 'Measured rows come only from _work/compat/capabilities/*.json. Vendor rows come only from probes/compat/reference/vendor-support.json. A row is supported only when the measured page booted with a clean console and every required limit was met.',
    requiredSource: 'probes/compat/reference/requirements.json',
    measuredRequirements: measured,
    measuredRows,
    vendorRows,
    originRule: vendor.originRule,
    webgl2Fallback: {
      measured: webgl,
      verdict: webgl.length > 0 && webgl.every((row) => row.feasible)
        ? 'feasible-in-principle'
        : 'not-feasible-on-measured-hardware',
      notImplemented: true,
      note: 'Not implemented in this task. The measured capabilities only show that a WebGL2 backend could express the same packet; the cost estimate is in docs/work/analysis/browser-compat.md and is not a claim that the renderer already runs on WebGL2.'
    },
    summary
  };

  const text = JSON.stringify(matrix, null, 2) + '\n';
  return { matrix, text, hash: sha256Text(stableStringify(matrix)) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync(OUT, { recursive: true });
  const first = buildMatrix();
  const second = buildMatrix();
  if (first.hash !== second.hash) throw new Error('matrix is not deterministic: ' + first.hash + ' vs ' + second.hash);
  writeFileSync(path.join(OUT, 'compat-matrix.json'), first.text, 'utf8');
  writeFileSync(path.join(OUT, 'compat-matrix.hash'), first.hash + '\n', 'utf8');
  console.log('wrote _work/compat/compat-matrix.json');
  console.log('stable hash ' + first.hash + ' (built twice, identical)');
  for (const row of first.matrix.measuredRows) {
    console.log('  ' + row.id.padEnd(34) + row.status.padEnd(12) + (row.failApi ?? '') + (row.detail ? ' — ' + row.detail : ''));
  }
  const { summary } = first.matrix;
  console.log('measured ' + summary.supported + ' supported / ' + summary.partial + ' partial / ' +
    summary.unsupported + ' unsupported; vendor rows ' + summary.vendorRows);
  console.log('webgl2 fallback: ' + first.matrix.webgl2Fallback.verdict);
}
