// Visual gate: compare a capture run against the baseline store.
//
//   node probes/visual-diff/compare.mjs [--run <dir|runId|latest>]
//                                       [--baseline-root _work/visual-diff/baselines]
//                                       [--abs 8] [--rel 0.02]
//                                       [--max-changed-percent N]
//                                       [--require-build-match]
//                                       [--scene a,b]
//
// Writes <run>/report/report.json, <run>/report/report.html and one diff image
// per scene (<run>/report/diffs/<scene>.png).
//
// Exit codes: 0 every scene matched, 1 at least one visual difference,
// 2 harness/usage error (corrupt capture or baseline manifest, bad args),
// 3 at least one scene has no baseline.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeBuildHash } from './build-hash.mjs';
import { DEFAULT_ABS_THRESHOLD, DEFAULT_MASK_PADDING, DEFAULT_REL_THRESHOLD, buildDiffImage, compareImages, maskRectsFromCapture } from './diff.mjs';
import { decodePngRgba, encodePng } from './png.mjs';
import { SCENES, sceneById, selectScenes } from './scenes.mjs';
import { loadManifest, manifestPath, readBaselineScene, unusedBaselines } from './store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

class UsageError extends Error {}

function parseArgs(argv) {
  const values = {};
  const scenes = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new UsageError('unexpected argument ' + JSON.stringify(token));
    const name = token.slice(2);
    if (name === 'scene') {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new UsageError('--scene needs a value');
      scenes.push(next);
      index++;
      continue;
    }
    if (name === 'require-build-match' || name === 'list') {
      values[name] = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new UsageError('--' + name + ' needs a value');
    values[name] = next;
    index++;
  }
  return { values, scenes };
}

const { values, scenes: sceneArgs } = parseArgs(process.argv.slice(2));
const option = (name, fallback) => (values[name] === undefined ? fallback : values[name]);
const WORK = path.join(ROOT, '_work', 'visual-diff');
const BASELINE_ROOT = path.resolve(ROOT, option('baseline-root', path.join('_work', 'visual-diff', 'baselines')));
const ABS = Number(option('abs', DEFAULT_ABS_THRESHOLD));
const REL = Number(option('rel', DEFAULT_REL_THRESHOLD));
const MASK_PADDING = Number(option('mask-padding', DEFAULT_MASK_PADDING));
const MAX_PERCENT_OVERRIDE = values['max-changed-percent'] === undefined ? null : Number(values['max-changed-percent']);
if (MAX_PERCENT_OVERRIDE !== null && (!Number.isFinite(MAX_PERCENT_OVERRIDE) || MAX_PERCENT_OVERRIDE < 0)) {
  throw new UsageError('--max-changed-percent must be a non-negative number');
}

function resolveRun(value) {
  if (!value || value === 'latest') {
    const latestPath = path.join(WORK, 'latest.json');
    if (!existsSync(latestPath)) throw new UsageError('no capture run found; run capture.mjs first');
    const latest = JSON.parse(readFileSync(latestPath, 'utf8'));
    return path.resolve(ROOT, latest.dir);
  }
  const direct = path.resolve(ROOT, value);
  if (existsSync(direct)) return direct;
  const candidate = path.join(WORK, 'runs', value);
  if (existsSync(candidate)) return candidate;
  throw new UsageError('capture run not found: ' + value);
}

const RUN_DIR = resolveRun(option('run', 'latest'));
const manifestFile = path.join(RUN_DIR, 'manifest.json');
if (!existsSync(manifestFile)) throw new UsageError('capture manifest is missing: ' + manifestFile);
const capture = JSON.parse(readFileSync(manifestFile, 'utf8'));
if (capture.kind !== 'blur-web.visual-diff.capture') {
  throw new UsageError('capture manifest kind is ' + JSON.stringify(capture.kind));
}

const REPORT_DIR = path.resolve(RUN_DIR, option('report', 'report'));
const DIFF_DIR = path.join(REPORT_DIR, 'diffs');
mkdirSync(DIFF_DIR, { recursive: true });

const loaded = loadManifest(BASELINE_ROOT);
if (loaded.error) throw new UsageError(loaded.error);
const baselineManifest = loaded.manifest;
const selected = selectScenes(sceneArgs);
const selectedIds = selected.map((scene) => scene.id);
const captureScenes = (capture.scenes ?? []).filter((scene) => selectedIds.includes(scene.id));

const warnings = [];
const rows = [];
const startedAt = Date.now();
let compareMs = 0;

for (const sceneDef of selected) {
  const record = captureScenes.find((entry) => entry.id === sceneDef.id);
  if (!record) {
    rows.push({
      id: sceneDef.id, status: 'not-captured',
      message: 'scene is selected but the capture run has no image for it',
      scene: { label: sceneDef.label, mechanism: sceneDef.mechanism, kind: sceneDef.kind }
    });
    continue;
  }
  if (record.error) {
    rows.push({
      id: sceneDef.id, status: 'capture-failed', message: record.error,
      scene: { label: sceneDef.label, mechanism: sceneDef.mechanism, kind: sceneDef.kind }
    });
    continue;
  }
  const sceneStart = Date.now();
  const entry = baselineManifest.scenes[sceneDef.id];
  if (!entry || !entry.current) {
    rows.push({
      id: sceneDef.id, status: 'missing-baseline',
      message: 'no baseline for this scene under ' + path.relative(ROOT, BASELINE_ROOT).split(path.sep).join('/'),
      scene: { label: sceneDef.label, mechanism: sceneDef.mechanism, kind: sceneDef.kind },
      capture: { file: record.file, sha256: record.sha256, width: record.scene?.viewport?.width, height: record.scene?.viewport?.height },
      console: record.console ?? null
    });
    continue;
  }
  const baseline = readBaselineScene({ root: BASELINE_ROOT, sceneId: sceneDef.id, entry });
  if (!baseline.ok) {
    rows.push({
      id: sceneDef.id, status: 'baseline-corrupt', message: baseline.reason,
      scene: { label: sceneDef.label, mechanism: sceneDef.mechanism, kind: sceneDef.kind },
      baseline: { file: entry.current.file, sha256: entry.current.sha256, buildHash: entry.current.buildHash },
      console: record.console ?? null
    });
    continue;
  }
  let currentImage;
  try {
    currentImage = decodePngRgba(readFileSync(path.join(ROOT, record.file)));
  } catch (error) {
    rows.push({
      id: sceneDef.id, status: 'capture-corrupt', message: 'capture PNG is not decodable: ' + error.message,
      scene: { label: sceneDef.label, mechanism: sceneDef.mechanism, kind: sceneDef.kind }
    });
    continue;
  }
  const baselineImage = decodePngRgba(baseline.bytes);
  const maskRecords = [
    ...(entry.current.masks ?? []).map((mask) => ({ selector: mask.selector, rect: mask.rect, source: 'baseline' })),
    ...(record.masks ?? []).map((mask) => ({ selector: mask.selector, rect: mask.rect, source: 'capture' }))
  ];
  const maskResult = maskRectsFromCapture(maskRecords, sceneDef.id);
  warnings.push(...maskResult.warnings);
  const diff = compareImages(currentImage, baselineImage, {
    absThreshold: ABS, relThreshold: REL, maskRects: maskResult.rects, maskPadding: MASK_PADDING
  });
  compareMs += Date.now() - sceneStart;

  let diffFile = null;
  if (diff.status !== 'size-mismatch') {
    const image = buildDiffImage(currentImage, baselineImage, diff, {
      absThreshold: ABS, relThreshold: REL, maskRects: maskResult.rects, maskPadding: MASK_PADDING
    });
    const absolute = path.join(DIFF_DIR, sceneDef.id + '.png');
    writeFileSync(absolute, encodePng(image));
    diffFile = path.relative(ROOT, absolute).split(path.sep).join('/');
  }

  const maxChangedPercent = MAX_PERCENT_OVERRIDE ?? sceneDef.maxChangedPercent ?? 0;
  const buildMatch = record.scene?.kind === 'parity' || record.scene?.kind === 'powerups' || record.scene?.kind === 'app'
    ? capture.build?.hash === entry.current.buildHash
    : capture.build?.hash === entry.current.buildHash;
  let status;
  let message = null;
  if (diff.status === 'size-mismatch') {
    status = 'size-mismatch';
    message = 'capture is ' + diff.width + 'x' + diff.height + ', baseline is ' + diff.baselineWidth + 'x' + diff.baselineHeight;
  } else if (diff.status === 'masked-empty') {
    status = 'error';
    message = 'every pixel is masked; nothing was compared';
  } else if (diff.changedPercent > maxChangedPercent) {
    status = 'fail';
    message = diff.changedPixels + ' changed pixel(s) = ' + diff.changedPercent + ' % > allowed ' + maxChangedPercent + ' %';
  } else {
    status = 'pass';
  }
  if (status === 'pass' && values['require-build-match'] && !buildMatch) {
    status = 'build-mismatch';
    message = 'baseline build ' + String(entry.current.buildHash).slice(0, 12) +
      ' != capture build ' + String(capture.build?.hash).slice(0, 12) + ' (--require-build-match)';
  }

  rows.push({
    id: sceneDef.id,
    status,
    message,
    buildMatch,
    baselineBuild: entry.current.buildHash,
    currentBuild: capture.build?.hash ?? null,
    scene: {
      label: sceneDef.label, mechanism: sceneDef.mechanism, kind: sceneDef.kind,
      overlays: sceneDef.overlays, viewport: sceneDef.viewport,
      maxChangedPercent, url: record.scene?.url ?? null, tick: record.scene?.tick ?? null
    },
    capture: {
      file: record.file, sha256: record.sha256, width: currentImage.width, height: currentImage.height,
      ms: record.ms ?? null, capturedAt: record.capturedAt ?? null
    },
    baseline: {
      file: entry.current.file, sha256: entry.current.sha256, width: entry.current.width,
      height: entry.current.height, capturedAt: entry.current.capturedAt ?? null,
      buildHash: entry.current.buildHash
    },
    metrics: {
      totalPixels: diff.totalPixels, comparedPixels: diff.comparedPixels, maskedPixels: diff.maskedPixels,
      maskCoveredPercent: diff.masks?.coveredPercent ?? 0,
      changedPixels: diff.changedPixels, changedPercent: diff.changedPercent,
      changedFraction: diff.changedFraction, absChangedPixels: diff.absChangedPixels,
      maxDelta: diff.maxDelta, meanDelta: diff.meanDelta, meanLumaDelta: diff.meanLumaDelta,
      p95Delta: diff.p95Delta, p99Delta: diff.p99Delta,
      absThreshold: diff.absThreshold, relThreshold: diff.relThreshold
    },
    masks: {
      selectors: sceneDef.masks ?? [],
      rects: maskResult.rects.map((rect) => ({ x: rect.x, y: rect.y, w: rect.w, h: rect.h, selector: rect.selector ?? null })),
      paddedBy: MASK_PADDING
    },
    files: {
      baseline: path.relative(ROOT, path.join(BASELINE_ROOT, entry.current.file)).split(path.sep).join('/'),
      current: record.file,
      diff: diffFile
    },
    console: record.console ?? null
  });
}

const unused = unusedBaselines(baselineManifest, SCENES.map((scene) => scene.id));
if (unused.length) warnings.push('baseline scenes not in the current catalogue: ' + unused.join(', '));

const counts = {
  scenes: rows.length,
  compared: rows.filter((row) => ['pass', 'fail', 'build-mismatch'].includes(row.status)).length,
  passed: rows.filter((row) => row.status === 'pass').length,
  failed: rows.filter((row) => row.status === 'fail').length,
  missingBaseline: rows.filter((row) => row.status === 'missing-baseline').length,
  corrupt: rows.filter((row) => ['baseline-corrupt', 'capture-corrupt', 'error', 'size-mismatch'].includes(row.status)).length,
  notCaptured: rows.filter((row) => row.status === 'not-captured').length,
  captureFailed: rows.filter((row) => row.status === 'capture-failed').length,
  buildMismatch: rows.filter((row) => row.buildMatch === false).length,
  buildMismatchGated: rows.filter((row) => row.status === 'build-mismatch').length
};
const exitCode = counts.corrupt > 0 || counts.captureFailed > 0 ? 2
  : counts.missingBaseline > 0 || counts.notCaptured > 0 ? 3
    : counts.failed > 0 || counts.buildMismatchGated > 0 ? 1
      : 0;
const gate = exitCode === 0 ? 'pass'
  : exitCode === 1 ? 'fail'
    : exitCode === 3 ? 'missing-baseline' : 'error';

const runtime = {
  compareMs: compareMs + (Date.now() - startedAt - compareMs),
  sessionMs: Date.now() - startedAt,
  captureTotalMs: capture.timings?.totalMs ?? null,
  capturePerSceneMs: Object.fromEntries((capture.timings?.perSceneMs ?? [])
    .filter((row) => row.repeat === 1).map((row) => [row.id, row.ms]))
};

const report = {
  kind: 'blur-web.visual-diff.report',
  version: 1,
  runId: capture.runId,
  createdAt: new Date().toISOString(),
  gate,
  exitCode,
  thresholds: { abs: ABS, rel: REL, maskPadding: MASK_PADDING, maxChangedPercentOverride: MAX_PERCENT_OVERRIDE },
  build: {
    current: capture.build?.hash ?? null,
    baseline: baselineManifest.build?.hash ?? null,
    match: (capture.build?.hash ?? null) === (baselineManifest.build?.hash ?? null),
    requireBuildMatch: values['require-build-match'] === true
  },
  baseline: {
    root: path.relative(ROOT, BASELINE_ROOT).split(path.sep).join('/'),
    manifest: path.relative(ROOT, manifestPath(BASELINE_ROOT)).split(path.sep).join('/'),
    exists: loaded.exists,
    updatedAt: baselineManifest.updatedAt ?? null
  },
  summary: counts,
  runtime,
  console: capture.console ?? null,
  scenes: rows,
  warnings
};

writeFileSync(path.join(REPORT_DIR, 'report.json'), JSON.stringify(report, null, 1) + '\n', 'utf8');

// --- HTML report -----------------------------------------------------------
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character]));
const relativeToReport = (absolute) => path.relative(REPORT_DIR, path.resolve(ROOT, absolute)).split(path.sep).join('/');
const statusColour = (status) => status === 'pass' ? '#2e7d4f'
  : status === 'fail' ? '#b3261e'
    : status === 'missing-baseline' ? '#8a6100' : '#4a4a4a';
const statusRows = rows.map((row) => {
  const metrics = row.metrics ?? {};
  return `<tr>
    <td><code>${escapeHtml(row.id)}</code></td>
    <td style="color:${statusColour(row.status)};font-weight:700">${escapeHtml(row.status)}</td>
    <td>${row.buildMatch === false ? 'no' : 'yes'}</td>
    <td>${metrics.changedPixels ?? '—'}</td>
    <td>${metrics.changedPercent === undefined ? '—' : metrics.changedPercent + ' %'}</td>
    <td>${metrics.maxDelta ?? '—'}</td>
    <td>${metrics.meanDelta ?? '—'}</td>
    <td>${metrics.maskedPixels ?? '—'}</td>
    <td>${row.capture?.ms ?? '—'} ms</td>
  </tr>`;
}).join('\n');

const sceneCards = rows.map((row) => {
  const images = row.files ? `
    <div class="images">
      <figure><figcaption>baseline · ${escapeHtml(row.baseline?.buildHash?.slice(0, 12) ?? '')}</figcaption>
        <img src="${escapeHtml(relativeToReport(row.files.baseline))}" alt="baseline ${escapeHtml(row.id)}"></figure>
      <figure><figcaption>current</figcaption>
        <img src="${escapeHtml(relativeToReport(row.files.current))}" alt="current ${escapeHtml(row.id)}"></figure>
      <figure><figcaption>diff (red = changed, blue-grey = masked)</figcaption>
        <img src="${escapeHtml(relativeToReport(row.files.diff))}" alt="diff ${escapeHtml(row.id)}"></figure>
    </div>` : '';
  const maskList = (row.masks?.rects ?? []).length
    ? `<p class="muted">masks: ${row.masks.rects.map((rect) =>
      `${escapeHtml(rect.selector ?? 'rect')} [${rect.x},${rect.y} ${rect.w}x${rect.h}]`).join(' · ')} (padded ${row.masks.paddedBy}px)</p>`
    : '<p class="muted">masks: none</p>';
  return `<section>
    <h2><code>${escapeHtml(row.id)}</code> — <span style="color:${statusColour(row.status)}">${escapeHtml(row.status)}</span></h2>
    <p>${escapeHtml(row.scene?.label ?? '')}</p>
    <p class="muted">${escapeHtml(row.message ?? '')}</p>
    <p class="muted">mechanism: ${escapeHtml(row.scene?.mechanism ?? '')}</p>
    ${images}
    ${row.metrics ? `<table class="metrics">
      <tr><th>compared px</th><th>changed px</th><th>changed %</th><th>max Δ</th><th>mean Δ</th><th>p95 Δ</th><th>masked px</th></tr>
      <tr><td>${row.metrics.comparedPixels}</td><td>${row.metrics.changedPixels}</td>
        <td>${row.metrics.changedPercent}</td><td>${row.metrics.maxDelta}</td>
        <td>${row.metrics.meanDelta}</td><td>${row.metrics.p95Delta}</td><td>${row.metrics.maskedPixels}</td></tr>
    </table>` : ''}
    ${maskList}
    <p class="muted">console: ${row.console ? row.console.total + ' message(s), ' + row.console.errors + ' error(s), ' + row.console.warnings + ' warning(s)' : 'not recorded'}</p>
  </section>`;
}).join('\n');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>visual-diff ${escapeHtml(report.runId)} — ${escapeHtml(report.gate)}</title>
<style>
  body { font: 13px/1.5 Consolas, ui-monospace, monospace; margin: 24px; background: #101418; color: #dfe9f2; }
  h1 { font-size: 20px; } h2 { font-size: 15px; margin-bottom: 4px; }
  table { border-collapse: collapse; margin: 10px 0; } td, th { border: 1px solid #2a3742; padding: 3px 8px; text-align: left; }
  th { color: #9fb3c4; font-weight: 400; }
  .muted { color: #8fa3b4; }
  .images { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
  img { width: 100%; border: 1px solid #2a3742; }
  figure { margin: 0; } figcaption { color: #9fb3c4; font-size: 11px; }
  section { border-top: 1px solid #2a3742; padding-top: 12px; margin-top: 16px; }
  .summary { display: flex; gap: 18px; flex-wrap: wrap; }
  .summary div { background: #172029; padding: 6px 12px; border-radius: 6px; }
</style></head><body>
<h1>visual-diff report — ${escapeHtml(report.runId)}</h1>
<div class="summary">
  <div>gate <strong style="color:${statusColour(report.gate === 'pass' ? 'pass' : report.gate === 'fail' ? 'fail' : 'missing-baseline')}">${escapeHtml(report.gate)}</strong></div>
  <div>exit <strong>${report.exitCode}</strong></div>
  <div>scenes <strong>${counts.scenes}</strong></div>
  <div>passed <strong>${counts.passed}</strong></div>
  <div>failed <strong>${counts.failed}</strong></div>
  <div>missing baseline <strong>${counts.missingBaseline}</strong></div>
  <div>build match <strong>${report.build.match ? 'yes' : 'no'}</strong></div>
</div>
<p class="muted">thresholds: |Δ| &gt; ${ABS}/255 and |Δ|/max(R,G,B) &gt; ${REL}; masks padded ${MASK_PADDING}px;
allowed changed %: ${MAX_PERCENT_OVERRIDE === null ? 'per scene (0)' : MAX_PERCENT_OVERRIDE};
build ${escapeHtml(String(report.build.current).slice(0, 12))} vs baseline ${escapeHtml(String(report.build.baseline).slice(0, 12))};
capture ${runtime.captureTotalMs ?? '—'} ms, compare ${runtime.sessionMs} ms</p>
<table><thead><tr><th>scene</th><th>status</th><th>build match</th><th>changed px</th><th>changed %</th><th>max Δ</th><th>mean Δ</th><th>masked px</th><th>capture</th></tr></thead>
<tbody>${statusRows}</tbody></table>
${sceneCards}
${warnings.length ? '<h2>warnings</h2><ul>' + warnings.map((warning) => '<li>' + escapeHtml(warning) + '</li>').join('') + '</ul>' : ''}
</body></html>
`;
writeFileSync(path.join(REPORT_DIR, 'report.html'), html, 'utf8');

const summary = {
  gate,
  exitCode,
  runId: report.runId,
  build: report.build,
  summary: counts,
  runtime: { captureTotalMs: runtime.captureTotalMs, compareMs: runtime.sessionMs },
  scenes: rows.map((row) => ({
    id: row.id, status: row.status, changedPixels: row.metrics?.changedPixels ?? null,
    changedPercent: row.metrics?.changedPercent ?? null, maxDelta: row.metrics?.maxDelta ?? null,
    buildMatch: row.buildMatch ?? null, message: row.message ?? null
  })),
  report: path.relative(ROOT, path.join(REPORT_DIR, 'report.json')).split(path.sep).join('/'),
  html: path.relative(ROOT, path.join(REPORT_DIR, 'report.html')).split(path.sep).join('/'),
  warnings
};
console.log(JSON.stringify(summary, null, 1));
process.exitCode = exitCode;
