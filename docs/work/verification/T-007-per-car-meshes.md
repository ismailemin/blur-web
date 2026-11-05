# T-007/E1j verification — per-car body and wheel meshes

**Date:** 5 November 2026
**Scope:** `probes/car-parts/**`, `probes/e1-drive/**`, `_work/car-parts/**`,
`_work/e1-drive/**`, `_work/logs/{car-parts,e1-drive}/**`,
`docs/work/analysis/e1-car-parts.md`, `docs/work/analysis/e1-drive-slice.md`
and this file. No change to `probes/asset-reader`,
`probes/render-packet`, the engine, `tools/`, `upstream/` or `game-data/`.
Physics is unchanged.

**Result:** **PASS.** All five roster cars are mapped to their own real
`root.pak` model and drawn with their own body and wheel meshes. The five body
mesh hashes are distinct, `verify_e1_drive.mjs` is **214/214 with 0 failures**,
every car has **301/301 wheel-contact ticks and 0 NaN**, and 25 headless Edge
captures report **0 console messages**. No race, audio, multiplayer or full-game
claim is made.

The earlier `docs/work/verification/T-007-car-parts.md` (P26) and
`T-007-car-parts-integration.md` (P28) remain accurate for their own artifacts;
their Corvette-only manifest hash and their "every car uses the Corvette body"
limit are historical and are superseded by the values below. They were not edited
because they are outside this task's file ownership.

---

## 1. Mapping (evidence, not inference)

Rule: the roster record name lowercased plus `.model` must match **exactly one**
`\models\vehicles\*.model` entry in `root.pak`. All other prefix candidates are
recorded in `_work/car-parts/cars/index.json` (`prefixCandidates`), so the
exclusion of `_race`, `_legend_*`, `_tuner`, `_talon` variants is visible. The
separate `\models\vehicles\wheels\<name>.model` resource is recorded
(`wheelsResource`) and **not** used: the body model's own `e_wheel_*` subtree
carries the tyre/rim/disc/caliper geometry and the rest-pose transforms.

| car | record (index / id) | pak path | logical bytes | model SHA-256 |
| --- | --- | --- | ---: | --- |
| Corvette ZR1 | 37 / 1554942492 | `\models\vehicles\corvette_zr1_stock.model` | 4,594,975 | `c55cdc1e04f6a8b463f140f4c4b697e49904930aea4ba1a1e2492fc8e2313453` |
| Lotus Exige Cup260 | 15 / 805568925 | `\models\vehicles\lotus_exigecup260_stock.model` | 5,867,996 | `1b6af9781c56fa7acf9d754c1ea46e854328ea528a9bae741f04778a2e0ab786` |
| Dodge Challenger | 9 / 528964602 | `\models\vehicles\dodge_challenger_stock.model` | 4,163,371 | `6195243f73fe76a7e7efd1430cf1b93a86ab7259d337fb74e6eb77661dc487c5` |
| Ford Focus RS | 50 / 2563977008 | `\models\vehicles\ford_focusrs_stock.model` | 5,530,523 | `0668854b859880ac844c2fab4ebc829adb7b3cb2905fda35929a6e71a1c9fbe4` |
| Audi R8 V10 | 55 / 2936683857 | `\models\vehicles\audi_r8v10_stock.model` | 3,659,117 | `2e71aaa70f95380ca86440dbbdcfc30201f511845862da596421b08b6a426120` |

**Mapped: 5 of 5.** No car needed the fallback. The fallback path is still
implemented and labelled: a car with zero or several exact matches is recorded
as `unmapped` with the reason and keeps the committed Corvette C3 body in the
drive slice (`_work/car-level-assets/corvette_c3_race.model.decoded`,
`77840511…2cb9d`).

`_work/car-parts/cars/index.json` — 72,194 B, SHA-256
`5042e714a309e28e19498a0d35e18fef941c0fac850e87bc0f986117bb9bc315`.

## 2. Per-car meshes, parts and draws

One manifest per car, same schema (`blur.car-part-manifest` v1). Every draw is
owned by exactly one part; no draw is omitted. `unclassified` means *identity not
proven*, never *not drawn*.

| car | vertices | triangles | draws | parts (named) | wheel draws (tyre/rim/disc/caliper) | proven draws | ambiguous wheel | tyre tier |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- |
| Corvette ZR1 | 33,048 | 35,045 | 100 | 34 (30) | 20 (8/4/4/4) | 90 | 10 | union |
| Lotus Exige Cup260 | 32,136 | 35,143 | 88 | 23 (19) | 20 (8/4/4/4) | 76 | 12 | union |
| Dodge Challenger | 28,365 | 32,032 | 104 | 31 (27) | 20 (8/4/4/4) | 88 | 16 | union |
| Ford Focus RS | 32,267 | 31,057 | 115 | 31 (27) | 20 (8/4/4/4) | 95 | 20 | union |
| Audi R8 V10 | 31,429 | 30,736 | 84 | 29 (25) | 20 (8/4/4/4) | 68 | 16 | containment |

Body mesh hashes (SHA-256 over little-endian float32 positions) — **all five
distinct**:

| car | mesh id | positions SHA-256 | manifest SHA-256 |
| --- | --- | --- | --- |
| Corvette ZR1 | `car.corvette-zr1-stock.body` | `1319e2aca3c9fd2b1220d701c46d928f585a785958ddaf4fb0a484cbe9d7fd2b` | `7c51c738f121614ce8ab18262203bb5ce34b399854c09b8fc9a92929fde6c1a8` |
| Lotus Exige Cup260 | `car.lotus-exige-cup260-stock.body` | `c5cc7937170201e66380f43a6a6b5f117a104c6a1e7a6955ff751f6eb75e1085` | `4859e7b859097729b6c356e1615fa1652553957ef901f02eafa5b7a9b839f93e` |
| Dodge Challenger | `car.dodge-challenger-stock.body` | `a430202dd5d88e2e6f9774f11c42a8509f5c62b762f28cb906f011b9321df9b8` | `53633d0f827cb72879c83f51a05e639b5210fba9298824e0d685c29662092d5e` |
| Ford Focus RS | `car.ford-focusrs-stock.body` | `8fc09c18c73eba6eeafb7cc79bf8d9be6eaf11c16cd46ffbefe8a2c45ae539e6` | `8c7efb2ced9a89a607f12962c33c0237308866edad32ca47a2700091b3b3fb2f` |
| Audi R8 V10 | `car.audi-r8v10-stock.body` | `0fce56a65b54ea5f567058825cff2397c275386ccaf1da07b7e030a359d44f40` | `63882c50ca679e79e1f472875094cb59dd87944c0c507960e754c35fcc2a7502` |

The Corvette C3 manifest (standalone preview input) keeps its classification:
**29 parts / 80 draws / 76 proven / 4 ambiguous**, mesh 30,591 / 108,579,
manifest now 269,046 B, SHA-256
`5df83a6b0fac6f24df642bcb742cfe798bd5ff5d154f097674d165d70ede5dbf`. Its five
screenshots are byte-identical to P26 (`7a9107ed…4e6a`), proving the
generalisation did not change the C3 render.

## 3. Drive integration

`geometry.json` v3: `meshes[]` = [level, collision surface] plus
`carBodies[slug]`. `createSession` resolves the body from `car.slug`, so a packet
contains **one** car mesh; the per-page upload count stays 3 (level + own body +
surface) and never grows with the roster. Each body still has the same 9 nodes
(`e1.car.body` + `.spin`/`.static` per corner) because every car has 16 spinning
and 4 caliper draws.

| car | packet bytes | packet hash | uploads | upload bytes | wheel angle @0/150/240/300 (rad) |
| --- | ---: | --- | ---: | ---: | --- |
| Corvette ZR1 | 4,422,587 | `sha256:ef9081e6f8f51f4ad0d3a94112c3a4d0c68bba848424f5d51aa39f858d58ef47` | 3 | 1,106,088 | 0 / 84.637 / 138.223 / 148.603 |
| Lotus Exige Cup260 | 4,378,925 | `sha256:d339b0353e035f38f2f430637ebe4660d126f6ce19880f9c7f1572a0f6c0eb8c` | 3 | 1,096,320 | 0 / 69.139 / 117.625 / 125.977 |
| Dodge Challenger | 4,157,428 | `sha256:8dc9292fb24405e6feec9931481e02b822bdf381e7c25ab8516a37421616fc96` | 3 | 1,013,736 | 0 / 94.530 / 138.695 / 147.091 |
| Ford Focus RS | 4,319,059 | `sha256:e72b5ea891e7bdca831e72a7f55ccca59d0e073f813bdd4a9a528556fb7475c5` | 3 | 1,048,860 | 0 / 88.536 / 125.483 / 127.291 |
| Audi R8 V10 | 4,228,778 | `sha256:42d3a80f2a84e3a252ef14f5b4a6e5cb89ff809258b7cfaf802207197cef7070` | 3 | 1,034,952 | 0 / 110.374 / 195.659 / 218.144 |

Physics is untouched: the Corvette state sequence hash is still the T-007 anchor
`sha256:83f765902ce5c610889e8a27e9bfe747f86142bddea24ecb987b29be29008e1f`.

## 4. Verification

```powershell
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"

& $py   probes/car-parts/tools/build_all_manifests.py
& $py   probes/car-parts/tools/build_manifest.py        # C3 preview input
& $py   probes/car-parts/tools/verify_manifest.py
& $node probes/e1-drive/tools/build_geometry.mjs
& $node probes/e1-drive/tools/verify_e1_drive.mjs
& $node probes/e1-drive/tools/capture_browser.mjs       # --port 8811 if 8801 is busy
```

| check | result |
| --- | --- |
| `verify_manifest.py` | **PASS**, 0 failures; two-build determinism for C3 and for the ZR1 manifest; five mapped cars; five distinct models and body meshes |
| `verify_e1_drive.mjs` | **214/214 checks, 0 failures** (202 pre-existing + 12 per-car body checks) |
| all five cars | **301/301 wheel-contact ticks**, **0 NaN**, every per-tick matrix rigid, run A = run B packet hash |
| distinctness | five distinct state sequences, packets, source models and body mesh hashes; the Corvette anchor is unchanged |
| geometry | `_work/e1-drive/geometry.json` 9,962,640 B, SHA-256 `37341b8db106c22b53e261fccffc746c1b1942ddbf209560841992e67ad34b08` |
| browser | 20 scripted captures + 5 wheel-view captures, **0 console messages**, 3 uploads per page |
| packet hashes | 17/20 byte-exact; the other three differ only in the last `Math.atan2` bit of the chase camera (documented Node-24 vs Edge-156 ulp caveat), not in physics or matrices |
| full asset suite | `python tools/verify_asset_probe.py --skip-build` — **29/29 PASS** |

## 5. Screenshots and console

- `_work/e1-drive/browser-<slug>-{start,mid,coast,end}.png` (20 captures,
  1600×900, adapter `nvidia / blackwell`) — each car shows its own body with
  cyan glass, yellow lights and the HUD reporting that car's own part/draw/node
  counts and body mesh id.
- `_work/e1-drive/browser-<slug>-wheels-240.png` (5 diagnostic side views at
  tick 240 using `?camdist=6.2&camheight=0.9&camyaw=1.15`) — the wheels, rims,
  red discs, yellow calipers and the spin marker are visible at all four corners
  for every car; evidence in `_work/e1-drive/browser-evidence-wheels.json`.
- `_work/car-parts/browser-parts-*.png` — unchanged C3 preview (byte-identical
  hashes), **0 console messages**.
- Console: **0 messages of any kind** across all 25 e1-drive captures and the 5
  car-parts captures.

![Audi R8 V10, wheel view](../../../_work/e1-drive/browser-audi-r8v10-stock-wheels-240-car.png)

*`_work/e1-drive/browser-audi-r8v10-stock-wheels-240-car.png`: the R8's own body
mesh with four tyre/rim/disc/caliper groups placed at the MdlDat rest poses.*

## 6. Limits

- **Wheel corner identity is bounds evidence.** Symmetric wheel sets cannot be
  resolved by AABB: ZR1 10 ambiguous wheel draws, Lotus 12, Dodge 16, Focus 20,
  Audi 16. Those draws keep their wheel part kind and spin on their wheel node,
  but their `partKind` is `unclassified` and the pairing is
  `previewAssignment`; no corner label is claimed. The Audi tyre tier is
  `containment` because its element boxes are 2–5 cm larger than the geometry.
- **Rest pose only.** Wheel placement is the `MdlDat` translation; no suspension
  travel, steer or camber (the state does not carry it).
- **Diagnostic materials.** Per-part colours and the spin marker band are debug
  aids, not materials, paint or texture pixels; `materialsApplied:false`.
- **Body→chassis alignment is not proven.** Each body is drawn directly in the
  engine body frame; the five bodies fit the chassis at the spawn, but the retail
  mesh import offset is not recovered.
- **Four C3 front disc/caliper draws remain side-ambiguous**, as in P26.
- **One car, one loaded block, one camera.** No race rules, opponents, AI, audio,
  multiplayer, culling or streaming; no handling claim per car.
- **Chase camera.** The rear wheels are visible from behind; front wheels are
  occluded. Rotation is proven by the per-tick matrices and the HUD angles and is
  visible in the diagnostic wheel-view captures.
- **Native parity** is still blocked by the DirectX SDK
  (`T-007-vehicle-physics.md`).

## 7. Evidence

| path | content |
| --- | --- |
| `_work/car-parts/cars/index.json` | mapping table, model/manifest/mesh hashes, per-car counts |
| `_work/car-parts/cars/<slug>/` | one manifest + mesh + scene report per car |
| `_work/car-parts/models/<sha>.decoded` + `.source.json` | decoded models + pak provenance |
| `_work/car-parts/manifest.json`, `mesh.json` | C3 preview manifest/mesh (269,046 B / 1,748,966 B) |
| `_work/car-parts/verify.json` | manifest + mapping + screenshot verification (SHA-256 `40f48beb…f627dc`) |
| `_work/e1-drive/geometry.json` | level + surface + five bodies |
| `_work/e1-drive/run.json` | 214 checks, per-car drive, determinism, packets, body records |
| `_work/e1-drive/packet-<slug>.json` | 301-tick packets with 9 matrices per tick |
| `_work/e1-drive/browser-evidence.json` | 20 captures, console, hash agreement, upload bytes |
| `_work/e1-drive/browser-evidence-wheels.json` | 5 wheel-view captures |
| `_work/e1-drive/browser-<slug>-*.png` | per-car screenshots + car crops |
| `_work/logs/car-parts/`, `_work/logs/e1-drive/` | build/capture/verify logs |
