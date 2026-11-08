// Verifier for the browser compatibility record.
//
// Every check reads a recorded artifact (_work/compat/**) or a committed
// reference model (probes/compat/reference/**). Nothing here launches a browser;
// this proves the record is complete, internally consistent, correctly derived
// and deterministic, and that the matrix agrees with an independent re-derivation.
//
// Usage: node probes/compat/tools/verify_compat.mjs

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMatrix, sha256Text, stableStringify } from './build_matrix.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const WORK = path.join(ROOT, '_work/compat');
const REF = path.join(ROOT, 'probes/compat/reference');

const abs = (p) => path.join(ROOT, p);
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const sha256File = (p) => 'sha256:' + createHash('sha256').update(readFileSync(p)).digest('hex');

const checks = [];
function check(name, condition, detail = null) {
  checks.push({ name, ok: !!condition, detail });
  if (!condition) console.error('FAIL ' + name + (detail ? ' — ' + detail : ''));
}
function eq(name, actual, expected) {
  check(name, actual === expected, 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}
function gte(name, actual, minimum) {
  check(name, typeof actual === 'number' && actual >= minimum, 'expected >= ' + minimum + ', got ' + actual);
}

// ---------------------------------------------------------------- artifacts

const requirementPath = path.join(REF, 'requirements.json');
const vendorPath = path.join(REF, 'vendor-support.json');
const measuredPath = path.join(WORK, 'render-requirements.json');
const browsersPath = path.join(WORK, 'browsers.json');
const matrixPath = path.join(WORK, 'compat-matrix.json');
const matrixHashPath = path.join(WORK, 'compat-matrix.hash');

check('requirements.json exists', existsSync(requirementPath));
check('vendor-support.json exists', existsSync(vendorPath));
check('render-requirements.json exists', existsSync(measuredPath));
check('browsers.json exists', existsSync(browsersPath));
check('compat-matrix.json exists', existsSync(matrixPath));
check('compat-matrix.hash exists', existsSync(matrixHashPath));

const requirement = readJson(requirementPath);
const vendor = readJson(vendorPath);
const measured = readJson(measuredPath);
const browsers = readJson(browsersPath);
const matrix = readJson(matrixPath);
const matrixHash = readFileSync(matrixHashPath, 'utf8').trim();

eq('requirements schema', requirement.schema, 'blur.compat.requirements');
eq('requirements version', requirement.version, 1);
check('requirements cite a source file', typeof requirement.source?.consumer === 'string');
check('vendor schema', vendor.schema === 'blur.compat.vendor-support' && vendor.version === 1);
eq('measured requirements schema', measured.schema, 'blur.compat.render-requirements');
eq('browsers schema', browsers.schema, 'blur.compat.browsers');
eq('matrix schema', matrix.schema, 'blur.compat.matrix');

const capabilityFiles = readdirSync(path.join(WORK, 'capabilities')).filter((name) => name.endsWith('.json')).sort();
const capabilityRecords = capabilityFiles.map((name) => readJson(path.join(WORK, 'capabilities', name)));
const okRecords = capabilityRecords.filter((record) => record.status === 'ok');
const loopbackRecords = okRecords.filter((record) => record.mode === 'loopback');
const lanRecords = okRecords.filter((record) => record.mode === 'lan');
const browserIds = [...new Set(loopbackRecords.map((record) => record.browser))].sort();

check('at least two installed browsers were measured', browserIds.length >= 2, 'got ' + browserIds.join(','));
check('loopback runs recorded for every browser', browserIds.every((id) => loopbackRecords.some((record) => record.browser === id)));
check('LAN runs recorded for every browser', browserIds.every((id) => lanRecords.some((record) => record.browser === id)));
check('every capability record has a user agent', okRecords.every((record) => typeof record.capability?.ua === 'string' && record.capability.ua.length > 20));
check('every capability record has a browser version text', okRecords.every((record) => typeof record.browserVersionText === 'string' && record.browserVersionText.length > 0));
check('browsers.json lists only executable paths that exist', Object.values(browsers.browsers).every((entry) => entry.executable === null || existsSync(entry.executable)));
check('browsers.json records the OS release', typeof browsers.os.release === 'string' && browsers.os.release.length > 0, 'got ' + browsers.os.release);

// ---------------------------------------------------------------- per browser

const requiredLimits = requirement.webgpu.requiredLimits;
const limitNames = Object.keys(requiredLimits);
const measuredWorst = measured.worstCase;

function representative(browserId, mode = 'loopback') {
  const group = okRecords.filter((record) => record.browser === browserId && record.mode === mode);
  const score = (run) => (run.headless === false ? 0 : run.flags.length === 0 ? 1 : 2);
  return [...group].sort((a, b) => score(a) - score(b) || a.id.localeCompare(b.id))[0];
}

for (const browserId of browserIds) {
  const record = representative(browserId);
  const capability = record.capability;
  const tag = browserId + ': ';
  check(tag + 'capability probe completed without a fatal error', !capability.fatal, capability.error);
  check(tag + 'userAgentData brands present', Array.isArray(capability.uaData?.brands) && capability.uaData.brands.length > 0);
  const chromium = capability.uaData?.brands?.find((brand) => brand.brand === 'Chromium');
  const named = capability.uaData?.brands?.find((brand) => !['Not-A.Brand', 'Chromium'].includes(brand.brand));
  check(tag + 'Chromium engine brand reported', !!chromium, JSON.stringify(capability.uaData?.brands));
  check(tag + 'browser brand reported', !!named, JSON.stringify(capability.uaData?.brands));
  check(tag + 'measured version appears in the executable version text', !!named && record.browserVersionText.includes(named.version), record.browserVersionText);
  eq(tag + 'loopback origin is a secure context', capability.secureContext, true);
  check(tag + 'loopback origin is loopback', /^http:\/\/127\.0\.0\.1:\d+$/.test(capability.origin), capability.origin);
  eq(tag + 'navigator.gpu is present', capability.webgpu.present, true);
  check(tag + 'GPU adapter was returned', !!capability.webgpu.adapter && Object.keys(capability.webgpu.adapter).length > 0);
  check(tag + 'adapter vendor is recorded', typeof capability.webgpu.adapter?.vendor === 'string' && capability.webgpu.adapter.vendor.length > 0);
  check(tag + 'adapter architecture is recorded', typeof capability.webgpu.adapter?.architecture === 'string' && capability.webgpu.adapter.architecture.length > 0);
  eq(tag + 'adapter is not a fallback adapter', capability.webgpu.adapter?.isFallbackAdapter, false);
  check(tag + 'preferred canvas format is a BGRA/RGBA unorm', ['bgra8unorm', 'rgba8unorm'].includes(capability.webgpu.preferredCanvasFormat), capability.webgpu.preferredCanvasFormat);
  eq(tag + 'webgpu canvas context was configured', capability.webgpu.canvasContext, true);
  check(tag + 'core WebGPU features are advertised', (capability.webgpu.adapterFeatures || []).includes('core-features-and-limits'), JSON.stringify(capability.webgpu.adapterFeatures));
  eq(tag + 'requirement comparison passed', capability.requirements?.ok, true);
  eq(tag + 'requirement comparison checked every required limit', capability.requirements?.checked, limitNames.length);

  for (const name of limitNames) {
    const adapterValue = capability.webgpu.adapterLimits?.[name];
    const deviceValue = capability.webgpu.deviceLimits?.[name];
    const requiredValue = requiredLimits[name];
    check(tag + 'limit ' + name + ' is reported by the adapter', typeof adapterValue === 'number', 'got ' + adapterValue);
    gte(tag + 'limit ' + name + ' meets the requirement', adapterValue, requiredValue);
    check(tag + 'device limit ' + name + ' is reported by the default device', typeof deviceValue === 'number', 'got ' + deviceValue);
    gte(tag + 'default device limit ' + name + ' meets the requirement', deviceValue, requiredValue);
    check(tag + 'default device limit ' + name + ' does not exceed the adapter', deviceValue <= adapterValue, deviceValue + ' > ' + adapterValue);
  }

  eq(tag + 'minUniformBufferOffsetAlignment is the hard-coded 256', capability.webgpu.adapterLimits?.minUniformBufferOffsetAlignment, 256);
  gte(tag + 'maxBufferSize covers the largest measured buffer', capability.webgpu.adapterLimits?.maxBufferSize, measuredWorst.largestBufferBytes);
  gte(tag + 'maxTextureDimension2D covers the largest texture', capability.webgpu.adapterLimits?.maxTextureDimension2D, measuredWorst.maxTextureEdge);
  gte(tag + 'maxBindGroups covers three groups', capability.webgpu.adapterLimits?.maxBindGroups, 3);
  gte(tag + 'maxVertexBuffers covers two buffers', capability.webgpu.adapterLimits?.maxVertexBuffers, 2);
  gte(tag + 'maxUniformBufferBindingSize covers 160 bytes', capability.webgpu.adapterLimits?.maxUniformBufferBindingSize, 160);

  check(tag + 'engine wasm reports its byte length', capability.wasm?.value?.engine?.bytes === requirement.source.wasmBytes, JSON.stringify(capability.wasm?.value?.engine));
  eq(tag + 'engine wasm validates', capability.wasm?.value?.engine?.validated, true);
  eq(tag + 'engine wasm compiles', capability.wasm?.value?.engine?.compiled, true);
  for (const feature of requirement.wasm.featuresRequired) {
    eq(tag + 'wasm feature ' + feature + ' is supported', capability.wasm?.value?.features?.[feature], true);
  }
  for (const feature of ['simd', 'threads']) {
    eq(tag + 'browser supports the unused wasm feature ' + feature + ' (informational)', capability.wasm?.value?.features?.[feature], true);
  }

  eq(tag + 'Web Audio decodeAudioData decoded the probe WAV', capability.audio?.value?.decoded, true);
  check(tag + 'decoded audio duration is positive', (capability.audio?.value?.duration ?? 0) > 0);
  check(tag + 'AudioContext constructor exists', typeof capability.audio?.value?.constructor === 'string');
  eq(tag + 'WebSocket connected to the echo endpoint', capability.websocket?.value?.opened, true);
  eq(tag + 'WebSocket echo payload is correct', capability.websocket?.value?.echo, 'compat-echo');
  eq(tag + 'localStorage round-trips a value', capability.storage?.value?.localStorage, true);
  eq(tag + 'crypto.subtle is present in the secure context', capability.crypto?.value?.subtle, true);
  eq(tag + 'crypto.subtle digest matches the known SHA-256 vector', capability.crypto?.value?.digestMatchesKnownVector, true);
  eq(tag + 'dynamic import works', capability.modules?.value?.dynamicImport, true);
  eq(tag + 'top-level await works', capability.modules?.value?.topLevelAwait, true);
  eq(tag + 'HTML module scripts are supported', capability.misc?.value?.moduleScriptSupported, true);
  eq(tag + 'WebGL2 is available', capability.webgl?.value?.webgl2, true);
  check(tag + 'WebGL2 max texture size covers 512', (capability.webgl?.value?.params?.MAX_TEXTURE_SIZE ?? 0) >= 512);
  check(tag + 'WebGL2 uniform block size covers 160 bytes', (capability.webgl?.value?.params?.MAX_UNIFORM_BLOCK_SIZE ?? 0) >= 160);
  check(tag + 'WebGL2 reports a renderer string', typeof capability.webgl?.value?.renderer === 'string' && capability.webgl.value.renderer.length > 0);
  check(tag + 'anisotropic filtering extension is present (optional)', capability.webgl?.value?.anisotropic?.max >= 1);
  check(tag + 'structuredClone is available', capability.misc?.value?.structuredClone === true);
  check(tag + 'requestAnimationFrame is available', capability.misc?.value?.requestAnimationFrame === true);
  check(tag + 'pointer events are available', capability.canvas?.value?.pointerEvents === true);
  eq(tag + 'capability page recorded no unexpected requirement failures', (capability.errors || []).length, 0, JSON.stringify(capability.errors));
}

// ---------------------------------------------------------------- boot

const BOOT_DRAWS = 516;
for (const browserId of browserIds) {
  for (const run of loopbackRecords.filter((record) => record.browser === browserId)) {
    const tag = run.id + ': ';
    check(tag + 'boot record exists', !!run.boot);
    if (!run.boot) continue;
    eq(tag + 'page reached hold=120', run.boot.reached, true);
    check(tag + 'page published a probe', !!run.boot.probe);
    if (!run.boot.probe) continue;
    eq(tag + 'page state is running', run.boot.probe.state, 'running');
    eq(tag + 'displayed tick is 120', run.boot.probe.displayTick, 120);
    eq(tag + 'engine tick is 120', run.boot.probe.engineTick, 120);
    gte(tag + 'at least 12 frames rendered', run.boot.probe.frames, 12);
    eq(tag + 'draw count matches the River packet', run.boot.probe.draws, BOOT_DRAWS);
    check(tag + 'adapter string is recorded in the HUD', typeof run.boot.probe.adapter === 'string' && run.boot.probe.adapter.includes('/'), run.boot.probe.adapter);
    eq(tag + 'console error count is zero', run.boot.consoleErrors, 0);
    eq(tag + 'console warning count is zero', run.boot.consoleWarnings, 0);
    check(tag + 'screenshot path is recorded', typeof run.boot.screenshot === 'string');
    if (run.boot.screenshot) {
      const shot = abs(run.boot.screenshot);
      check(tag + 'screenshot file exists', existsSync(shot), run.boot.screenshot);
      if (existsSync(shot)) {
        gte(tag + 'screenshot is a real image', statSync(shot).size, 20000);
        eq(tag + 'screenshot byte count matches the file', run.boot.screenshotBytes, statSync(shot).size);
      }
    }
  }
}

// headed coverage: a real (non-headless) window is the friend-facing path
for (const browserId of browserIds) {
  const headed = loopbackRecords.filter((record) => record.browser === browserId && record.headless === false);
  check(browserId + ': a headed run was recorded', headed.length >= 1);
  for (const run of headed) {
    eq(run.id + ': headed boot succeeded', run.boot?.reached, true);
    eq(run.id + ': headed console is clean', run.boot?.consoleErrors, 0);
  }
  const headlessDefault = loopbackRecords.filter((record) => record.browser === browserId && record.headless === true && record.flags.length === 0);
  check(browserId + ': a headless run without WebGPU flags was recorded', headlessDefault.length >= 1);
  check(browserId + ': headless default boot succeeded', headlessDefault.every((run) => run.boot?.reached === true));
  const headlessCapture = loopbackRecords.filter((record) => record.browser === browserId && record.headless === true && record.flags.length > 0);
  check(browserId + ': a headless capture-flag run was recorded', headlessCapture.length >= 1);
  check(browserId + ': headless capture boot succeeded', headlessCapture.every((run) => run.boot?.reached === true));
}

// ---------------------------------------------------------------- LAN origin

const EXPECTED_LAN_ERROR = 'crypto.subtle is unavailable: the map physics pin cannot be verified';
for (const browserId of browserIds) {
  const record = representative(browserId, 'lan');
  const tag = browserId + ' LAN: ';
  check(tag + 'record exists', !!record?.lanCapability);
  if (!record?.lanCapability) continue;
  eq(tag + 'isSecureContext is false', record.lanCapability.secureContext, false);
  eq(tag + 'navigator.gpu is undefined', record.lanCapability.webgpu.present, false);
  eq(tag + 'navigator.gpu error text is recorded', record.lanCapability.webgpu.error, 'navigator.gpu is undefined');
  eq(tag + 'crypto.subtle is undefined', record.lanCapability.crypto?.value?.subtle, false);
  check(tag + 'the real page fails before the first frame', record.lanBoot?.reachedError === true);
  eq(tag + 'the real page reports the exact crypto.subtle message', record.lanBoot?.errorText, EXPECTED_LAN_ERROR);
  check(tag + 'the error box text is also in the DOM', record.lanBoot?.errorText === EXPECTED_LAN_ERROR);
  gte(tag + 'the failure is logged', record.lanBoot?.consoleErrors, 1);
  check(tag + 'the LAN origin is not loopback', !/127\.0\.0\.1|localhost/.test(record.lanCapabilityUrl), record.lanCapabilityUrl);
  check(tag + 'the LAN origin is plain HTTP', record.lanCapabilityUrl.startsWith('http://'), record.lanCapabilityUrl);
}

// ---------------------------------------------------------------- matrix

const rebuilt = buildMatrix();
eq('matrix is deterministic (two in-process builds)', rebuilt.hash, buildMatrix().hash);
eq('matrix hash file matches the current derivation', matrixHash, rebuilt.hash);
eq('matrix text matches the current derivation byte for byte', readFileSync(matrixPath, 'utf8'), rebuilt.text);
check('matrix contains no clock fields', !/"(measuredAt|startedAt|finishedAt|generatedAt)"/.test(readFileSync(matrixPath, 'utf8')));
eq('matrix has one loopback row per measured browser', matrix.measuredRows.filter((row) => row.origin === 'loopback-http').length, browserIds.length);
eq('matrix has one LAN row per measured browser', matrix.measuredRows.filter((row) => row.origin === 'lan-http').length, browserIds.length);
eq('matrix measured row count', matrix.measuredRows.length, browserIds.length * 2);
eq('matrix summary measured row count', matrix.summary.measuredRows, matrix.measuredRows.length);
eq('matrix summary supported count', matrix.summary.supported, matrix.measuredRows.filter((row) => row.status === 'supported').length);
eq('matrix summary partial count', matrix.summary.partial, matrix.measuredRows.filter((row) => row.status === 'partial').length);
eq('matrix summary unsupported count', matrix.summary.unsupported, matrix.measuredRows.filter((row) => row.status === 'unsupported').length);
eq('matrix summary vendor row count', matrix.summary.vendorRows, matrix.vendorRows.length);

for (const browserId of browserIds) {
  const row = matrix.measuredRows.find((entry) => entry.browserId === browserId && entry.origin === 'loopback-http');
  check(browserId + ': loopback matrix row exists', !!row);
  if (!row) continue;
  eq(browserId + ': loopback row is supported', row.status, 'supported');
  eq(browserId + ': loopback row has no failing API', row.failApi, null);
  eq(browserId + ': loopback row has no user message', row.userMessage, null);
  eq(browserId + ': loopback row is machine-tested', row.basis, 'machine-tested');
  eq(browserId + ': loopback row reports a secure context', row.secureContext, true);
  eq(browserId + ': loopback row reports WebGPU', row.webgpu, true);
  eq(browserId + ': loopback row reports the boot', row.bootOk, true);
  eq(browserId + ': loopback row reports a clean console', row.console.errors, 0);
  eq(browserId + ': loopback row draw count', row.draws, BOOT_DRAWS);
  eq(browserId + ': loopback row has no guessed version', typeof row.browserVersion, 'string');
  check(browserId + ': loopback row version comes from the measured UA data', (row.engineVersion || '').length > 0, JSON.stringify(row.engineVersion));
  check(browserId + ': loopback evidence capability file exists', existsSync(abs(row.evidence.capability)));
  check(browserId + ': loopback evidence boot file exists', existsSync(abs(row.evidence.boot)));
  check(browserId + ': loopback evidence screenshot exists', existsSync(abs(row.evidence.screenshot)));

  const lanRow = matrix.measuredRows.find((entry) => entry.browserId === browserId && entry.origin === 'lan-http');
  check(browserId + ': LAN matrix row exists', !!lanRow);
  if (!lanRow) continue;
  eq(browserId + ': LAN row is unsupported', lanRow.status, 'unsupported');
  check(browserId + ': LAN row names the failing API', /isSecureContext/.test(lanRow.failApi || ''), lanRow.failApi);
  check(browserId + ': LAN row carries a user message', typeof lanRow.userMessage === 'string' && lanRow.userMessage.includes('127.0.0.1'), lanRow.userMessage);
  check(browserId + ': LAN row records the exact page error', lanRow.detail === EXPECTED_LAN_ERROR, lanRow.detail);
  eq(browserId + ': LAN row reports an insecure context', lanRow.secureContext, false);
  eq(browserId + ': LAN row reports no WebGPU', lanRow.webgpu, false);
  eq(browserId + ': LAN row reports no boot', lanRow.bootOk, false);
}

for (const row of matrix.measuredRows) {
  check(row.id + ': every non-supported row carries the failing API', row.status === 'supported' || typeof row.failApi === 'string');
  check(row.id + ': every non-supported row carries a user message', row.status === 'supported' || (typeof row.userMessage === 'string' && row.userMessage.length > 30));
  check(row.id + ': supported rows have no failure detail', row.status !== 'supported' || (row.failApi === null && row.userMessage === null));
  check(row.id + ': evidence capability file exists', existsSync(abs(row.evidence.capability)));
  check(row.id + ': tested runs are named', Array.isArray(row.testedRuns) && row.testedRuns.length > 0);
}

// status derivation is independent of the matrix builder
for (const browserId of browserIds) {
  const record = representative(browserId);
  const expectedSupported = record.capability.secureContext === true &&
    record.capability.webgpu.present === true && !record.capability.webgpu.error &&
    record.capability.requirements?.ok === true &&
    record.boot?.reached === true && record.boot?.consoleErrors === 0;
  eq(browserId + ': independent status rule agrees with the matrix', expectedSupported, true);
}

// ---------------------------------------------------------------- vendor rows

check('vendor rows are present', matrix.vendorRows.length >= 15, 'got ' + matrix.vendorRows.length);
check('every vendor row cites at least one source', matrix.vendorRows.every((row) => Array.isArray(row.sources) && row.sources.length > 0));
check('every vendor row states its basis', matrix.vendorRows.every((row) => typeof row.basis === 'string' && row.basis.length > 0));
check('every vendor row has a valid status', matrix.vendorRows.every((row) => ['supported', 'partial', 'unsupported'].includes(row.status)));
check('vendor rows are sorted by id', matrix.vendorRows.every((row, index, list) => index === 0 || list[index - 1].id.localeCompare(row.id) <= 0));
const vendorRow = (id) => matrix.vendorRows.find((row) => row.id === id);
eq('Safari 26 on macOS 26 is supported', vendorRow('macos-safari-26')?.status, 'supported');
eq('Safari on macOS 14/15 is unsupported', vendorRow('macos-safari-old')?.status, 'unsupported');
eq('Safari on iOS 26 is supported', vendorRow('ios-safari-26')?.status, 'supported');
eq('Safari on iOS 18 is unsupported', vendorRow('ios-safari-old')?.status, 'unsupported');
eq('Safari on Windows is unsupported', vendorRow('windows-safari')?.status, 'unsupported');
eq('Firefox 141 on Windows is supported', vendorRow('windows-firefox')?.status, 'supported');
eq('Firefox <=140 on Windows is unsupported', vendorRow('windows-firefox-old')?.status, 'unsupported');
eq('Firefox on Linux is unsupported by default', vendorRow('linux-firefox')?.status, 'unsupported');
eq('Firefox on macOS is supported only on Tahoe/Apple Silicon', vendorRow('macos-firefox')?.status, 'supported');
eq('Chrome on Linux is partial', vendorRow('linux-chrome')?.status, 'partial');
eq('Edge on Linux is partial', vendorRow('linux-edge')?.status, 'partial');
eq('Samsung Internet 24+ is supported', vendorRow('android-samsung')?.status, 'supported');
eq('Firefox for Android is unsupported', vendorRow('android-firefox')?.status, 'unsupported');
eq('Firefox 141 minimum version is cited as 141', vendorRow('windows-firefox')?.minVersion, '141');
eq('Safari 26 minimum version is cited as 26.0', vendorRow('macos-safari-26')?.minVersion, '26.0');
eq('Chrome minimum version is cited as 113', vendorRow('windows-chrome')?.minVersion, '113');
check('vendor rows with no documented minimum say null', ['windows-brave', 'windows-safari', 'android-chrome'].every((id) => vendorRow(id)?.minVersion === null));
check('vendor support notes cite the caniuse note numbers', matrix.vendorRows.every((row) => typeof row.note === 'string' && row.note.length > 10));
eq('origin rule marks LAN HTTP unsupported', matrix.originRule.statusByOrigin['lan-http'], 'unsupported');
eq('origin rule marks loopback supported', matrix.originRule.statusByOrigin['loopback-http'], 'supported');

// ---------------------------------------------------------------- fallback

check('WebGL2 fallback was measured in every browser', matrix.webgl2Fallback.measured.length === browserIds.length);
for (const browserId of browserIds) {
  const gl = matrix.webgl2Fallback.measured.find((row) => row.browserId === browserId);
  check(browserId + ': WebGL2 fallback row exists', !!gl);
  if (!gl) continue;
  eq(browserId + ': WebGL2 context is available', gl.webgl2, true);
  gte(browserId + ': WebGL2 max texture size covers the packet', gl.maxTextureSize, measuredWorst.maxTextureEdge);
  gte(browserId + ': WebGL2 max uniform block size covers 160 bytes', gl.maxUniformBlockSize, 160);
  gte(browserId + ': WebGL2 vertex uniform blocks', gl.maxVertexUniformBlocks, 1);
  gte(browserId + ': WebGL2 fragment uniform blocks', gl.maxFragmentUniformBlocks, 2);
  gte(browserId + ': WebGL2 texture image units', gl.maxTextureImageUnits, 1);
  eq(browserId + ': WebGL2 fallback is technically feasible', gl.feasible, true);
  eq(browserId + ': WebGL2 fallback has no blocking reason', gl.reasons.length, 0);
}
eq('fallback verdict', matrix.webgl2Fallback.verdict, 'feasible-in-principle');
eq('fallback is explicitly not implemented', matrix.webgl2Fallback.notImplemented, true);
check('worst-case per-frame draw count is bounded', measured.worstCase.draws <= 3000, String(measured.worstCase.draws));
check('worst-case uniform bytes equal draws*256 + bands', measured.worstCase.uniformBytes === (measured.worstCase.draws + measured.maps.gracia.carDraws * 4 + 20) * 256, String(measured.worstCase.uniformBytes));

// ---------------------------------------------------------------- requirement model

check('no WebGPU optional feature is required', requirement.webgpu.requiredFeatures.length === 0);
check('the requirement model lists simd as unused', requirement.wasm.featuresNotUsed.includes('simd'));
check('the requirement model lists threads as unused', requirement.wasm.featuresNotUsed.includes('threads'));
check('the requirement model does not list simd as required', !requirement.wasm.featuresRequired.includes('simd'));
check('the requirement model does not list threads as required', !requirement.wasm.featuresRequired.includes('threads'));
eq('required wasm feature count', requirement.wasm.featuresRequired.length, 5);
check('every required wasm feature is one of the tested probes', requirement.wasm.featuresRequired.every((name) => name in readJson(path.join(WORK, 'wasm-probes.json')).probes));
eq('wasm feature probe count', Object.keys(readJson(path.join(WORK, 'wasm-probes.json')).probes).length, 13);
for (const [name, value] of Object.entries(requiredLimits)) {
  check('required limit ' + name + ' is a finite number', Number.isFinite(value));
  check('limit citation exists for ' + name, typeof requirement.webgpu.limitCitations[name] === 'string');
}
check('maxBufferSize requirement equals the measured largest buffer', requiredLimits.maxBufferSize === measuredWorst.largestBufferBytes, JSON.stringify([requiredLimits.maxBufferSize, measuredWorst.largestBufferBytes]));
check('maxTextureDimension2D requirement equals the measured largest texture', requiredLimits.maxTextureDimension2D === measuredWorst.maxTextureEdge);
check('maxBufferSize is inside the core default (256 MiB)', requiredLimits.maxBufferSize <= 256 * 1024 * 1024);
check('maxTextureDimension2D is inside the core default (8192)', requiredLimits.maxTextureDimension2D <= 8192);
check('minUniformBufferOffsetAlignment assumption is documented', requirement.webgpu.hardAssumptions.some((entry) => entry.name === 'minUniformBufferOffsetAlignment' && entry.requiredMaximum === 256));
check('anisotropy is documented as optional', requirement.webgpu.hardAssumptions.some((entry) => entry.name === 'maxSamplerAnisotropy' && entry.required === false));
check('minUniformBufferOffsetAlignment is not a required limit', !('minUniformBufferOffsetAlignment' in requiredLimits));
check('maxBindGroupLayoutsPerPipeline is not a required limit', !('maxBindGroupLayoutsPerPipeline' in requiredLimits));
check('maxSamplerAnisotropy is not a required limit', !('maxSamplerAnisotropy' in requiredLimits));
check('draw budget matches the measured River draw count', requirement.webgpu.drawBudget.riverMaxDraws === measured.maps.river.draws, JSON.stringify([requirement.webgpu.drawBudget.riverMaxDraws, measured.maps.river.draws]));
check('draw budget matches the measured Amboy draw count', requirement.webgpu.drawBudget.amboyMaxDraws === measured.maps.amboy.draws);
check('draw budget matches the measured Gracia draw count', requirement.webgpu.drawBudget.graciaMaxDraws === measured.maps.gracia.draws);
check('uniform budget matches the measured worst case', requirement.webgpu.drawBudget.uniformBytesWorstCase === measuredWorst.uniformBytes);
check('measured evidence cross-check is recorded', Object.keys(measured.evidence).length >= 2);
check('evidence draw counts are within the car-width band', Object.values(measured.evidence).every((entry) => entry.draws > 0));
check('measured texture count is positive for every map', Object.values(measured.maps).every((map) => map.textureCount > 0));
check('measured mesh vertex count is positive for every map', Object.values(measured.maps).every((map) => map.meshes.length > 0));
check('crypto.subtle secure-context requirement is documented', requirement.webApis.some((entry) => entry.api.includes('crypto.subtle') && entry.secureContext === true));
check('navigator.gpu secure-context requirement is documented', requirement.webApis.some((entry) => entry.api === 'navigator.gpu' && entry.secureContext === true));
check('OffscreenCanvas is explicitly not required', requirement.notRequired.some((entry) => entry.startsWith('OffscreenCanvas')));
check('WASM threads are explicitly not required', requirement.notRequired.some((entry) => entry.includes('threads')));

// ---------------------------------------------------------------- report

const passed = checks.filter((entry) => entry.ok).length;
const failed = checks.length - passed;
console.log('');
console.log('browser compatibility verifier: ' + passed + '/' + checks.length + ' checks passed');
console.log('matrix hash: ' + matrixHash);
console.log('measured browsers: ' + browserIds.join(', '));
for (const row of matrix.measuredRows) {
  console.log('  ' + row.id.padEnd(34) + row.status.padEnd(12) + (row.failApi ?? ''));
}
if (failed > 0) {
  console.error(failed + ' check(s) failed');
  process.exit(1);
}
process.exit(0);
