"""Print the exact numbers used by docs/work/analysis/prop-textures.md."""
import json
from pathlib import Path

ROOT = Path('.')
m = json.loads((ROOT / '_work/prop-textures/candidates.json').read_text(encoding='utf-8'))

print('manifest bytes', (ROOT / '_work/prop-textures/candidates.json').stat().st_size)
print('content', m['contentSha256'])
print('summary', json.dumps(m['summary'], indent=1, sort_keys=True))

print('\nplacements')
for p in m['placements']:
    print(p['index'], p['drawIds'], 'tris', p['triangles'], 'peak', p['peakCoverage'], 'tick', p['peakTick'], 'ticks', p['coverageTicks'])

print('\nBC3 draws')
for r in m['draws']:
    if r.get('texture', {}).get('alpha'):
        print(r['id'], r['triangleCount'], r['screen']['coverageProxy']['peakFraction'], r['screen']['coverageProxy']['peakTick'], r['screen']['coverageProxy']['ticks'])

print('\nstatus counts')
from collections import Counter
print(Counter(r['candidateStatus'] for r in m['draws']))
print(Counter((r['sourceKind'], r['candidateStatus']) for r in m['draws']))

print('\nlevel textures')
for k, v in m['levelTextures'].items():
    print(k, v)

print('\ninputs')
for k, v in m['inputs'].items():
    print(k, v)

print('\ntrack diagnostics sections')
print(Counter(r['sectionKey'] for r in m['draws'] if r['sourceKind'] == 'track-visual' and r['diagnostic']))
print('track diagnostic triangles', sum(r['triangleCount'] for r in m['draws'] if r['sourceKind'] == 'track-visual' and r['diagnostic']))

print('\nlevel draw table')
for r in m['draws']:
    if r['sourceKind'] == 'level-instance':
        print(r['instanceIndex'], r['basePrimitiveIndex'], r['triangleCount'], r['texture']['id'], r['texture']['name'], r['texture']['format'],
              r['candidateStatus'], r['safeToBind'], r['classification']['propClasses'], r['classification']['placementIndex'],
              r['screen']['coverageProxy']['peakFraction'], r['screen']['coverageProxy']['peakTick'])
