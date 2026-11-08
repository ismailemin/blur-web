// Write _work/career/reachability.json from the manifest + content descriptor.
// Run with the bundled Node from the repository root.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCareer } from '../rules/career.mjs';
import { evaluateReachability } from '../rules/reachability.mjs';
import { hashOf } from '../rules/hash.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, '_work', 'career', 'career.json'), 'utf8'));
const content = JSON.parse(fs.readFileSync(path.join(root, '_work', 'career', 'content.json'), 'utf8'));
const career = loadCareer(manifest);
const report = evaluateReachability(career, content, { includeEvents: true });
const text = JSON.stringify(report, null, 1);
fs.writeFileSync(path.join(root, '_work', 'career', 'reachability.json'), text + '\n', 'utf8');
const hashes = {
  'career.json': hashOf(manifest),
  'content.json': hashOf(content),
  'reachability.json': hashOf(report),
  summary: report.totals,
};
fs.writeFileSync(path.join(root, '_work', 'career', 'hashes.json'), JSON.stringify(hashes, null, 1) + '\n', 'utf8');
console.log(JSON.stringify({ totals: report.totals, tiers: report.tiers.map((t) => ({
  tier: t.index + 1, name: t.name, unlocked: t.unlocked, stars: t.stars,
  directPlayable: t.directPlayable, completed: t.completed, blocked: t.blocked,
})) }, null, 1));
