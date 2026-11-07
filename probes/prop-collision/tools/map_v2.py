import json, math
from PIL import Image, ImageDraw, ImageFont

ROOT = r'C:\Users\ismailemin\Documents\Blur Web'
base = json.load(open(ROOT + r'\_work\prop-collision\colliders-v2.json'))
r04 = json.load(open(ROOT + r'\_work\free-roam-prop\colliders-r04-v2.json'))
committed = json.load(open(ROOT + r'\_work\prop-collision\colliders.json'))
path = json.load(open(ROOT + r'\_work\drivable-path\path.json'))
loops = json.load(open(ROOT + r'\_work\lap-search\loops.json'))
loop01 = [p for p in loops['loops'] if p['id'] == 'loop-01'][0]['points']

xmin, xmax, zmin, zmax = -125, 205, 990, 1325
scale = 4.0
W, H = int((xmax - xmin) * scale), int((zmax - zmin) * scale)
img = Image.new('RGB', (W, H), 'white')
d = ImageDraw.Draw(img)

def X(x): return (x - xmin) * scale
def Y(z): return (zmax - z) * scale

def poly(points, fill=None, outline=None, width=1):
    d.polygon([(X(x), Y(z)) for x, z in points], fill=fill, outline=outline, width=width)

def corners(c):
    cx, cz = c['center'][0], c['center'][2]
    ux, uz = c['axes'][0][0], c['axes'][0][2]
    vx, vz = c['axes'][2][0], c['axes'][2][2]
    hu, hv = c['half'][0], c['half'][2]
    return [(cx + ux * hu + vx * hv, cz + uz * hu + vz * hv),
            (cx + ux * hu - vx * hv, cz + uz * hu - vz * hv),
            (cx - ux * hu - vx * hv, cz - uz * hu - vz * hv),
            (cx - ux * hu + vx * hv, cz - uz * hu + vz * hv)]

# committed colliders (light grey)
for c in committed['colliders']:
    poly(corners(c), outline=(190, 190, 190), width=1)
# base v2 colliders not in committed (orange)
old = {c['id'] for c in committed['colliders']}
newbase = [c for c in base['colliders'] if c['id'] not in old]
for c in newbase:
    poly(corners(c), outline=(230, 140, 0), width=1)
# r04 v2 colliders not in committed r04 (red)
r04old = {c['id'] for c in json.load(open(ROOT + r'\_work\free-roam-prop\colliders-r04.json'))['colliders']}
for c in r04['colliders']:
    if c['id'] not in r04old:
        poly(corners(c), outline=(200, 0, 0), width=2)
# on-course inactive base v2 (purple)
for c in base['colliders']:
    if c.get('active') is False:
        poly(corners(c), outline=(130, 0, 160), width=1)

# course
course = path['course']['points']
d.line([(X(x), Y(z)) for x, z in course], fill=(0, 0, 0), width=2)
# loop
d.line([(X(x), Y(z)) for x, z in loop01] + [(X(loop01[0][0]), Y(loop01[0][1]))], fill=(0, 90, 220), width=3)
# free box
d.rectangle([X(-108.5), Y(1164.0), X(5.0), Y(1027.5)], outline=(0, 150, 60), width=2)

# candidate markers
marks = [
    ('pipe 95.004', -10.29, 1143.91, (200, 0, 0)),
    ('pipe 96.004', 85.68, 1283.19, (200, 0, 0)),
    ('container 143.060', 74.91, 1299.24, (200, 0, 0)),
    ('wall 355', 183.12, 1224.08, (0, 0, 200)),
    ('sign 257', 120.9, 1172.1, (0, 0, 200)),
    ('pole 283.327', -12.2, 1069.08, (120, 0, 160)),
]
for label, x, z, col in marks:
    r = 5
    d.ellipse([X(x) - r, Y(z) - r, X(x) + r, Y(z) + r], outline=col, width=2)
    d.text((X(x) + 7, Y(z) - 6), label, fill=col)

# axes labels
d.text((8, 8), 'P74 colliders-v2: grey = committed P66, orange = new in base v2, red = new in r04-v2', fill=(0, 0, 0))
d.text((8, 24), 'purple = on-measured-course inactive, black = 310 m course, blue = loop-01, green = free-roam box', fill=(0, 0, 0))
for x in range(-100, 201, 50):
    d.line([(X(x), H - 10), (X(x), H - 4)], fill=(0, 0, 0), width=1)
    d.text((X(x) - 8, H - 22), str(x), fill=(0, 0, 0))
for z in range(1000, 1326, 50):
    d.line([(6, Y(z)), (12, Y(z))], fill=(0, 0, 0), width=1)
    d.text((14, Y(z) - 6), str(z), fill=(0, 0, 0))

img.save(ROOT + r'\_work\prop-collision\map-v2.png')
print('wrote map-v2.png', W, H)
