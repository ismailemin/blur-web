// Print the split-screen plan as Markdown tables for the analysis document.
//
//   node probes/split-screen/print-tables.mjs
//
// Read-only over the plan JSON; no values are typed in here.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const plan = JSON.parse(readFileSync(join(ROOT, '_work', 'split-screen', 'plan.json'), 'utf8'));

const kb = (bytes) => (bytes / 1024).toFixed(1);
const mb = (bytes) => (bytes / 1e6).toFixed(2);
const ms = (value) => value.toFixed(2);
const pct = (value) => (value * 100).toFixed(1) + '%';

console.log('### Layouts\n');
console.log('| layout | players | viewport (device px) | aspect | vFOV | hFOV | pixel share | HUD scale |');
console.log('|---|---:|---|---:|---:|---:|---:|---:|');
for (const layout of plan.layouts) {
  for (const view of layout.views) {
    console.log('| `' + layout.id + '` | ' + view.player + ' | ' + view.rect.w + 'x' + view.rect.h +
      ' at (' + view.rect.x + ',' + view.rect.y + ') | ' + view.aspect.toFixed(3) + ' | ' +
      view.fov.verticalDegrees.toFixed(2) + '&deg; | ' + view.fov.horizontalDegrees.toFixed(2) +
      '&deg; | ' + (view.pixelShare * 100).toFixed(1) + '% | ' + layout.hudScale + ' |');
  }
}

for (const mapId of Object.keys(plan.maps)) {
  console.log('\n### ' + mapId + ' — per-view and per-frame work\n');
  console.log('| players | draws/view | tris/view | verts/view | index MB/view | uniform A KB/view | frame draws | frame tris | frame index MB | uniform A MB/frame | uniform B MB/frame |');
  console.log('|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of plan.maps[mapId].rows) {
    console.log('| ' + row.players + ' | ' + row.perView.draws + ' | ' + row.perView.triangles +
      ' | ' + row.perView.vertices + ' | ' + mb(row.perView.indexBytes) + ' | ' +
      kb(row.perView.drawUniformBytes) + ' | ' + row.frame.draws + ' | ' + row.frame.triangles +
      ' | ' + mb(row.frame.indexBytes) + ' | ' + mb(row.frame.uniformBytesOptionA) + ' | ' +
      mb(row.frame.uniformBytesOptionB) + ' |');
  }
}

console.log('\n### Frame-time bounds\n');
console.log('| map | players | linear p50 | linear p95 | linear max | draw-bound | 60 Hz status | 30 Hz status |');
console.log('|---|---:|---:|---:|---:|---:|---|---|');
for (const mapId of Object.keys(plan.verdict.byMap)) {
  const rows = plan.verdict.byMap[mapId];
  for (const players of [1, 2, 3, 4]) {
    const r60 = rows.find((row) => row.hz === 60 && row.players === players);
    const r30 = rows.find((row) => row.hz === 30 && row.players === players);
    console.log('| ' + mapId + ' | ' + players + ' | ' + ms(r60.linearViewMs * 6.945 / 6.975) +
      ' | ' + ms(r60.linearViewMs) + ' | ' + ms(r60.linearViewMs * 7.09 / 6.975) + ' | ' +
      ms(r60.drawBoundMs) + ' | ' + r60.status + ' | ' + r30.status + ' |');
  }
}

console.log('\n### Remote-car LOD lever\n');
console.log('| map | players | full frame draws | LOD frame draws | LOD draw-bound | LOD 30 Hz status |');
console.log('|---|---:|---:|---:|---:|---|');
for (const mapId of Object.keys(plan.verdict.byMap)) {
  const rows = plan.verdict.byMap[mapId].filter((row) => row.hz === 30);
  for (const row of rows) {
    console.log('| ' + mapId + ' | ' + row.players + ' | ' +
      plan.maps[mapId].rows.find((entry) => entry.players === row.players).frame.draws + ' | ' +
      row.withRemoteLod.frameDraws + ' | ' + ms(row.withRemoteLod.drawBoundMs) + ' | ' +
      row.withRemoteLod.status + ' |');
  }
}
