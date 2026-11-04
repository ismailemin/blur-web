#!/usr/bin/env python3
"""Compare an engine formatVersion-1 document with a probe formatVersion-2 document.

    python probes/collision-oracle/tests/compare_engine_v1_to_v2.py \
        --engine _work/engine-gravity-spike/gravity_a.json \
        --probe  _work/collision-oracle/native.json

The engine harness (engine/harness/t005d) still emits formatVersion 1 records.
This tool decodes those v1 records and compares every *engine-assigned* field
with the corresponding engine-value field in the probe's v2 records:

  sphere  contact.physicsMaterial / effectMaterial  vs enginePackedMaterial
  sphere  contact.normal                            vs patchNormal
  cache   entry.engineTriangleIndex                 vs engineTriangleStreamValue
  trace   engineTriangleIndex                       vs engineTriangleStreamValue
  trace   normal                                    vs engineNormalStored
  trace   collisionFlags                            -- EXCLUDED (unassigned)

It cannot compare queryHash values: the two documents use different record
layouts. It is a field-level proof only. `trace.collisionFlags` is excluded
because the engine's thin `C_LineCollisionCache::Trace` branch never assigns
`C_RayTracingResult::m_CollisionFlags`; v2 records
`collisionFlagsAssignedByEngine:0` and a zero sentinel instead of the
indeterminate engine memory. The measured engine word is printed for evidence.

Exit codes: 0 all assigned fields match, 1 a difference, 2 bad input.
"""

import argparse
import json
import struct
import sys


def u32(b, o):
    return struct.unpack_from('<I', b, o)[0]


def f32(b, o):
    return struct.unpack_from('<f', b, o)[0]


def vec3(b, o):
    return (f32(b, o), f32(b, o + 4), f32(b, o + 8))


def bits(x):
    return struct.unpack('<I', struct.pack('<f', x))[0]


def bits3(v):
    return tuple(bits(x) for x in v)


class Result:
    def __init__(self):
        self.checked = 0
        self.diffs = []
        self.trace_flags = []

    def field(self, kind, label, name, engine, probe):
        self.checked += 1
        if engine != probe:
            self.diffs.append((kind, label, name, engine, probe))


def compare(engine_doc, probe_doc):
    out = Result()
    if probe_doc.get('formatVersion') != 2:
        raise ValueError('probe document is not formatVersion 2')
    if len(engine_doc.get('rays', [])) != len(probe_doc.get('rays', [])):
        raise ValueError('ray count differs')
    if len(engine_doc.get('spheres', [])) != len(probe_doc.get('spheres', [])):
        raise ValueError('sphere query count differs')
    if len(engine_doc.get('cacheQueries', [])) != len(probe_doc.get('cacheQueries', [])):
        raise ValueError('cache query count differs')

    # ---- rays: v1 and v2 differ only in the u16 formatVersion at offset 2.
    for er, pr in zip(engine_doc['rays'], probe_doc['rays']):
        eb = bytes.fromhex(er['record'])
        pb = bytes.fromhex(pr['record'])
        out.field('ray', er['label'], 'payload-without-formatVersion',
                  eb[:2] + eb[4:], pb[:2] + pb[4:])

    # ---- spheres: v1 contact 52 B, v2 contact 80 B.
    for es, ps in zip(engine_doc['spheres'], probe_doc['spheres']):
        eb = bytes.fromhex(es['record'])
        pb = bytes.fromhex(ps['record'])
        ecount = u32(eb, 28)
        pcount = u32(pb, 28)
        out.field('sphere', es['label'], 'hit', eb[1], pb[1])
        out.field('sphere', es['label'], 'contactCount', ecount, pcount)
        if ecount != pcount:
            continue
        for i in range(ecount):
            eo = 32 + i * 52
            po = 32 + i * 80
            out.field('sphere', es['label'], 'mesh', u32(eb, eo), u32(pb, po))
            out.field('sphere', es['label'], 'perTriangleOrdinal',
                      u32(eb, eo + 4), u32(pb, po + 4))
            out.field('sphere', es['label'], 'engineHashValue',
                      u32(eb, eo + 8), u32(pb, po + 8))
            out.field('sphere', es['label'], 'patchIndex',
                      u32(eb, eo + 12), u32(pb, po + 12))
            out.field('sphere', es['label'], 'enginePhysicsMaterial',
                      u32(eb, eo + 16), u32(pb, po + 24))
            out.field('sphere', es['label'], 'engineEffectMaterial',
                      u32(eb, eo + 20), u32(pb, po + 36))
            out.field('sphere', es['label'], 'point',
                      bits3(vec3(eb, eo + 24)), bits3(vec3(pb, po + 40)))
            out.field('sphere', es['label'], 'patchNormal',
                      bits3(vec3(eb, eo + 36)), bits3(vec3(pb, po + 52)))
            out.field('sphere', es['label'], 'penetration',
                      bits(f32(eb, eo + 48)), bits(f32(pb, po + 76)))

    # ---- cache: v1 entry 68 B, v2 entry 76 B; v1 trace 60 B, v2 trace 88 B.
    for ec, pc in zip(engine_doc['cacheQueries'], probe_doc['cacheQueries']):
        eb = bytes.fromhex(ec['record'])
        pb = bytes.fromhex(pc['record'])
        en = u32(eb, 8)
        pn = u32(pb, 8)
        out.field('cache', ec['label'], 'traceHit', eb[1], pb[1])
        out.field('cache', ec['label'], 'cachedTriangles', en, pn)
        if en != pn:
            continue
        for i in range(en):
            eo = 32 + i * 68
            po = 32 + i * 76
            out.field('cache', ec['label'], 'engineTriangleStreamValue',
                      u32(eb, eo), u32(pb, po))
            out.field('cache', ec['label'], 'perTriangleOrdinal',
                      u32(eb, eo + 4), u32(pb, po + 8))
            out.field('cache', ec['label'], 'leaf', u32(eb, eo + 8), u32(pb, po + 12))
            out.field('cache', ec['label'], 'collisionFlags',
                      u32(eb, eo + 12), u32(pb, po + 16))
            out.field('cache', ec['label'], 'physicsMaterial',
                      u32(eb, eo + 16), u32(pb, po + 20))
            out.field('cache', ec['label'], 'effectMaterialStored',
                      u32(eb, eo + 20), u32(pb, po + 24))
            out.field('cache', ec['label'], 'userData', u32(eb, eo + 24), u32(pb, po + 32))
            out.field('cache', ec['label'], 'normalPacked',
                      u32(eb, eo + 28), u32(pb, po + 36))
            out.field('cache', ec['label'], 'vertices',
                      bits3(vec3(eb, eo + 32)) + bits3(vec3(eb, eo + 44)) +
                      bits3(vec3(eb, eo + 56)),
                      bits3(vec3(pb, po + 40)) + bits3(vec3(pb, po + 52)) +
                      bits3(vec3(pb, po + 64)))

        eo = 32 + en * 68
        po = 32 + en * 76
        if eb[1]:
            out.field('trace', ec['label'], 'engineTriangleStreamValue',
                      u32(eb, eo), u32(pb, po))
            out.field('trace', ec['label'], 'perTriangleOrdinal',
                      u32(eb, eo + 4), u32(pb, po + 8))
            out.field('trace', ec['label'], 'leaf', u32(eb, eo + 8), u32(pb, po + 12))
            out.field('trace', ec['label'], 'physicsMaterial',
                      u32(eb, eo + 16), u32(pb, po + 28))
            out.field('trace', ec['label'], 'effectMaterialStored',
                      u32(eb, eo + 20), u32(pb, po + 32))
            out.field('trace', ec['label'], 'userData', u32(eb, eo + 24), u32(pb, po + 40))
            out.field('trace', ec['label'], 'normalPacked',
                      u32(eb, eo + 28), u32(pb, po + 44))
            out.field('trace', ec['label'], 'contact',
                      bits3(vec3(eb, eo + 32)), bits3(vec3(pb, po + 48)))
            out.field('trace', ec['label'], 'engineNormalStored',
                      bits3(vec3(eb, eo + 44)), bits3(vec3(pb, po + 60)))
            out.field('trace', ec['label'], 'distance',
                      bits(f32(eb, eo + 56)), bits(f32(pb, po + 84)))
            # Contract check, not an equality: v2 must say "unassigned".
            if u32(pb, po + 16) != 0:
                out.diffs.append(('trace', ec['label'],
                                  'collisionFlagsAssignedByEngine expected 0',
                                  u32(eb, eo + 12), u32(pb, po + 16)))
            out.trace_flags.append((ec['label'], u32(eb, eo + 12), u32(pb, po + 24)))
    return out


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument('--engine', required=True, help='engine formatVersion-1 JSON document')
    ap.add_argument('--probe', required=True, help='probe formatVersion-2 JSON document')
    args = ap.parse_args(argv)
    try:
        with open(args.engine, encoding='utf-8') as fh:
            engine_doc = json.load(fh)
        with open(args.probe, encoding='utf-8') as fh:
            probe_doc = json.load(fh)
        out = compare(engine_doc, probe_doc)
    except (OSError, ValueError) as exc:
        print('error: %s' % exc)
        return 2

    print('checked %d assigned field group(s)' % out.checked)
    for label, engine_flags, probe_flags in out.trace_flags:
        print('trace %-9s engine m_CollisionFlags=%s (unassigned)  probe cachedTriangleFlags=%s'
              % (label, hex(engine_flags), hex(probe_flags)))
    if out.diffs:
        print('DIFFS %d' % len(out.diffs))
        for diff in out.diffs[:40]:
            print(diff)
        return 1
    print('MATCH: every engine-assigned field equals the v2 engine-value field.')
    print('EXCLUDED: trace.collisionFlags (engine never assigns it).')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
