#!/usr/bin/env python3
"""Independent Python reference for the T-005d collision oracle.

This file shares no code with the C++ probe. It re-derives the Level.levelphysics
layout from the engine sources cited in README section 3, re-implements the
Gravity static-mesh query paths in Python and emits the same canonical query
records so the two implementations can be compared byte for byte.

Every binary32 operation is rounded explicitly with f32(): Python floats are
binary64 and would otherwise silently keep extra precision.

    python probes/collision-oracle/tests/reference_oracle.py \
        --in game-data/Blur/levels/usa_la_river/Level.levelphysics \
        --out _work/collision-oracle/reference.json
"""

import argparse
import hashlib
import json
import math
import struct
import sys

# --------------------------------------------------------------------- float32


def f32(x):
    return struct.unpack('<f', struct.pack('<f', x))[0]


def bits(x):
    return struct.unpack('<I', struct.pack('<f', x))[0]


def fdiv(a, b):
    """IEEE binary32 division, including the inf/NaN results Python raises on."""
    try:
        return f32(a / b)
    except ZeroDivisionError:
        if a == 0.0 or a != a:
            return float('nan')
        return math.copysign(float('inf'), a) * math.copysign(1.0, b)


def bhex(x):
    return '%08x' % bits(x)


# ------------------------------------------------------------------- vec math


def vadd(a, b):
    return (f32(a[0] + b[0]), f32(a[1] + b[1]), f32(a[2] + b[2]))


def vsub(a, b):
    return (f32(a[0] - b[0]), f32(a[1] - b[1]), f32(a[2] - b[2]))


def vneg(a):
    return (-a[0], -a[1], -a[2])


def vmul(a, b):
    return (f32(a[0] * b[0]), f32(a[1] * b[1]), f32(a[2] * b[2]))


def vscale(a, s):
    return (f32(a[0] * s), f32(a[1] * s), f32(a[2] * s))


def dot(a, b):
    t = f32(f32(a[0] * b[0]) + f32(a[1] * b[1]))
    return f32(t + f32(a[2] * b[2]))


def cross(a, b):
    return (f32(f32(a[1] * b[2]) - f32(a[2] * b[1])),
            f32(f32(a[2] * b[0]) - f32(a[0] * b[2])),
            f32(f32(a[0] * b[1]) - f32(a[1] * b[0])))


def vabs(a):
    return (abs(a[0]), abs(a[1]), abs(a[2]))


def vmin(a, b):
    return (a[0] if a[0] < b[0] else b[0],
            a[1] if a[1] < b[1] else b[1],
            a[2] if a[2] < b[2] else b[2])


def vmax(a, b):
    return (a[0] if a[0] > b[0] else b[0],
            a[1] if a[1] > b[1] else b[1],
            a[2] if a[2] > b[2] else b[2])


def vreciprocal(a):
    return (fdiv(1.0, a[0]), fdiv(1.0, a[1]), fdiv(1.0, a[2]))


def length(a):
    return f32(math.sqrt(dot(a, a)))


def normalise(a):
    inv = fdiv(1.0, f32(math.sqrt(dot(a, a))))
    return vscale(a, inv)


def clampf(v, lo, hi):
    return lo if v < lo else (hi if v > hi else v)


def decode_hen_dn3(packed):
    ex = packed & 0x7FF
    ey = (packed >> 11) & 0x7FF
    ez = (packed >> 22) & 0x3FF
    sx = ex - 0x800 if ex & 0x400 else ex
    sy = ey - 0x800 if ey & 0x400 else ey
    sz = ez - 0x400 if ez & 0x200 else ez
    return (fdiv(sx, 1023.0), fdiv(sy, 1023.0), fdiv(sz, 511.0))


def decode_fixed_s16(v):
    return f32(float(v) * f32(1.0 / 16384.0))


def encode_fixed_s16(v):
    scaled = f32(v * 16384.0)
    if not (-2147483648.0 < scaled < 2147483648.0):
        return 0
    t = int(scaled)  # truncation toward zero
    t &= 0xFFFF
    return t - 0x10000 if t >= 0x8000 else t


def intersect_ray_aabb(p, q, bmin, bmax):
    eps = 0.01
    d = vsub(q, p)
    rd = vreciprocal(d)
    ad = vabs(d)
    small = (ad[0] < eps, ad[1] < eps, ad[2] < eps)
    out = ((p[0] < bmin[0] or p[0] > bmax[0]),
           (p[1] < bmin[1] or p[1] > bmax[1]),
           (p[2] < bmin[2] or p[2] > bmax[2]))
    no_hit = (small[0] and out[0]) or (small[1] and out[1]) or (small[2] and out[2])
    b = not no_hit

    t1r = vmul(vsub(bmin, p), rd)
    t2r = vmul(vsub(bmax, p), rd)

    t1 = []
    t2 = []
    for i in range(3):
        con = t1r[i] > t2r[i]          # Select(con, _t2, _t1)
        t1.append(t2r[i] if con else t1r[i])
        t2.append(t1r[i] if con else t2r[i])

    tmin_v = vmax((0.0, 0.0, 0.0), tuple(t1))
    tmax_v = vmin(tuple(t2), (1.0, 1.0, 1.0))

    new_tmin = tuple(0.0 if small[i] else tmin_v[i] for i in range(3))
    new_tmax = tuple(1.0 if small[i] else tmax_v[i] for i in range(3))

    tmax = new_tmax[0] if new_tmax[0] < new_tmax[1] else new_tmax[1]
    tmax = tmax if tmax < new_tmax[2] else new_tmax[2]
    tmin = new_tmin[0] if new_tmin[0] > new_tmin[1] else new_tmin[1]
    tmin = tmin if tmin > new_tmin[2] else new_tmin[2]
    return (tmin < tmax) and b


def intersect_triangle_segment(a, b, c, p, q):
    qp = vsub(p, q)
    ab = vsub(b, a)
    ac = vsub(c, a)
    ap = vsub(p, a)
    n = cross(ab, ac)
    e = cross(qp, ap)
    den = dot(qp, n)
    rden = fdiv(1.0, den)
    t = f32(dot(ap, n) * rden)
    v = f32(dot(ac, e) * rden)
    w = f32(dot(vneg(ab), e) * rden)
    res = vsub(p, vscale(qp, t))
    ok = (den != 0.0) and (t > 0.0) and (t < 1.0) and (v > 0.0) and (v < 1.0) \
        and (w > 0.0) and (f32(v + w) < 1.0)
    return ok, res


def closest_point_triangle(p, a, b, c):
    ab = vsub(b, a)
    ac = vsub(c, a)
    ap = vsub(p, a)

    n = normalise(cross(ab, ac))
    t = dot(n, ap)
    closest_abc = vsub(p, vscale(n, t))

    d00 = dot(ab, ab)
    d01 = dot(ab, ac)
    d11 = dot(ac, ac)
    d20 = dot(ap, ab)
    d21 = dot(ap, ac)
    demo = f32(f32(d00 * d11) - f32(d01 * d01))
    rdemo = fdiv(1.0, demo)
    v = f32(f32(f32(d11 * d20) - f32(d01 * d21)) * rdemo)
    w = f32(f32(f32(d00 * d21) - f32(d01 * d20)) * rdemo)
    u = f32(f32(1.0 - v) - w)

    inside = (v > 0.0) and (v < 1.0) and (w > 0.0) and (w < 1.0) and (u > 0.0) and (u < 1.0)

    t0 = clampf(fdiv(d20, d00), 0.0, 1.0)
    closest_ab = vadd(a, vscale(ab, t0))
    t1 = clampf(fdiv(d21, d11), 0.0, 1.0)
    closest_ac = vadd(a, vscale(ac, t1))
    bc = vsub(c, b)
    t2 = clampf(fdiv(dot(vsub(p, b), bc), dot(bc, bc)), 0.0, 1.0)
    closest_bc = vadd(b, vscale(bc, t2))

    d1 = vsub(p, closest_ab)
    d2 = vsub(p, closest_ac)
    d3 = vsub(p, closest_bc)
    sq1 = dot(d1, d1)
    sq2 = dot(d2, d2)
    sq3 = dot(d3, d3)

    if inside:
        return closest_abc
    if (sq1 < sq2) and (sq1 < sq3):
        return closest_ab
    if sq2 < sq3:
        return closest_ac
    return closest_bc


def box_intersects_minmax(box_min, box_max, centre, extents):
    other_max = vadd(centre, extents)
    other_min = vsub(centre, extents)
    return ((other_max[0] >= box_min[0] and other_max[1] >= box_min[1]
             and other_max[2] >= box_min[2])
            and (other_min[0] <= box_max[0] and other_min[1] <= box_max[1]
                 and other_min[2] <= box_max[2]))


def intersect_aabb_triangle(centre, extents, a, b, c):
    e = extents
    v0 = vsub(a, centre)
    v1 = vsub(b, centre)
    v2 = vsub(c, centre)
    f0 = vsub(v1, v0)
    f1 = vsub(v2, v1)
    f2 = vsub(v0, v2)

    def axis(f, cp0, cp1):
        af = vabs(f)
        ra = (f32(f32(e[1] * af[2]) + f32(e[2] * af[1])),
              f32(f32(e[0] * af[2]) + f32(e[2] * af[0])),
              f32(f32(e[0] * af[1]) + f32(e[1] * af[0])))
        vlo = vmin(cp0, cp1)
        vhi = vmax(cp0, cp1)
        if (vhi[0] < -ra[0]) or (vhi[1] < -ra[1]) or (vhi[2] < -ra[2]):
            return False
        if (vlo[0] > ra[0]) or (vlo[1] > ra[1]) or (vlo[2] > ra[2]):
            return False
        return True

    if not axis(f0, cross(v0, f0), cross(v2, f0)):
        return False
    if not axis(f1, cross(v0, f1), cross(v1, f1)):
        return False
    if not axis(f2, cross(v0, f2), cross(v1, f2)):
        return False

    n = cross(f0, f1)
    d = dot(n, v0)
    an = vabs(n)
    r = dot(e, an)
    return abs(d) <= r


# ------------------------------------------------------------------- level file

SHAPE_TERMINATOR = 0x0FFFFFFF
CONSTRAINT_TERMINATOR = 0xFFFFFFFF


class ParseError(Exception):
    def __init__(self, code, offset, detail):
        super().__init__('%s at %d: %s' % (code, offset, detail))
        self.code = code
        self.offset = offset
        self.detail = detail


class Reader:
    def __init__(self, data, begin, end):
        self.d = data
        self.pos = begin
        self.end = end

    def need(self, n, code):
        if self.pos + n > self.end:
            raise ParseError(code, self.pos,
                             'need %d bytes before block end %d' % (n, self.end))

    def u8(self):
        self.need(1, 'read_u8')
        v = self.d[self.pos]
        self.pos += 1
        return v

    def u16(self):
        self.need(2, 'read_u16')
        v = struct.unpack_from('<H', self.d, self.pos)[0]
        self.pos += 2
        return v

    def s16(self):
        self.need(2, 'read_s16')
        v = struct.unpack_from('<h', self.d, self.pos)[0]
        self.pos += 2
        return v

    def u32(self):
        self.need(4, 'read_u32')
        v = struct.unpack_from('<I', self.d, self.pos)[0]
        self.pos += 4
        return v

    def i32(self):
        self.need(4, 'read_i32')
        v = struct.unpack_from('<i', self.d, self.pos)[0]
        self.pos += 4
        return v

    def f32(self):
        self.need(4, 'read_f32')
        v = struct.unpack_from('<f', self.d, self.pos)[0]
        self.pos += 4
        return v

    def vec3(self):
        return (self.f32(), self.f32(), self.f32())


def read_block_header(r):
    at = r.pos
    r.need(16, 'block_header_truncated')
    raw = bytes(r.d[r.pos:r.pos + 8])
    r.pos += 8
    size = r.u32()
    count = r.u16()
    typ = r.u8()
    comp = r.u8()
    ident = raw.split(b'\0')[0].decode('ascii', 'replace')
    if not ident:
        raise ParseError('block_id_empty', at, 'no characters in the 8-byte id')
    if size < 16:
        raise ParseError('block_size_too_small', at, 'size %d < 16' % size)
    if at + size > r.end:
        raise ParseError('block_overruns_parent', at,
                         "block '%s' ends beyond %d" % (ident, r.end))
    return dict(offset=at, id=ident, size=size, count=count,
                type=typ, compression=comp)


def load_level(data):
    if len(data) < 20:
        raise ParseError('file_too_small', 0, 'shorter than a root block header')
    if data[0:4] != b'  CP':
        raise ParseError('bad_pc_marker', 0, "expected '  CP'")

    root = read_block_header(Reader(data, 4, len(data)))
    if root['id'] != 'Physic':
        raise ParseError('bad_root_block', root['offset'], "id '%s'" % root['id'])
    if root['offset'] + root['size'] != len(data):
        raise ParseError('root_size_mismatch', root['offset'] + root['size'],
                         'file size mismatch')

    children = Reader(data, root['offset'] + 16, root['offset'] + root['size'])
    level = dict(fileVersion=0, routeCount=0, meshes=[], header=None,
                 main=None, routes=None)

    while children.pos < children.end:
        blk = read_block_header(children)
        if blk['id'] == 'Header':
            h = Reader(data, blk['offset'] + 16, blk['offset'] + blk['size'])
            level['fileVersion'] = h.u32()
            level['routeCount'] = h.i32()
            level['header'] = blk
            if h.pos != blk['offset'] + blk['size']:
                raise ParseError('header_block_trailing', h.pos, 'unread bytes')
        elif blk['id'] == 'Main':
            level['main'] = blk
        elif blk['id'] == 'Routes':
            level['routes'] = blk
        else:
            raise ParseError('unknown_root_child', blk['offset'], blk['id'])
        children.pos = blk['offset'] + blk['size']

    if level['header'] is None or level['main'] is None:
        raise ParseError('missing_required_block', children.end, 'Header/Main required')

    main = level['main']
    r = Reader(data, main['offset'] + 16, main['offset'] + main['size'])
    if bytes(data[r.pos:r.pos + 4]) != b'Head':
        raise ParseError('missing_gravity_head', main['offset'] + 16, 'no Head fourcc')
    r.pos += 4
    level['streamVersion'] = r.u32()

    while True:
        at = r.pos
        typ = r.u32()
        if typ == SHAPE_TERMINATOR:
            level['shapeStreamEnd'] = r.pos
            break
        if typ != 0:
            raise ParseError('unsupported_shape_type', at, 'type %d' % typ)
        mesh = parse_shape(r, level['streamVersion'])
        mesh['index'] = len(level['meshes'])
        level['meshes'].append(mesh)

    con = r.u32()
    if con != CONSTRAINT_TERMINATOR:
        raise ParseError('unsupported_constraint', r.pos - 4, 'constraint type %d' % con)
    if r.pos != r.end:
        raise ParseError('main_block_trailing', r.pos, 'unread bytes')
    if not level['meshes']:
        raise ParseError('no_static_meshes', main['offset'], 'none')
    return level


def parse_shape(r, version):
    if version < 10:
        raise ParseError('unsupported_stream_version', r.pos, 'v%d' % version)

    mesh = dict(margin=r.f32(), epsilon=r.f32(),
                physicsMaterialIndex=r.u32(), effectMaterialIndex=r.u32(),
                collisionFlag=r.u32(), nodeFlag=r.u32(), mass=r.f32(),
                originalExportID=r.u32(), renderOffset=r.vec3(),
                remapped=r.u32(), userDataFlag=r.u32())

    mesh['streamBegin'] = r.pos
    num_v = r.u32()
    num_n = r.u32()
    tri_capacity = r.u32()
    num_nodes = r.u32()
    low = r.vec3()
    high = r.vec3()
    mesh.update(numVertices=num_v, numNormals=num_n,
                triangleCapacityBytes=tri_capacity, numNodes=num_nodes,
                low=low, high=high)

    vertices = [r.vec3() for _ in range(num_v)]
    normals = [r.u32() for _ in range(num_n)]

    nodes = []
    for _ in range(num_nodes):
        q = tuple(r.s16() for _ in range(6))
        nodes.append(dict(q=q, tsi=r.u32(), start_or_right=r.u32(),
                          vertex_start=r.u32(), num_vertices=r.u32()))

    span = vsub(high, low)
    for n in nodes:
        q = n['q']
        local_min = (decode_fixed_s16(q[0]), decode_fixed_s16(q[1]), decode_fixed_s16(q[2]))
        local_max = (decode_fixed_s16(q[3]), decode_fixed_s16(q[4]), decode_fixed_s16(q[5]))
        n['box_min'] = vadd(vmul(local_min, span), low)
        n['box_max'] = vadd(vmul(local_max, span), low)

    quantised = [0] * (num_v * 3)
    leaves = []
    headers = []
    triangles = []
    stack = [0]
    buffer_offset = 0
    leaf_index = 0

    while stack:
        node_index = stack.pop()
        n = nodes[node_index]
        if n['tsi'] == 0:
            stack.append(node_index + n['start_or_right'])
            stack.append(node_index + 1)
            continue

        leaf_span = vsub(n['box_max'], n['box_min'])
        recip = vreciprocal(leaf_span)
        for i in range(n['vertex_start'], n['vertex_start'] + n['num_vertices']):
            local = vmul(vsub(vertices[i], n['box_min']), recip)
            quantised[i * 3 + 0] = encode_fixed_s16(local[0])
            quantised[i * 3 + 1] = encode_fixed_s16(local[1])
            quantised[i * 3 + 2] = encode_fixed_s16(local[2])

        n['triangle_buffer_start'] = buffer_offset
        n['first_triangle'] = len(triangles)
        n['first_header'] = len(headers)
        leaf = dict(node=node_index, first_triangle=len(triangles),
                    vertex_start=n['vertex_start'], num_vertices=n['num_vertices'],
                    tsi=n['tsi'], buffer_start=buffer_offset)
        leaves.append(leaf)
        leaf_index += 1

        def read_header(slot):
            h = dict(collisionFlags=r.u32(), physicsMaterial=r.u16(),
                     effectMaterial=r.u32(), userDataFlags=r.u32(),
                     numTriangles=r.u8(), leaf=leaf_index - 1,
                     first_triangle=len(triangles), buffer_offset=buffer_offset)
            if h['numTriangles'] == 0:
                raise ParseError('zero_triangle_header', r.pos - 1,
                                 'm_NumTriangles == 0')
            headers.append(h)
            return h

        buffer_offset += 16
        header = read_header(0)
        header_slot = len(headers) - 1
        triangle_array_offset = buffer_offset
        header_index = 0

        for a in range(n['tsi']):
            if header_index >= header['numTriangles']:
                buffer_offset += 16
                header = read_header(0)
                header_slot = len(headers) - 1
                triangle_array_offset = buffer_offset
                header_index = 0

            ia = r.u8()
            ib = r.u8()
            ic = r.u8()
            normal = r.u32()
            active = r.u32()
            if ia >= n['num_vertices'] or ib >= n['num_vertices'] or ic >= n['num_vertices']:
                raise ParseError('triangle_index_out_of_leaf', r.pos - 11,
                                 'index >= numVertices')
            triangles.append(dict(a=ia, b=ib, c=ic, normal=normal, active=active,
                                  header=header_slot, leaf=leaf_index - 1,
                                  ordinal=a,
                                  buffer_offset=triangle_array_offset + 12 * header_index))
            buffer_offset += 12
            header_index += 1

        leaf['num_triangles'] = len(triangles) - leaf['first_triangle']
        leaf['triangle_buffer_length'] = buffer_offset - leaf['buffer_start']
        n['num_headers'] = len(headers) - n['first_header']
        n['num_streamed_triangles'] = leaf['num_triangles']
        n['triangle_buffer_length'] = leaf['triangle_buffer_length']

    if buffer_offset > tri_capacity:
        raise ParseError('triangle_capacity_exceeded', r.pos,
                         '%d > %d' % (buffer_offset, tri_capacity))
    mesh['triangleBufferBytes'] = buffer_offset

    mesh['numActiveEdges'] = r.u32()
    r.pos += mesh['numActiveEdges'] * 12
    mesh['streamEnd'] = r.pos
    mesh['instanceBegin'] = r.pos
    mesh['instancePosition'] = r.vec3()
    mesh['instanceRotation'] = [r.f32() for _ in range(9)]
    mesh['instanceInertia'] = [r.f32() for _ in range(9)]

    mesh.update(vertices=vertices, normals=normals, nodes=nodes, leaves=leaves,
                headers=headers, triangles=triangles, quantised=quantised)
    mesh['isIdentityInstance'] = (
        mesh['instancePosition'] == (0.0, 0.0, 0.0)
        and mesh['instanceRotation'] == [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0])
    return mesh


# -------------------------------------------------------------------- filters


def default_filter():
    return dict(collisionFlags=0xFFFFFFFF, collisionMask=0xFFFFFFFF, groupId=0,
                groupFlags=0, groupMask=0, bodyFlags=0xFFFFFFFF,
                bodyMask=0xFFFFFFFF, negate=False)


def can_collide_flags(flt, flags):
    return flt['negate'] != ((flt['collisionMask'] & flags) != 0)


def can_collide_filter(a, b):
    poly1 = (a['collisionFlags'] & b['collisionMask']) != 0
    poly2 = (a['collisionMask'] & b['collisionFlags']) != 0
    body1 = (a['bodyFlags'] & b['bodyMask']) != 0
    body2 = (a['bodyMask'] & b['bodyFlags']) != 0
    group1 = (a['groupMask'] & b['groupFlags']) != 0
    group2 = (a['groupFlags'] & b['groupMask']) != 0
    poly = poly1 and poly2
    not_same_group = (a['groupId'] != b['groupId']) or (a['groupId'] == 0)
    inter_group = (not not_same_group) and group1 and group2
    body = body1 and body2
    neg = a['negate'] or b['negate']
    return neg != ((poly and body) and (not_same_group or inter_group))


# -------------------------------------------------------------------- queries


def leaf_vertex(mesh, node, index):
    base = (node['vertex_start'] + index) * 3
    q = mesh['quantised']
    local = (decode_fixed_s16(q[base + 0]), decode_fixed_s16(q[base + 1]),
             decode_fixed_s16(q[base + 2]))
    span = vsub(node['box_max'], node['box_min'])
    return vadd(vmul(local, span), node['box_min'])


def trace_leaf(mesh, node, ray, segment_end):
    temp = segment_end
    normal = (0.0, 0.0, 0.0)
    triangle_index = 0
    collide = False
    accepted = None
    accepted_header = None
    accepted_group = 0

    a = 0
    offset = 0
    slot = 0
    while a < node['tsi']:
        if node['first_header'] + slot >= len(mesh['headers']):
            break
        header = mesh['headers'][node['first_header'] + slot]
        num_tris = header['numTriangles']
        offset += 16
        group_offset = offset
        if can_collide_flags(ray['filter'], header['collisionFlags']):
            count = (node['tsi'] - a) if (a + num_tris > node['tsi']) else num_tris
            for i in range(count):
                tri = mesh['triangles'][header['first_triangle'] + i]
                a0 = leaf_vertex(mesh, node, tri['a'])
                b0 = leaf_vertex(mesh, node, tri['b'])
                c0 = leaf_vertex(mesh, node, tri['c'])
                nrm = decode_hen_dn3(tri['normal'])
                cos_angle = dot(nrm, ray['direction'])
                double_sided = ray['doubleSided'] and (cos_angle > 0.0)
                nsel = vneg(nrm) if double_sided else nrm
                csel = f32(-cos_angle) if double_sided else cos_angle
                bb = c0 if double_sided else b0
                cc = b0 if double_sided else c0
                hit, point = intersect_triangle_segment(a0, bb, cc, ray['start'], temp)
                if (csel < ray['maxCosAngle']) and hit:
                    temp = point
                    normal = nsel
                    triangle_index = i
                    accepted = header['first_triangle'] + i
                    accepted_header = node['first_header'] + slot
                    accepted_group = group_offset
                    collide = True
        offset = group_offset + num_tris * 12
        a += num_tris
        slot += 1

    if not collide:
        return None
    return dict(hit=True, contact=temp, normal=normal,
                distance=dot(vsub(temp, ray['start']), ray['direction']),
                engineIndex=accepted_group + 12 * triangle_index,
                header=accepted_header, triangle=accepted)


def ray_trace_mesh(mesh, ray):
    # Mirrors OptimisedAABBTree::RayTracing's explicit stack slots:
    #   stack.Push(right, size); size += 2; pStackTop = left;
    segment_end = vadd(ray['start'],
                       vscale(ray['direction'], f32(ray['maxDistance'] + ray['radius'])))
    radius = (ray['radius'], ray['radius'], ray['radius'])
    contact = segment_end
    hit = None
    hit_leaf = None

    slots = [0]
    size = 1
    top = 0
    while size != 0:
        size -= 1
        node_index = top
        pop_index = size - 1 if size > 0 else 0
        while len(slots) <= pop_index:
            slots.append(0)
        top = slots[pop_index]

        node = mesh['nodes'][node_index]
        bmin = vsub(node['box_min'], radius)
        bmax = vadd(node['box_max'], radius)
        if not intersect_ray_aabb(ray['start'], contact, bmin, bmax):
            continue
        if node['tsi'] == 0:
            while len(slots) <= size:
                slots.append(0)
            slots[size] = node_index + node['start_or_right']
            size += 2
            top = node_index + 1
            continue
        leaf = trace_leaf(mesh, node, ray, contact)
        if leaf:
            hit = leaf
            hit_leaf = node_index
            contact = leaf['contact']

    if hit is None:
        return None
    hit['leaf'] = hit_leaf
    return hit


def fill_line_cache(level, box_centre, box_extents, flt, negative_normal, max_cos):
    cache = []
    stats = dict(bodiesConsidered=0, bodiesAccepted=0, headersFiltered=0,
                 trianglesTested=0, trianglesRejectedByNormal=0)
    mesh_filter = default_filter()
    for mesh in level['meshes']:
        stats['bodiesConsidered'] += 1
        if not can_collide_filter(mesh_filter, flt):
            continue
        stats['bodiesAccepted'] += 1
        for leaf in mesh['leaves']:
            if len(cache) >= 4:
                return cache, stats
            node = mesh['nodes'][leaf['node']]
            if not box_intersects_minmax(node['box_min'], node['box_max'],
                                         box_centre, box_extents):
                continue
            a = 0
            slot = 0
            while a < node['tsi']:
                if node['first_header'] + slot >= len(mesh['headers']):
                    break
                header = mesh['headers'][node['first_header'] + slot]
                num_tris = header['numTriangles']
                if not can_collide_flags(flt, header['collisionFlags']):
                    stats['headersFiltered'] += 1
                    a += num_tris
                    slot += 1
                    continue
                count = (node['tsi'] - a) if (a + num_tris > node['tsi']) else num_tris
                for i in range(count):
                    tri = mesh['triangles'][header['first_triangle'] + i]
                    v0 = leaf_vertex(mesh, node, tri['a'])
                    v1 = leaf_vertex(mesh, node, tri['b'])
                    v2 = leaf_vertex(mesh, node, tri['c'])
                    tri_min = vmin(v0, vmin(v1, v2))
                    tri_max = vmax(v0, vmax(v1, v2))
                    stats['trianglesTested'] += 1
                    if not box_intersects_minmax(tri_min, tri_max, box_centre, box_extents):
                        continue
                    if not intersect_aabb_triangle(box_centre, box_extents, v0, v1, v2):
                        continue
                    normal = decode_hen_dn3(tri['normal'])
                    if dot(normal, negative_normal) > max_cos:
                        stats['trianglesRejectedByNormal'] += 1
                        continue
                    if len(cache) >= 4:
                        return cache, stats
                    cache.append(dict(a=v0, b=v1, c=v2, normal=normal,
                                      normalPacked=tri['normal'],
                                      engineIndex=leaf['buffer_start'] + tri['ordinal'],
                                      ordinal=tri['ordinal'], leaf=leaf['node'],
                                      collisionFlags=header['collisionFlags'],
                                      physicsMaterial=header['physicsMaterial'],
                                      effectMaterial=header['effectMaterial'] & 0xFFFF,
                                      userData=header['userDataFlags']))
                a += num_tris
                slot += 1
    return cache, stats


def cache_trace(cache, ray):
    segment_end = vadd(ray['start'],
                       vscale(ray['direction'], f32(ray['maxDistance'] + ray['radius'])))
    contact = segment_end
    hit_index = -1
    for i, tri in enumerate(cache):
        if not can_collide_flags(ray['filter'], tri['collisionFlags']):
            continue
        plane_d = f32(dot(tri['normal'], tri['a']) + ray['radius'])
        dis_start = f32(dot(ray['start'], tri['normal']) - plane_d)
        dis_end = f32(dot(segment_end, tri['normal']) - plane_d)
        if f32(dis_start * dis_end) > 0.0:
            continue
        ok, point = intersect_triangle_segment(tri['a'], tri['b'], tri['c'],
                                               ray['start'], contact)
        if ok:
            contact = point
            hit_index = i
    if hit_index < 0:
        return None
    tri = cache[hit_index]
    return dict(hit=True, leaf=tri['leaf'], engineIndex=tri['engineIndex'],
                ordinal=tri['ordinal'], collisionFlags=tri['collisionFlags'],
                physicsMaterial=tri['physicsMaterial'],
                effectMaterial=tri['effectMaterial'], userData=tri['userData'],
                normalPacked=tri['normalPacked'], normal=normalise(tri['normal']),
                contact=contact, distance=length(vsub(ray['start'], contact)))


def sphere_query_mesh(mesh, centre, radius, flt):
    radius_sq = f32(radius * radius)
    # C_CollisionResult<6,16>: six fixed patch slots plus a live count. A patch
    # slot that is prepared but then merged is not counted, exactly like
    # results.m_NumContactPatches += incr in SphereTriangle.inl:183.
    patches = [dict(normal=(0.0, 0.0, 0.0), points=0) for _ in range(6)]
    num_patches = 0
    contacts = []
    filtered = 0

    slots = [0]
    size = 1
    top = 0
    while size != 0:
        size -= 1
        node_index = top
        pop_index = size - 1 if size > 0 else 0
        while len(slots) <= pop_index:
            slots.append(0)
        top = slots[pop_index]

        node = mesh['nodes'][node_index]
        if not box_intersects_minmax(node['box_min'], node['box_max'], centre,
                                     (radius, radius, radius)):
            continue
        if node['tsi'] == 0:
            while len(slots) <= size + 1:
                slots.append(0)
            slots[size] = node_index + node['start_or_right']
            size += 1
            slots[size] = node_index + 1
            size += 1
            top = node_index + 1
            continue

        a = 0
        offset = 0
        slot = 0
        while a < node['tsi']:
            if node['first_header'] + slot >= len(mesh['headers']):
                break
            header = mesh['headers'][node['first_header'] + slot]
            num_tris = header['numTriangles']
            offset += 16
            group_offset = offset
            if not can_collide_flags(flt, header['collisionFlags']):
                filtered += 1
                offset = group_offset + num_tris * 12
                a += num_tris
                slot += 1
                continue
            count = (node['tsi'] - a) if (a + num_tris > node['tsi']) else num_tris
            for i in range(count):
                tri = mesh['triangles'][header['first_triangle'] + i]
                a0 = leaf_vertex(mesh, node, tri['a'])
                b0 = leaf_vertex(mesh, node, tri['b'])
                c0 = leaf_vertex(mesh, node, tri['c'])
                nrm = vneg(decode_hen_dn3(tri['normal']))

                point = closest_point_triangle(centre, a0, b0, c0)
                d = vsub(point, centre)
                if dot(d, d) > radius_sq:
                    continue
                surface = normalise(d)

                patch = None
                incr = 0
                if num_patches < 6:
                    patch = num_patches
                    patches[patch]['normal'] = surface
                    patches[patch]['points'] = 0
                    incr = 1
                for j in range(num_patches):
                    if dot(patches[j]['normal'], surface) >= 0.995:
                        patch = j
                        incr = 0
                        break
                if patch is None:
                    continue
                num_patches += incr
                penetration = f32(radius - dot(d, nrm))
                if patches[patch]['points'] < 16:
                    patches[patch]['points'] += 1
                    contacts.append(dict(point=point, surfaceNormal=surface,
                                         penetration=penetration,
                                         ordinal=tri['ordinal'],
                                         engineHashValue=group_offset + i,
                                         physicsMaterial=header['physicsMaterial'],
                                         effectMaterial=header['effectMaterial'],
                                         patch=patch))
            offset = group_offset + num_tris * 12
            a += num_tris
            slot += 1

    return dict(hit=bool(contacts), patchCount=num_patches,
                headersFiltered=filtered, contacts=contacts)


# ------------------------------------------------------------------ query table


class Rng:
    def __init__(self, seed):
        self.s = seed if seed else 1

    def next(self):
        s = self.s
        s ^= (s << 13) & 0xFFFFFFFF
        s ^= s >> 17
        s ^= (s << 5) & 0xFFFFFFFF
        self.s = s & 0xFFFFFFFF
        return self.s

    def unit(self):
        return f32(float(self.next() >> 8) * f32(1.0 / 16777216.0))


def lerp_bounds(lo, hi, ux, uy, uz):
    return (f32(lo[0] + f32(f32(hi[0] - lo[0]) * ux)),
            f32(lo[1] + f32(f32(hi[1] - lo[1]) * uy)),
            f32(lo[2] + f32(f32(hi[2] - lo[2]) * uz)))


def normalized_or_up(d):
    len2 = dot(d, d)
    if not (len2 > f32(1.0e-6)):
        return (0.0, 1.0, 0.0)
    n = f32(math.sqrt(len2))
    return (fdiv(d[0], n), fdiv(d[1], n), fdiv(d[2], n))


def total_triangles(level):
    return sum(len(m['triangles']) for m in level['meshes'])


def global_triangle(level, ordinal):
    for mesh in level['meshes']:
        if ordinal < len(mesh['triangles']):
            tri = mesh['triangles'][ordinal]
            node = mesh['nodes'][mesh['leaves'][tri['leaf']]['node']]
            return dict(mesh=mesh['index'], node=node, tri=tri,
                        a=leaf_vertex(mesh, node, tri['a']),
                        b=leaf_vertex(mesh, node, tri['b']),
                        c=leaf_vertex(mesh, node, tri['c']),
                        normal=decode_hen_dn3(tri['normal']))
        ordinal -= len(mesh['triangles'])
    return None


def centroid(t):
    sx = f32(f32(t['a'][0] + t['b'][0]) + t['c'][0])
    sy = f32(f32(t['a'][1] + t['b'][1]) + t['c'][1])
    sz = f32(f32(t['a'][2] + t['b'][2]) + t['c'][2])
    return (fdiv(sx, 3.0), fdiv(sy, 3.0), fdiv(sz, 3.0))


def bounds(level):
    lo = level['meshes'][0]['low']
    hi = level['meshes'][0]['high']
    for m in level['meshes']:
        lo = vmin(lo, m['low'])
        hi = vmax(hi, m['high'])
    return lo, hi


def build_table(level):
    lo, hi = bounds(level)
    total = total_triangles(level)

    rays = []
    for i in range(12):
        gx = i % 4
        gz = i // 4
        ux = f32((float(gx) + 0.5) * 0.25)
        uz = fdiv(float(gz) + 0.5, 3.0)
        start = (f32(lo[0] + f32(f32(hi[0] - lo[0]) * ux)),
                 f32(f32(hi[1] + 2.0) + 2.0),
                 f32(lo[2] + f32(f32(hi[2] - lo[2]) * uz)))
        rays.append(dict(label='ray-down-%d' % i, start=start,
                         direction=(0.0, -1.0, 0.0),
                         maxDistance=f32(f32(hi[1] - lo[1]) + 8.0), radius=0.0,
                         maxCosAngle=-0.25, doubleSided=False,
                         filter=default_filter()))
    for i in range(12, 24):
        rng = Rng(0xA5A50000 + i)
        ordinal = 0 if total == 0 else (rng.next() % total)
        t = global_triangle(level, ordinal)
        target = centroid(t) if t else lerp_bounds(lo, hi, 0.5, 0.5, 0.5)
        ox = f32(f32(rng.unit() * 2.0) - 1.0)
        oy = f32(f32(rng.unit() * 2.0) - 1.0)
        oz = f32(f32(rng.unit() * 2.0) - 1.0)
        d = normalized_or_up((ox, oy, oz))
        rays.append(dict(label='ray-random-%d' % i,
                         start=vadd(target, vscale(d, 40.0)), direction=vneg(d),
                         maxDistance=60.0, radius=0.0, maxCosAngle=1.0,
                         doubleSided=False, filter=default_filter()))

    spheres = []
    for i in range(6):
        ordinal = 0 if total == 0 else (i * total) // 6
        t = global_triangle(level, ordinal)
        centre = t['a'] if t else lerp_bounds(lo, hi, 0.5, 0.5, 0.5)
        spheres.append(dict(label='point-vertex-%d' % i, centre=centre, radius=0.0))
    for i in range(10):
        rng = Rng(0xBEEF0000 + i)
        ordinal = 0 if total == 0 else (rng.next() % total)
        radius = f32(0.25 + f32(2.0 * rng.unit()))
        t = global_triangle(level, ordinal)
        if t:
            centre = vadd(centroid(t), vscale(t['normal'], f32(0.5 * radius)))
        else:
            centre = lerp_bounds(lo, hi, 0.5, 0.5, 0.5)
        spheres.append(dict(label='sphere-near-%d' % i, centre=centre, radius=radius))
    for i in range(16, 24):
        rng = Rng(0xC0DE0000 + i)
        ux = rng.unit()
        uy = rng.unit()
        uz = rng.unit()
        centre = lerp_bounds(lo, hi, ux, uy, uz)
        radius = f32(0.5 + f32(3.0 * rng.unit()))
        spheres.append(dict(label='sphere-empty-%d' % i, centre=centre, radius=radius))

    cache_queries = []
    for i in range(8):
        ordinal = 0 if total == 0 else (i * total) // 8
        t = global_triangle(level, ordinal)
        if i + 1 == 8:
            centre = (f32((lo[0] + hi[0]) * 0.5), f32((lo[1] + hi[1]) * 0.5),
                      f32((lo[2] + hi[2]) * 0.5))
            extents = (f32(f32((hi[0] - lo[0]) * 0.5) + 10.0),
                       f32(f32((hi[1] - lo[1]) * 0.5) + 10.0),
                       f32(f32((hi[2] - lo[2]) * 0.5) + 10.0))
        elif t:
            centre = vadd(centroid(t), vscale(t['normal'], 1.0))
            extents = (1.5, 1.5, 1.5)
        else:
            centre = lerp_bounds(lo, hi, 0.5, 0.5, 0.5)
            extents = (1.5, 1.5, 1.5)
        trace_start = (centre[0], f32(f32(centre[1] + extents[1]) + 2.0), centre[2])
        cache_queries.append(dict(
            label='cache-%d' % i, centre=centre, extents=extents,
            negativeNormal=(0.0, -1.0, 0.0), maxCosAngle=-0.25,
            trace=dict(start=trace_start, direction=(0.0, -1.0, 0.0),
                       maxDistance=20.0, radius=0.0, maxCosAngle=-0.25,
                       doubleSided=False, filter=default_filter())))
    return rays, spheres, cache_queries


# --------------------------------------------------------------------- records


class Bin:
    def __init__(self):
        self.b = bytearray()

    def u8(self, v):
        self.b.append(v & 0xFF)

    def u16(self, v):
        self.b += struct.pack('<H', v & 0xFFFF)

    def u32(self, v):
        self.b += struct.pack('<I', v & 0xFFFFFFFF)

    def f32(self, v):
        self.b += struct.pack('<f', v)

    def vec3(self, v):
        self.f32(v[0])
        self.f32(v[1])
        self.f32(v[2])


def build_records(level):
    rays, spheres, cache_queries = build_table(level)
    canonical = bytearray()
    out_rays = []
    out_spheres = []
    out_cache = []

    for i, ray in enumerate(rays):
        result = None
        mesh_index = None
        bodies = 0
        for mesh in level['meshes']:
            bodies += 1
            result = ray_trace_mesh(mesh, ray)
            if result:
                mesh_index = mesh['index']
                break

        rec = Bin()
        rec.u8(1)
        rec.u8(1 if result else 0)
        rec.u16(0)
        rec.u32(i)
        if result:
            mesh = level['meshes'][mesh_index]
            header = mesh['headers'][result['header']]
            tri = mesh['triangles'][result['triangle']]
            rec.u32(mesh_index)
            rec.u32(result['leaf'])
            rec.u32(tri['ordinal'])
            rec.u32(result['engineIndex'])
            rec.u32(result['header'])
            rec.u32(header['collisionFlags'])
            rec.u32(header['physicsMaterial'])
            rec.u32(header['effectMaterial'])
            rec.u32(header['userDataFlags'])
            rec.u32(tri['normal'])
            rec.vec3(result['contact'])
            rec.vec3(result['normal'])
            rec.f32(result['distance'])
        else:
            for _ in range(5):
                rec.u32(0xFFFFFFFF)
            for _ in range(5):
                rec.u32(0)
            rec.vec3((0.0, 0.0, 0.0))
            rec.vec3((0.0, 0.0, 0.0))
            rec.f32(0.0)
        rec.u32(bodies)
        canonical += rec.b
        out_rays.append(dict(label=ray['label'], record=rec.b.hex()))

    for i, sq in enumerate(spheres):
        rec = Bin()
        rec.u8(2)
        hit_pos = len(rec.b)
        rec.u8(0)
        rec.u16(0)
        rec.u32(i)
        rec.f32(sq['radius'])
        rec.vec3(sq['centre'])
        body_data = Bin()
        any_hit = False
        filtered = 0
        total_contacts = 0
        for mesh in level['meshes']:
            sr = sphere_query_mesh(mesh, sq['centre'], sq['radius'], default_filter())
            any_hit = any_hit or sr['hit']
            filtered += sr['headersFiltered']
            for c in sr['contacts']:
                total_contacts += 1
                body_data.u32(mesh['index'])
                body_data.u32(c['ordinal'])
                body_data.u32(c['engineHashValue'])
                body_data.u32(c['patch'])
                body_data.u32(c['physicsMaterial'])
                body_data.u32(c['effectMaterial'])
                body_data.vec3(c['point'])
                body_data.vec3(c['surfaceNormal'])
                body_data.f32(c['penetration'])
        rec.b[hit_pos] = 1 if any_hit else 0
        rec.u32(filtered)
        rec.u32(total_contacts)
        rec.b += body_data.b
        canonical += rec.b
        out_spheres.append(dict(label=sq['label'], record=rec.b.hex(), hit=any_hit,
                                contactCount=total_contacts))

    for i, cq in enumerate(cache_queries):
        cache, stats = fill_line_cache(level, cq['centre'], cq['extents'],
                                       default_filter(), cq['negativeNormal'],
                                       cq['maxCosAngle'])
        trace = cache_trace(cache, cq['trace'])
        rec = Bin()
        rec.u8(3)
        rec.u8(1 if trace else 0)
        rec.u16(0)
        rec.u32(i)
        rec.u32(len(cache))
        rec.u32(stats['bodiesConsidered'])
        rec.u32(stats['bodiesAccepted'])
        rec.u32(stats['headersFiltered'])
        rec.u32(stats['trianglesTested'])
        rec.u32(stats['trianglesRejectedByNormal'])
        for t in cache:
            rec.u32(t['engineIndex'])
            rec.u32(t['ordinal'])
            rec.u32(t['leaf'])
            rec.u32(t['collisionFlags'])
            rec.u32(t['physicsMaterial'])
            rec.u32(t['effectMaterial'])
            rec.u32(t['userData'])
            rec.u32(t['normalPacked'])
            rec.vec3(t['a'])
            rec.vec3(t['b'])
            rec.vec3(t['c'])
        if trace:
            rec.u32(trace['engineIndex'])
            rec.u32(trace['ordinal'])
            rec.u32(trace['leaf'])
            rec.u32(trace['collisionFlags'])
            rec.u32(trace['physicsMaterial'])
            rec.u32(trace['effectMaterial'])
            rec.u32(trace['userData'])
            rec.u32(trace['normalPacked'])
            rec.vec3(trace['contact'])
            rec.vec3(trace['normal'])
            rec.f32(trace['distance'])
        else:
            for _ in range(3):
                rec.u32(0xFFFFFFFF)
            for _ in range(5):
                rec.u32(0)
            rec.vec3((0.0, 0.0, 0.0))
            rec.vec3((0.0, 0.0, 0.0))
            rec.f32(0.0)
        canonical += rec.b
        out_cache.append(dict(label=cq['label'], record=rec.b.hex(),
                              cachedTriangles=len(cache)))

    hashes = dict(queryHash=hashlib.sha256(bytes(canonical)).hexdigest(),
                  canonicalRecordBytes=len(canonical))
    return out_rays, out_spheres, out_cache, hashes


def mesh_hashes(mesh):
    vb = bytearray()
    for v in mesh['vertices']:
        vb += struct.pack('<fff', *v)
    qb = bytearray()
    for q in mesh['quantised']:
        qb += struct.pack('<H', q & 0xFFFF)
    nb = bytearray()
    for n in mesh['normals']:
        nb += struct.pack('<I', n)
    nodeb = bytearray()
    for n in mesh['nodes']:
        nodeb += struct.pack('<ffffff', n['box_min'][0], n['box_min'][1], n['box_min'][2],
                             n['box_max'][0], n['box_max'][1], n['box_max'][2])
        nodeb += struct.pack('<IIIIII', n['tsi'], n['start_or_right'],
                             n['vertex_start'], n['num_vertices'],
                             n.get('triangle_buffer_start', 0),
                             n.get('triangle_buffer_length', 0))
    trib = bytearray()
    for t in mesh['triangles']:
        trib += struct.pack('<BBBI', t['a'], t['b'], t['c'], t['normal'])
        trib += struct.pack('<III', t['active'], t['leaf'], t['ordinal'])
        trib += struct.pack('<I', t['buffer_offset'])
    return dict(index=mesh['index'], numVertices=mesh['numVertices'],
                numNormals=mesh['numNormals'], numTriangles=len(mesh['triangles']),
                numLeaves=len(mesh['leaves']), numNodes=mesh['numNodes'],
                numHeaders=len(mesh['headers']),
                numActiveEdges=mesh['numActiveEdges'],
                triangleCapacityBytes=mesh['triangleCapacityBytes'],
                triangleBufferBytes=mesh['triangleBufferBytes'],
                vertexStreamHash=hashlib.sha256(bytes(vb)).hexdigest(),
                vertexQuantisedHash=hashlib.sha256(bytes(qb)).hexdigest(),
                normalHash=hashlib.sha256(bytes(nb)).hexdigest(),
                nodeHash=hashlib.sha256(bytes(nodeb)).hexdigest(),
                triangleHash=hashlib.sha256(bytes(trib)).hexdigest(),
                identityInstance=mesh['isIdentityInstance'])


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='input', required=True)
    ap.add_argument('--out', dest='output', required=True)
    args = ap.parse_args(argv)

    with open(args.input, 'rb') as fh:
        data = fh.read()

    result = dict(status='ok', inputSize=len(data),
                  inputSha256=hashlib.sha256(data).hexdigest())
    try:
        level = load_level(data)
        rays, spheres, cache, hashes = build_records(level)
        result.update(meshes=[mesh_hashes(m) for m in level['meshes']],
                      rays=rays, spheres=spheres, cacheQueries=cache,
                      hashes=hashes,
                      counts=dict(totalTriangles=total_triangles(level),
                                  rayCount=len(rays), sphereCount=len(spheres),
                                  cacheCount=len(cache)))
    except ParseError as exc:
        result.update(status='error',
                      error=dict(code=exc.code, offset=exc.offset, detail=exc.detail))

    with open(args.output, 'w', encoding='utf-8') as fh:
        json.dump(result, fh, ensure_ascii=False)
    print('%s: %s' % (args.output, result['status']))
    if result['status'] == 'error':
        print('  %s at %d: %s' % (result['error']['code'], result['error']['offset'],
                                  result['error']['detail']))
        return 1
    print('  queryHash %s' % result['hashes']['queryHash'])
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
