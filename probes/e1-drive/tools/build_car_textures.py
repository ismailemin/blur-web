"""Export per-car UV0 streams and static albedo textures for the E1 drive slice.

P52 resolved every draw of the E1 roster cars to its committed material
binding (`_work/car-materials/roster/cars/<slug>/materials.json`, kind
`blur.car-material-texture-manifest` v1) and decoded the referenced static
`g_MeshTexture` images to mip0 RGBA8. This tool turns that record into PoC
artefacts for the vehicle half of `geometry.json`:

  * one float32 UV0 array per car mesh vertex (the committed `scene_inspect.exe`
    stream in `_work/car-parts/cars/<slug>/scene-report.json`, whose `uv0` array
    is parallel to the `positions` array the part manifest's mesh was built from);
  * one manifest that, for every one of the 491 car draws, records the P52
    material row, the resolved texture identity and the per-draw UV0 value hash;
  * the RGBA file path + SHA-256 of every referenced image.

Nothing is guessed and nothing is re-decoded here:

  * the texture pixels are the committed P52 `textures/*.rgba` files, re-hashed
    before they are pinned (the P52 gate already re-decoded them 40/40 with the
    committed `texture_inspect.exe --raw`);
  * the UV0 values are the committed `scene_inspect.exe` mesh stream, and the
    draw ranges are required to equal the car-parts manifest's ranges and the
    scene report's own draw ranges before a single UV byte is written;
  * a draw whose P52 status is runtime-only (paint lookup, light off/on blend,
    `_NO_ALBEDO`) keeps `textureId:null` and the exact committed reason.

Inputs (read-only):

  * `_work/car-materials/roster/index.json` + `cars/<slug>/materials.json`
  * `_work/car-materials/roster/cars/<slug>/textures/<id>.rgba`
  * `_work/car-parts/cars/index.json`, `cars/<slug>/{manifest,mesh,scene-report}.json`

Outputs (never committed):

  * `_work/e1-drive/car-uv-<slug>.bin` — float32 LE UV0 pairs, mesh vertex order
  * `_work/e1-drive/car-textures.json` — the manifest

Usage:
    python probes/e1-drive/tools/build_car_textures.py
"""
from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CAR_MATERIALS = ROOT / "_work/car-materials/roster"
CAR_PARTS = ROOT / "_work/car-parts/cars"
OUT_DIR = ROOT / "_work/e1-drive"
MANIFEST_OUT = OUT_DIR / "car-textures.json"

# Committed identities. The P52 roster index is the per-car record; the
# car-parts index is the model/manifest/mesh map `build_geometry.mjs` already
# pins. A regenerated or hand-edited input is a hard failure.
COMMITTED_ROSTER_INDEX = "fc144a1c23d332abafbab92c0c15ff3f273f4a6562262dcb3b431bc7e778bf19"
COMMITTED_CAR_INDEX = "555acb110c35374a91acecfac58098b55376c93fd35e52537d2df8715c3ae340"

# The committed `scene_inspect.exe` output per car, which carries the merged
# `uv0` array parallel to `positions`. The car-parts index does not record this
# file's hash, so the consumed bytes are pinned here: a regenerated scene report
# must be re-pinned deliberately, it cannot slip in silently.
COMMITTED_SCENE_REPORTS = {
    "corvette-zr1-stock": "6db850a23754af49d9ec78b99f4e50523d1db3453c44c7487ae05d64d5abe0db",
    "lotus-exige-cup260-stock": "e7483a8b7be2be9ef25ebf6633fed29b9b1337b330e38ac427cde59e8c184f0f",
    "dodge-challenger-stock": "b2284325b49fc663db1083b1032b93247ffd240d723c8564ac79893aa71b54fe",
    "ford-focusrs-stock": "d69f46ce09ba1759bbef7063f6f769b387814174af40a6199c617b7c9ad2e5f1",
    "audi-r8v10-stock": "948548055a1ff7f59482661d752a9a0542e023c8774315ceb8021545156f8639",
    "audi-tt-stock": "31aa17de45e99a65943552e4ff98512532aafe8c1c2099ca9bbbfa090a69eaa3",
    "ford-f100-offroad": "aa389f9e25f7e9d9cd3f2cdb7a86fa62261eb4edaaa7e6d4081942f5dc805859",
    "ford-fr100-stock": "89330e2e63274d82a282fd473412b5e50e8f918820baaff6d2943227f0a9af08",
    "volkswagen-golfw12650-stock": "8104fb0be5cf354b689b403e84aa339ff6ad9ac3d062d1d2a1a4a07d229fe2f3",
    "ford-mustanggtr-stock": "4a3024a737fd0807a7ddc0414e7a96fcaffe02dee135534309dbdd6c268b0f8c",
    "dodge-viperacr-stock": "8f3a2fd9aa3650f4623569aad5a5df0c7ea3803dacfe237d8d9f0de06e32a9f8",
    "audi-s3-stock": "1f78138a5615d29c1aca52ab6a87635a535d644da485bfe0da460a2910ff2d43",
    "ford-bronco-offroad": "d9d86338ecbceb25a35bc33a1145a8e2e8d1051d580e54d85a4be232433b686f",
    "nissan-skyliner34ztune-stock": "1cfbcd8b24e2503880b7a42516b4995704d41e7c374812b129a8cb8e461d61f8",
    "chevrolet-socalhhr-stock": "e00de48acd15b286df7c72a8d727d959c3c9a1474ff0de847b5c8d9009928207",
    "dodge-challenger-tuner": "9b14dba71b887d48cfef443cb7ca3cae88959524c1061ff5e2a3824d04f352fd",
    "nissan-350znismo-stock": "f8c0002638495675b6b179d73e1a545702baaf2e451f8c5057659157dbbe9e43",
    "chevrolet-camaro-stocke3": "7d4c537b9043b6942d8e59590920d24cbbb5ccccf25ab641497aaf632452b2ef",
    "volkswagen-beetle-offroad": "d839d0c45184c69e72c69b32e4627b6a37dfccf6ac0b07775073712c1eb32756",
    "foose-stallion-stock": "6a61f07e8b773e03f300e63d57e6cc2f3cc67cadd99b0fdf7bfe2f3078af9f87",
    "chevrolet-camaro-ratdrift": "f39018a9979a0cfe8a7bafee6f2c61e5bab2f50e356280d927c1fe8fd0a99a74",
    "corvette-c3-rat": "496fcc5524700e8d910374144507d21fcb85adb281ce180d16ac4a76be133289",
    "bmw-m3e92-tuner": "3a1abbb5c8640b98915d948174055ddf13add40e379f123b93dce6c570748f31",
    "koenigsegg-ccxr-stock": "38a572e60124bdcc4a55b0c54e68de9ab3c2c488d50e304aa99cdf36b26c61fe",
    "toyota-supratrd-stock": "35bf917be0649fbd4432c69c9d332e3f0f3362c96d73f4db7f20fde050362ee1",
    "opel-astraextreme-shannon": "221f86632244319943041512b932df57210d7ac423e264cbf7a03a3b9751a635",
    "bmw-1seriestii-race": "ae7937b69ba0ee4c0d198aedc8e8df87c29688b35d895211736abe37384baece",
    "ford-focusrs-race": "db72356aa2b7bdea852dd5643622f20ec9568b41fd15c2a1e12f8e23b46ef818",
    "renault-meganesportr26-stockgrpc": "84592cec0b27ae26620b0d96e587f711aa98e2c0ea373fd3d11ec9c92fcfb452",
    "renault-meganetrophy-stock": "fefc4a20e7d325d05d3163d128df14b4e55617de8561f62b5b4e0654ea147591",
    "bmw-135-stock": "1b85494c8475c6f9448a50765024b7c45b4a9ff05b59e4b152d9440ac3590cbf",
    "landrover-lrx-stock": "c171941a1835fce1c0df3df0e2516d511fa4ce5c777179e92ef73f1fd69611c9",
    "nissan-350z-drift": "91dc9778427fa69d06b19a93d62e4c2ab9e557618155dc0b73d56b360f8319c7",
    "bmw-x548msport-stock": "485d0cdd5a14764f1e693654411b2c81a5820bca7677050f4e64281c91d52321",
    "chevrolet-camaross-stock": "f7b607e952a2f249e9a18c698a77d149286300ff3e6ef9cd24f915911cee4d07",
    "nissan-navara-rat": "8bba8948f18fd091d4d4af9cc950f523d2111e72b5cde86a79cb7c13a168f58e",
    "landrover-defendersvxgrpc": "b1f9069b4e6547c0705871dbf3b5dd9f64cfac15cdaf2bb10730edbf6e4bfd2f",
    "bowler-nemesis-stock": "2e2608f1f617c83f3113ac47d0a4ddfa7147be9c3784054d75a4aa4b5a7dd384",
    "vauxhall-monarovxr-drift": "b1cdc2913a4cef2217e73d7c7f41836ec54e791173dcc6172f1275eee8c3fbcd",
    "ford-mustang-gt500-stock1stplay": "ddc2cb8a68312333987afbb6eef566b3c80bc298445a13842b958bf1985bfa6b",
    "foose-69-stock": "c811348ff551db1984a546e178ba7dd5c9f75a6a160d129f2cbbb368595348a7",
    "corvette-c3-drag": "2da787b422e9b97ce01788632a3bcaf6a4447a940418e1dccfe1e44815571735",
    "ford-f100-rat": "d3f3cc7ec8aafcac7d3f287a85a55c167b2baae6392dc3359766d24e8091be45",
    "chevrolet-camaross-drag": "e4e823eeaeccca2bea6c0860e3e70920457597c3e9ed123752973b13fbce55c3",
    "ford-f150-offroadheh": "35e88a7b058e7bb2295494339e817c7371329f576910b131f39b63eafbefea2d",
    "volkswagen-scirocco-24": "ad450bca59687935a3d61e287033b2dc4e8b40c8479e7f0722e27408f934908a",
    "nissan-navara-offroad": "a47d39090967d94464abbd2295116a9947ed6be541c62c3c8958bb3f209a4977",
    "volkswagen-beetle-rat": "c699ea85f5a53667341fbf30cec27a78cdfa4bb97f63ea601e105ce236286d94",
    "bmw-m3e92-drift": "d31709dcbccaefb3761f622eebace128a559b409d14c72787c925221ede4cea1",
    "hummer-h2-offroad": "08ff8fba25a055fe6eca565f11bdda06fb98dd6e72619137ad8269430c337784",
    "dodge-challenger-race": "0e482ac3f60fcce20a34d29bec55abe24f2f8bd76734e252abc6671cfd30c713",
    "acschnitzer-acs1coupe-stock": "4177c48798a351635603b18cf7138e627c9145acd5edb9feeb62c06637e85763",
    "corvette-c3-race": "cfc88cb47bacb2c3212bb9d3b87912cc3aca255dd8221804f87e6b56bc7d7b73",
    "hennessey-vipervenom1000coupe-stock": "176b2bf0c5ea46c2b4f1523250382ab3695b7b194e03bf5118956af6c10c884a",
    "opel-astraextreme-stockgrippy": "f5ae7944efb1d5a4d6ee7334e5c506d94e5bb0bd438e78c2a64c4ba111001d9b",
    "ford-gt-stock": "24a8a7be3d2ae2de5f4c380e1b3566658b97e8c4955e1e42dc871842df135ba5",
    "dodge-vipergtsr-stock": "e46c313d2bec2ef8c63eb600078644ee5953b16c5be067cd52f9b5de6f0ce341",
    "ratrod-na-stock": "18f39a36d8ffe89a9e999ab27ea9e7ef3821ae76cdc11c60293000f0c2ec8194",
    "toyota-supra-smooth": "3f0943d31b38caa4efbeebd659d653571cfa6becc3cdf88d38ba1ccbe7771e48",
}

# P52 per-car totals (docs/work/analysis/car-materials.md §2, extended by the
# T-007 vehicle batch 1). Every derived count is compared with the pinned value
# for its own car before the aggregate document is written. The first five rows
# are the original committed anchors and must never change; the next ten are the
# V1-audited batch 1.
EXPECTED_BY_CAR = {
    "corvette-zr1-stock": {"draws": 100, "staticAlbedoDraws": 50, "paintDraws": 10,
                           "lightDraws": 17, "noAlbedoDraws": 23, "textures": 9,
                           "rgbaBytes": 4538368, "uvValues": 66096},
    "lotus-exige-cup260-stock": {"draws": 88, "staticAlbedoDraws": 48, "paintDraws": 0,
                           "lightDraws": 14, "noAlbedoDraws": 26, "textures": 9,
                           "rgbaBytes": 4997120, "uvValues": 64272},
    "dodge-challenger-stock": {"draws": 104, "staticAlbedoDraws": 42, "paintDraws": 11,
                           "lightDraws": 13, "noAlbedoDraws": 38, "textures": 7,
                           "rgbaBytes": 2637824, "uvValues": 56730},
    "ford-focusrs-stock": {"draws": 115, "staticAlbedoDraws": 37, "paintDraws": 15,
                           "lightDraws": 13, "noAlbedoDraws": 50, "textures": 7,
                           "rgbaBytes": 3424256, "uvValues": 64534},
    "audi-r8v10-stock": {"draws": 84, "staticAlbedoDraws": 47, "paintDraws": 9,
                           "lightDraws": 9, "noAlbedoDraws": 19, "textures": 8,
                           "rgbaBytes": 2580480, "uvValues": 62858},
    "audi-tt-stock": {"draws": 100, "staticAlbedoDraws": 52, "paintDraws": 12,
                           "lightDraws": 13, "noAlbedoDraws": 23, "textures": 7,
                           "rgbaBytes": 2637824, "uvValues": 61860},
    "ford-f100-offroad": {"draws": 78, "staticAlbedoDraws": 34, "paintDraws": 8,
                           "lightDraws": 6, "noAlbedoDraws": 30, "textures": 7,
                           "rgbaBytes": 2588672, "uvValues": 74102},
    "ford-fr100-stock": {"draws": 71, "staticAlbedoDraws": 33, "paintDraws": 10,
                           "lightDraws": 7, "noAlbedoDraws": 21, "textures": 8,
                           "rgbaBytes": 2576384, "uvValues": 75044},
    "volkswagen-golfw12650-stock": {"draws": 92, "staticAlbedoDraws": 43, "paintDraws": 10,
                           "lightDraws": 8, "noAlbedoDraws": 31, "textures": 8,
                           "rgbaBytes": 2580480, "uvValues": 64090},
    "ford-mustanggtr-stock": {"draws": 101, "staticAlbedoDraws": 55, "paintDraws": 14,
                           "lightDraws": 8, "noAlbedoDraws": 24, "textures": 7,
                           "rgbaBytes": 2637824, "uvValues": 65854},
    "dodge-viperacr-stock": {"draws": 83, "staticAlbedoDraws": 48, "paintDraws": 12,
                           "lightDraws": 14, "noAlbedoDraws": 9, "textures": 7,
                           "rgbaBytes": 3424256, "uvValues": 55516},
    "audi-s3-stock": {"draws": 99, "staticAlbedoDraws": 49, "paintDraws": 11,
                           "lightDraws": 17, "noAlbedoDraws": 22, "textures": 7,
                           "rgbaBytes": 3424256, "uvValues": 60336},
    "ford-bronco-offroad": {"draws": 82, "staticAlbedoDraws": 25, "paintDraws": 10,
                           "lightDraws": 7, "noAlbedoDraws": 40, "textures": 6,
                           "rgbaBytes": 2392064, "uvValues": 73054},
    "nissan-skyliner34ztune-stock": {"draws": 96, "staticAlbedoDraws": 46, "paintDraws": 14,
                           "lightDraws": 13, "noAlbedoDraws": 23, "textures": 7,
                           "rgbaBytes": 2379776, "uvValues": 65100},
    "chevrolet-socalhhr-stock": {"draws": 85, "staticAlbedoDraws": 64, "paintDraws": 0,
                           "lightDraws": 10, "noAlbedoDraws": 11, "textures": 8,
                           "rgbaBytes": 3686400, "uvValues": 64956},
    "dodge-challenger-tuner": {"draws": 93, "staticAlbedoDraws": 50, "paintDraws": 0,
                           "lightDraws": 11, "noAlbedoDraws": 32, "textures": 8,
                           "rgbaBytes": 4472832, "uvValues": 53412},
    "nissan-350znismo-stock": {"draws": 123, "staticAlbedoDraws": 52, "paintDraws": 0,
                           "lightDraws": 14, "noAlbedoDraws": 57, "textures": 8,
                           "rgbaBytes": 3686400, "uvValues": 77332},
    "chevrolet-camaro-stocke3": {"draws": 100, "staticAlbedoDraws": 31, "paintDraws": 9,
                           "lightDraws": 12, "noAlbedoDraws": 48, "textures": 7,
                           "rgbaBytes": 3424256, "uvValues": 72772},
    "volkswagen-beetle-offroad": {"draws": 85, "staticAlbedoDraws": 29, "paintDraws": 13,
                           "lightDraws": 5, "noAlbedoDraws": 38, "textures": 8,
                           "rgbaBytes": 3702784, "uvValues": 72402},
    "foose-stallion-stock": {"draws": 103, "staticAlbedoDraws": 46, "paintDraws": 2,
                           "lightDraws": 10, "noAlbedoDraws": 45, "textures": 8,
                           "rgbaBytes": 4472832, "uvValues": 71022},
    "chevrolet-camaro-ratdrift": {"draws": 99, "staticAlbedoDraws": 37, "paintDraws": 0,
                           "lightDraws": 14, "noAlbedoDraws": 48, "textures": 8,
                           "rgbaBytes": 4472832, "uvValues": 64504},
    "corvette-c3-rat": {"draws": 83, "staticAlbedoDraws": 35, "paintDraws": 0,
                           "lightDraws": 10, "noAlbedoDraws": 38, "textures": 8,
                           "rgbaBytes": 2768896, "uvValues": 67528},
    "bmw-m3e92-tuner": {"draws": 94, "staticAlbedoDraws": 54, "paintDraws": 7,
                           "lightDraws": 10, "noAlbedoDraws": 23, "textures": 8,
                           "rgbaBytes": 3432448, "uvValues": 60304},
    "koenigsegg-ccxr-stock": {"draws": 97, "staticAlbedoDraws": 63, "paintDraws": 9,
                           "lightDraws": 17, "noAlbedoDraws": 8, "textures": 9,
                           "rgbaBytes": 3563520, "uvValues": 80036},
    "toyota-supratrd-stock": {"draws": 88, "staticAlbedoDraws": 53, "paintDraws": 11,
                           "lightDraws": 9, "noAlbedoDraws": 15, "textures": 7,
                           "rgbaBytes": 3424256, "uvValues": 72244},
    "opel-astraextreme-shannon": {"draws": 86, "staticAlbedoDraws": 72, "paintDraws": 0,
                           "lightDraws": 9, "noAlbedoDraws": 5, "textures": 11,
                           "rgbaBytes": 4939776, "uvValues": 78998},
    "bmw-1seriestii-race": {"draws": 116, "staticAlbedoDraws": 43, "paintDraws": 11,
                           "lightDraws": 9, "noAlbedoDraws": 53, "textures": 7,
                           "rgbaBytes": 3358720, "uvValues": 68666},
    "ford-focusrs-race": {"draws": 110, "staticAlbedoDraws": 36, "paintDraws": 12,
                           "lightDraws": 10, "noAlbedoDraws": 52, "textures": 7,
                           "rgbaBytes": 2572288, "uvValues": 62172},
    "renault-meganesportr26-stockgrpc": {"draws": 125, "staticAlbedoDraws": 47, "paintDraws": 0,
                           "lightDraws": 19, "noAlbedoDraws": 59, "textures": 7,
                           "rgbaBytes": 4407296, "uvValues": 62770},
    "renault-meganetrophy-stock": {"draws": 93, "staticAlbedoDraws": 47, "paintDraws": 8,
                           "lightDraws": 11, "noAlbedoDraws": 27, "textures": 8,
                           "rgbaBytes": 3571712, "uvValues": 66304},
    "bmw-135-stock": {"draws": 111, "staticAlbedoDraws": 49, "paintDraws": 1,
                           "lightDraws": 9, "noAlbedoDraws": 52, "textures": 9,
                           "rgbaBytes": 4669440, "uvValues": 74726},
    "landrover-lrx-stock": {"draws": 135, "staticAlbedoDraws": 40, "paintDraws": 8,
                           "lightDraws": 11, "noAlbedoDraws": 76, "textures": 7,
                           "rgbaBytes": 3424256, "uvValues": 63852},
    "nissan-350z-drift": {"draws": 125, "staticAlbedoDraws": 37, "paintDraws": 13,
                           "lightDraws": 13, "noAlbedoDraws": 62, "textures": 10,
                           "rgbaBytes": 3449856, "uvValues": 69682},
    "bmw-x548msport-stock": {"draws": 91, "staticAlbedoDraws": 46, "paintDraws": 11,
                           "lightDraws": 11, "noAlbedoDraws": 23, "textures": 8,
                           "rgbaBytes": 2445312, "uvValues": 72666},
    "chevrolet-camaross-stock": {"draws": 122, "staticAlbedoDraws": 35, "paintDraws": 14,
                           "lightDraws": 14, "noAlbedoDraws": 59, "textures": 8,
                           "rgbaBytes": 3359744, "uvValues": 73030},
    "nissan-navara-rat": {"draws": 75, "staticAlbedoDraws": 44, "paintDraws": 8,
                           "lightDraws": 10, "noAlbedoDraws": 13, "textures": 8,
                           "rgbaBytes": 2646016, "uvValues": 51006},
    "landrover-defendersvxgrpc": {"draws": 85, "staticAlbedoDraws": 30, "paintDraws": 7,
                           "lightDraws": 12, "noAlbedoDraws": 36, "textures": 7,
                           "rgbaBytes": 2637824, "uvValues": 58568},
    "bowler-nemesis-stock": {"draws": 84, "staticAlbedoDraws": 45, "paintDraws": 0,
                           "lightDraws": 11, "noAlbedoDraws": 28, "textures": 9,
                           "rgbaBytes": 4481024, "uvValues": 85400},
    "vauxhall-monarovxr-drift": {"draws": 104, "staticAlbedoDraws": 35, "paintDraws": 11,
                           "lightDraws": 6, "noAlbedoDraws": 52, "textures": 7,
                           "rgbaBytes": 2318336, "uvValues": 74258},
    "ford-mustang-gt500-stock1stplay": {"draws": 110, "staticAlbedoDraws": 52, "paintDraws": 10,
                           "lightDraws": 14, "noAlbedoDraws": 34, "textures": 7,
                           "rgbaBytes": 3424256, "uvValues": 58140},
    "foose-69-stock": {"draws": 98, "staticAlbedoDraws": 37, "paintDraws": 0,
                           "lightDraws": 14, "noAlbedoDraws": 47, "textures": 8,
                           "rgbaBytes": 3686400, "uvValues": 67244},
    "corvette-c3-drag": {"draws": 65, "staticAlbedoDraws": 24, "paintDraws": 6,
                           "lightDraws": 8, "noAlbedoDraws": 27, "textures": 5,
                           "rgbaBytes": 2244608, "uvValues": 55470},
    "ford-f100-rat": {"draws": 74, "staticAlbedoDraws": 44, "paintDraws": 0,
                           "lightDraws": 7, "noAlbedoDraws": 23, "textures": 8,
                           "rgbaBytes": 3686400, "uvValues": 67812},
    "chevrolet-camaross-drag": {"draws": 107, "staticAlbedoDraws": 36, "paintDraws": 13,
                           "lightDraws": 10, "noAlbedoDraws": 48, "textures": 7,
                           "rgbaBytes": 3358720, "uvValues": 73636},
    "ford-f150-offroadheh": {"draws": 120, "staticAlbedoDraws": 39, "paintDraws": 12,
                           "lightDraws": 14, "noAlbedoDraws": 55, "textures": 7,
                           "rgbaBytes": 3440640, "uvValues": 67244},
    "volkswagen-scirocco-24": {"draws": 85, "staticAlbedoDraws": 54, "paintDraws": 11,
                           "lightDraws": 8, "noAlbedoDraws": 12, "textures": 9,
                           "rgbaBytes": 3436544, "uvValues": 68664},
    "nissan-navara-offroad": {"draws": 73, "staticAlbedoDraws": 47, "paintDraws": 5,
                           "lightDraws": 13, "noAlbedoDraws": 8, "textures": 8,
                           "rgbaBytes": 3686400, "uvValues": 56616},
    "volkswagen-beetle-rat": {"draws": 94, "staticAlbedoDraws": 42, "paintDraws": 1,
                           "lightDraws": 5, "noAlbedoDraws": 46, "textures": 6,
                           "rgbaBytes": 3358720, "uvValues": 64926},
    "bmw-m3e92-drift": {"draws": 101, "staticAlbedoDraws": 48, "paintDraws": 11,
                           "lightDraws": 10, "noAlbedoDraws": 32, "textures": 9,
                           "rgbaBytes": 3379200, "uvValues": 58784},
    "hummer-h2-offroad": {"draws": 98, "staticAlbedoDraws": 23, "paintDraws": 5,
                           "lightDraws": 20, "noAlbedoDraws": 50, "textures": 6,
                           "rgbaBytes": 2392064, "uvValues": 67758},
    "dodge-challenger-race": {"draws": 99, "staticAlbedoDraws": 32, "paintDraws": 9,
                           "lightDraws": 12, "noAlbedoDraws": 46, "textures": 7,
                           "rgbaBytes": 3358720, "uvValues": 54046},
    "acschnitzer-acs1coupe-stock": {"draws": 108, "staticAlbedoDraws": 36, "paintDraws": 11,
                           "lightDraws": 11, "noAlbedoDraws": 50, "textures": 7,
                           "rgbaBytes": 3424256, "uvValues": 72262},
    "corvette-c3-race": {"draws": 80, "staticAlbedoDraws": 26, "paintDraws": 6,
                           "lightDraws": 10, "noAlbedoDraws": 38, "textures": 6,
                           "rgbaBytes": 1327104, "uvValues": 61182},
    "hennessey-vipervenom1000coupe-stock": {"draws": 86, "staticAlbedoDraws": 45, "paintDraws": 12,
                           "lightDraws": 14, "noAlbedoDraws": 15, "textures": 9,
                           "rgbaBytes": 4538368, "uvValues": 60828},
    "opel-astraextreme-stockgrippy": {"draws": 86, "staticAlbedoDraws": 63, "paintDraws": 9,
                           "lightDraws": 9, "noAlbedoDraws": 5, "textures": 10,
                           "rgbaBytes": 3891200, "uvValues": 78998},
    "ford-gt-stock": {"draws": 114, "staticAlbedoDraws": 95, "paintDraws": 0,
                           "lightDraws": 16, "noAlbedoDraws": 3, "textures": 9,
                           "rgbaBytes": 3162112, "uvValues": 69720},
    "dodge-vipergtsr-stock": {"draws": 91, "staticAlbedoDraws": 51, "paintDraws": 10,
                           "lightDraws": 13, "noAlbedoDraws": 17, "textures": 8,
                           "rgbaBytes": 4472832, "uvValues": 62554},
    "ratrod-na-stock": {"draws": 51, "staticAlbedoDraws": 23, "paintDraws": 0,
                           "lightDraws": 6, "noAlbedoDraws": 22, "textures": 6,
                           "rgbaBytes": 2408448, "uvValues": 59202},
    "toyota-supra-smooth": {"draws": 82, "staticAlbedoDraws": 49, "paintDraws": 9,
                           "lightDraws": 11, "noAlbedoDraws": 13, "textures": 7,
                           "rgbaBytes": 3424256, "uvValues": 63658},
}
EXPECTED = {
    key: sum(car[key] for car in EXPECTED_BY_CAR.values())
    for key in ("draws", "staticAlbedoDraws", "paintDraws", "lightDraws",
                "noAlbedoDraws", "textures", "rgbaBytes", "uvValues")
}

# One declared sampling choice, identical to the track pack. P52 records that no
# sampler state is recovered from the engine, so this is not retail fidelity.
SAMPLER = {
    "addressModeU": "repeat",
    "addressModeV": "repeat",
    "magFilter": "linear",
    "minFilter": "linear",
    "mipmapFilter": "not-applied",
    "mipLevelsUploaded": 1,
    "textureFormat": "rgba8unorm",
    "colourSpace": "raw-decoded-texels",
    "reason": (
        "P52 records that sampler wrap/filter/anisotropy/mip selection, sRGB, material colour, blend "
        "state and shader stages are not recovered. 'repeat' + linear on the uploaded mip0 is the single "
        "explicit PoC choice, shared with the track texture pack. The RGBA bytes are the committed P52 "
        "decode, uploaded as rgba8unorm with no channel transform. This is not retail sampling fidelity"
    ),
}

# UV0 sampling convention. The exported stream is the reader's raw value, byte
# for byte; the sampler applies `u' = 1 - u` for car draws because the committed
# plate/badge pixels prove the model's U direction is authored opposite to the
# decoded image's left-to-right direction. Evidence (P59): the ZR1 rear plate
# (`nyc_10`, shared 6) renders "DQF 9760" with the glyph order reversed but the
# glyphs upright on the raw stream; `u' = 1 - u` makes it read normally. The Audi
# rear plate (`spain10`, shared 7) behaves the same, and the Corvette side badges
# ("ZR1 SUPERCHARGED", resource block 8) plus the front/rear emblems agree. V is
# already correct: the upper plate edge samples the image's top rows. A V flip
# produces the upside-down 180-degree result P55 recorded, so V is left raw.
# Both texture storage kinds behave the same, so this is one convention, not a
# per-texture flag. No UV value and no pixel is modified.
UV_CONVENTION = {
    "uv0": "committed scene_inspect.exe stream, exported unchanged (signed zeros preserved)",
    "sampleU": "1 - uv0.u",
    "sampleV": "uv0.v (unchanged)",
    "sampleUV": "(1 - uv0.u, uv0.v)",
    "appliesTo": "the 224 car draws whose P52 static albedo image is bound",
    "reason": (
        "the decoded images are stored row 0 = top and the committed car UV0 stream addresses them with "
        "V already upright; the model's U axis however increases in the opposite direction from the image's "
        "left-to-right reading direction on every readable island (rear plates, side badges, front/rear "
        "emblems), so sampling one-minus-u makes the authored artwork read left-to-right. The committed UV0 "
        "values and the committed RGBA pixels are unmodified: only the sampling choice is declared"),
    "evidence": [
        "ZR1 rear plate nyc_10 (shared 6): raw U shows 'DQF 9760' in reverse glyph order (glyphs upright) and 'NEW YORK' at the plate top; 1-u reads 'DQF 9760' / 'NEW YORK' normally",
        "Audi rear plate spain10 (shared 7): raw U puts the 'E' country strip on the right and reverses '350L EMO'; 1-u puts it on the left and reads normally",
        "ZR1 side badges (corvette_zr1_decals, resource block 8, draws 39/44) and front/rear emblems: U increases toward the screen-left on the outside of the body, so the same 1-u direction applies",
        "V is raw: the upper plate edge (high y) samples v~0.08, the image's top rows; a V flip rotates the plate text 180 degrees (the P55 observation)",
    ],
    "notApplied": "no per-material texture matrix, UV transform, wrap state or mip state is recovered; this is one declared PoC convention",
}


# Draw classes. The 267 runtime-only draws keep the committed P52 reason verbatim;
# they are never given an invented image.
STATUS_TO_CLASS = {
    "static_albedo_image_resolved": "staticAlbedo",
    "runtime_light_blend": "runtimeLightBlend",
    "shader_no_albedo": "noAlbedoShader",
}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def fnv1a64(data: bytes) -> str:
    value = 0xCBF29CE484222325
    for byte in data:
        value ^= byte
        value = (value * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return f"{value:016x}"


def mix_f32(value: int, component: float) -> int:
    for byte in struct.pack("<f", component):
        value ^= byte
        value = (value * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return value


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT)).replace("\\", "/")


def load_pinned(path: Path, expected_sha: str, what: str) -> bytes:
    if not path.is_file():
        raise SystemExit(f"BLOCKED: missing {what} {rel(path)}")
    data = path.read_bytes()
    digest = sha256_bytes(data)
    if digest != expected_sha:
        raise SystemExit(f"FAILED: {what} is not the committed one ({digest} != {expected_sha})")
    return data


class JsonReader:
    """Float32-preserving JSON writer: the reader prints `-0`, keep its sign."""

    @staticmethod
    def load(path: Path) -> dict:
        return json.loads(
            path.read_text(encoding="utf-8"),
            parse_int=lambda token: float(token) if token == "-0" else int(token),
        )


def build_car(entry: dict, car_index_entry: dict) -> dict:
    slug = entry["slug"]
    materials_path = CAR_MATERIALS / entry["manifest"]
    materials = JsonReader.load(materials_path)
    if materials.get("kind") != "blur.car-material-texture-manifest" or materials.get("version") != 1:
        raise SystemExit(f"FAILED: {slug} materials kind/version is not blur.car-material-texture-manifest v1")
    if sha256_bytes(materials_path.read_bytes()) != entry["manifestSha256"]:
        raise SystemExit(f"FAILED: {slug} materials.json is not the one the roster index pinned")

    manifest_path = ROOT / car_index_entry["manifest"]
    parts = json.loads(manifest_path.read_text(encoding="utf-8"))
    if parts.get("kind") != "blur.car-part-manifest" or parts.get("version") != 1:
        raise SystemExit(f"FAILED: {slug} part manifest kind/version is wrong")
    if sha256_bytes(manifest_path.read_bytes()) != car_index_entry["manifestSha256"][7:]:
        raise SystemExit(f"FAILED: {slug} part manifest differs from the car index pin")

    mesh_path = ROOT / car_index_entry["mesh"]
    mesh_bytes = mesh_path.read_bytes()
    if sha256_bytes(mesh_bytes) != car_index_entry["meshSha256"][7:]:
        raise SystemExit(f"FAILED: {slug} mesh differs from the car index pin")
    mesh = json.loads(mesh_bytes)
    vertex_count = mesh["vertexCount"]
    if vertex_count * 3 != len(mesh["positions"]):
        raise SystemExit(f"FAILED: {slug} mesh positions do not match its vertex count")

    scene_path = CAR_PARTS / slug / "scene-report.json"
    scene_raw = load_pinned(scene_path, COMMITTED_SCENE_REPORTS[slug], f"{slug} scene report")
    scene = JsonReader.load(scene_path)
    if scene.get("status") != "ok":
        raise SystemExit(f"FAILED: {slug} scene report status is {scene.get('status')}")
    if scene["positions"] != mesh["positions"]:
        raise SystemExit(f"FAILED: {slug} scene report positions differ from the part manifest mesh")
    uv = scene["uv0"]
    if len(uv) != 2 * vertex_count:
        raise SystemExit(f"FAILED: {slug} uv0 has {len(uv)} values, expected 2 x {vertex_count}")
    for component in uv:
        if not (component == component and abs(component) != float("inf")):
            raise SystemExit(f"FAILED: {slug} uv0 has a non-finite component")
    skipped_empty = len(parts.get("skippedEmptyDraws", []))
    if (len(scene["draws"]) != len(parts["draws"]) + skipped_empty
            or len(materials["draws"]) != len(parts["draws"])):
        raise SystemExit(f"FAILED: {slug} draw counts disagree between the three readers "
                         f"(scene {len(scene['draws'])}, parts {len(parts['draws'])}, "
                         f"materials {len(materials['draws'])}, skipped {skipped_empty})")
    for part_draw in parts["draws"]:
        index = part_draw["index"]
        scene_draw = scene["draws"][index]
        if scene_draw.get("firstIndex") is None:
            raise SystemExit(f"FAILED: {slug} draw {index} is not in serialized order")
        if part_draw["firstIndex"] != scene_draw["firstIndex"] or \
                part_draw["indexCount"] != scene_draw["indexCount"]:
            raise SystemExit(f"FAILED: {slug} draw {index} index range differs from the scene report")

    # Texture identity: P52 records the resolved static image per draw. The RGBA
    # files are the committed decodes; each is re-hashed here before it is pinned.
    texture_records = {}
    for texture in materials["textures"]:
        decoded = texture.get("decoded") or {}
        rgba_info = decoded.get("rgba") or {}
        if texture.get("undecodedReason"):
            raise SystemExit(f"FAILED: {slug} texture {texture['id']} is undecoded: {texture['undecodedReason']}")
        if not rgba_info.get("path"):
            raise SystemExit(f"FAILED: {slug} texture {texture['id']} has no decoded RGBA")
        rgba_path = (CAR_MATERIALS / Path(entry["manifest"]).parent / rgba_info["path"]).resolve()
        rgba_bytes = rgba_path.read_bytes()
        if sha256_bytes(rgba_bytes) != rgba_info["sha256"]:
            raise SystemExit(f"FAILED: {slug} texture {texture['id']} RGBA does not match its P52 hash")
        width, height = texture["decoded"]["nativeDecoder"]["width"], texture["decoded"]["nativeDecoder"]["height"]
        if len(rgba_bytes) != width * height * 4 or len(rgba_bytes) != rgba_info["bytes"]:
            raise SystemExit(f"FAILED: {slug} texture {texture['id']} RGBA length does not match its size")
        texture_id = f"car.{slug}." + texture["id"].replace(":", "-")
        texture_records[texture["id"]] = {
            "id": texture_id,
            "p52Id": texture["id"],
            "kind": texture["kind"],
            "block": texture.get("block"),
            "index": texture.get("index"),
            "sharedIndex": texture.get("sharedIndex"),
            "name": texture["name"],
            "textureHash": texture["hash"],
            "roles": texture["roles"],
            "width": width,
            "height": height,
            "levels": (texture["lods"][0]["descriptor"].get("levels") if texture.get("lods") else None),
            "formatName": (texture["lods"][0]["descriptor"].get("formatName") if texture.get("lods") else None),
            "samplerRecorded": texture.get("sampler"),
            "sourceLod": texture["decoded"].get("sourceLod"),
            "source": texture["decoded"].get("source"),
            "rgbaPath": rel(rgba_path),
            "rgbaBytes": len(rgba_bytes),
            "rgbaSha256": "sha256:" + rgba_info["sha256"],
            "rgbaFnv1a64": fnv1a64(rgba_bytes),
            "drawIndices": texture["drawIndices"],
            "p52DrawCount": len(texture["drawIndices"]),
            "drawCount": 0,
        }

    draws = []
    per_texture_draws: dict[str, int] = {}

    for material_draw, part_draw in zip(materials["draws"], parts["draws"]):
        index = part_draw["index"]
        if material_draw["index"] != index:
            raise SystemExit(f"FAILED: {slug} materials draw order differs at {index}")
        if (material_draw.get("partId") or None) != (part_draw.get("partId") or None) or \
                (material_draw.get("renderPartId") or None) != (part_draw.get("renderPartId") or None):
            raise SystemExit(f"FAILED: {slug} draw {index} part identity differs between P52 and the part manifest")
        status = material_draw["status"]
        draw_class = STATUS_TO_CLASS.get(status)
        if draw_class is None:
            raise SystemExit(f"FAILED: {slug} draw {index} has unknown P52 status {status!r}")

        first, count = part_draw["firstIndex"], part_draw["indexCount"]
        digest = 0xCBF29CE484222325
        low = [None, None]
        high = [None, None]
        for vertex in mesh["indices"][first:first + count]:
            pair = (uv[2 * vertex], uv[2 * vertex + 1])
            for axis in range(2):
                digest = mix_f32(digest, pair[axis])
                if low[axis] is None or pair[axis] < low[axis]:
                    low[axis] = pair[axis]
                if high[axis] is None or pair[axis] > high[axis]:
                    high[axis] = pair[axis]

        record = {
            "index": index,
            "firstIndex": first,
            "indexCount": count,
            "partId": material_draw.get("partId"),
            "partKind": material_draw.get("partKind"),
            "renderPartId": material_draw.get("renderPartId"),
            "effect": material_draw.get("effect"),
            "shaderFamily": material_draw.get("shaderFamily"),
            "p52Status": status,
            "drawClass": draw_class,
            "uv0Available": bool(material_draw["uv0Available"]),
            "uvHash": "0x" + f"{digest:016x}",
            "uvRange": [[low[0], high[0]], [low[1], high[1]]],
            "uvFlipU": False,
            "uvFlipV": False,
        }

        if draw_class == "staticAlbedo":
            texture_ids = material_draw.get("textureIds") or []
            if len(texture_ids) != 1:
                raise SystemExit(f"FAILED: {slug} draw {index} resolves {len(texture_ids)} textures, expected 1")
            texture = texture_records.get(texture_ids[0])
            if texture is None:
                raise SystemExit(f"FAILED: {slug} draw {index} names unknown texture {texture_ids[0]}")
            if not material_draw["uv0Available"]:
                raise SystemExit(f"FAILED: {slug} draw {index} is textured but has no original UV0")
            if index not in texture["drawIndices"]:
                raise SystemExit(f"FAILED: {slug} texture {texture['id']} does not list draw {index}")
            per_texture_draws[texture["id"]] = per_texture_draws.get(texture["id"], 0) + 1
            record.update({
                "textureId": texture["id"],
                "textureName": texture["name"],
                "textureHash": texture["textureHash"],
                "textureSource": texture["p52Id"],
                "uvFlipU": True,
                "uvFlipV": False,
                "material": {
                    "id": material_draw["material"]["id"],
                    "stage": material_draw["material"]["stage"],
                    "typeName": material_draw["material"]["typeName"],
                    "albedoParameter": material_draw["material"]["parameter"],
                    "archiveOffset": material_draw["material"]["archiveOffset"],
                    "fieldSerializedOffset": material_draw["material"]["fieldSerializedOffset"],
                },
                "bindingStatus": "boundStaticAlbedoImage",
                "reason": "P52 resolved this draw's g_MeshTexture to a decoded static image; sampled with the "
                          "car mesh's own UV0 stream",
            })
        else:
            if material_draw.get("textureIds"):
                raise SystemExit(f"FAILED: {slug} draw {index} is {draw_class} but names a texture")
            runtime_reason = material_draw.get("runtimeReason") or ""
            if not runtime_reason:
                raise SystemExit(f"FAILED: {slug} draw {index} has no committed runtime reason")
            material_row = material_draw.get("material") or {}
            record.update({
                "textureId": None,
                "textureName": None,
                "textureHash": None,
                "textureSource": None,
                "material": {
                    "id": material_row.get("id"),
                    "stage": material_row.get("stage"),
                    "typeName": material_row.get("typeName"),
                    "albedoParameter": material_row.get("parameter"),
                    "archiveOffset": material_row.get("archiveOffset"),
                    "fieldSerializedOffset": material_row.get("fieldSerializedOffset"),
                },
                "runtimeBinding": material_draw.get("binding"),
                "bindingStatus": {
                    "runtimeLightBlend": "runtimeLightBlend",
                    "noAlbedoShader": "runtimePaintLookup" if material_draw.get("shaderFamily") == "paint"
                        else "runtimeShaderNoAlbedo",
                }[draw_class],
                "reason": runtime_reason,
            })
        draws.append(record)

    light_counts = {}
    for material_draw in materials["draws"]:
        # A light draw names the off and the on input, which here resolve to the
        # same image, so count the draw once per distinct referenced texture.
        for texture_id in set((material_draw.get("lightBlendInputs") or {}).values()):
            light_counts[texture_id] = light_counts.get(texture_id, 0) + 1
    for texture in texture_records.values():
        texture["drawCount"] = per_texture_draws.get(texture["id"], 0)
        texture["lightDrawCount"] = light_counts.get(texture["p52Id"], 0)
        # P52's drawIndices list every draw that references the image: the static
        # albedo draws plus the runtime light off/on inputs.
        if texture["drawCount"] + texture["lightDrawCount"] != texture["p52DrawCount"]:
            raise SystemExit(f"FAILED: {slug} texture {texture['id']} draw count differs from P52")
        texture["referenceDrawCount"] = texture["p52DrawCount"]

    uv_bytes = struct.pack("<%df" % len(uv), *uv)
    uv_path = OUT_DIR / f"car-uv-{slug}.bin"
    uv_path.parent.mkdir(parents=True, exist_ok=True)
    uv_path.write_bytes(uv_bytes)
    uv_values_sha = "sha256:" + sha256_bytes(uv_bytes)
    if sha256_bytes(uv_path.read_bytes()) != uv_values_sha[7:]:
        raise SystemExit(f"FAILED: {slug} written UV stream does not re-hash")
    uv_values = len(uv)

    textured = [draw for draw in draws if draw["drawClass"] == "staticAlbedo"]
    paint = [draw for draw in draws if draw["bindingStatus"] == "runtimePaintLookup"]
    light = [draw for draw in draws if draw["bindingStatus"] == "runtimeLightBlend"]
    no_albedo = [draw for draw in draws if draw["bindingStatus"] == "runtimeShaderNoAlbedo"]
    coverage = {
        "drawCount": len(draws),
        "staticAlbedoDraws": len(textured),
        "runtimePaintDraws": len(paint),
        "runtimeLightBlendDraws": len(light),
        "runtimeNoAlbedoDraws": len(no_albedo),
        "textureCount": len(texture_records),
        "rgbaBytes": sum(texture["rgbaBytes"] for texture in texture_records.values()),
        "uvValues": uv_values,
        "uvBytes": len(uv_bytes),
        "uv0AvailableDraws": sum(1 for draw in draws if draw["uv0Available"]),
    }
    if len(textured) + len(paint) + len(light) + len(no_albedo) != len(draws):
        raise SystemExit(f"FAILED: {slug} draw classes do not cover every draw")

    return {
        "slug": slug,
        "name": entry["name"],
        "materials": {
            "path": rel(materials_path),
            "sha256": "sha256:" + entry["manifestSha256"],
            "kind": materials["kind"],
            "version": materials["version"],
        },
        "partManifest": {
            "path": rel(manifest_path),
            "sha256": car_index_entry["manifestSha256"],
        },
        "mesh": {
            "path": rel(mesh_path),
            "sha256": car_index_entry["meshSha256"],
            "vertexCount": vertex_count,
            "indexCount": mesh["indexCount"],
            "positionsSha256": car_index_entry["meshPositionsSha256"],
            "indicesSha256": car_index_entry["meshIndicesSha256"],
        },
        "sceneReport": {
            "path": rel(scene_path),
            "sha256": "sha256:" + COMMITTED_SCENE_REPORTS[slug],
            "positionsSha256": "sha256:" + sha256_bytes(
                struct.pack("<%df" % len(scene["positions"]), *scene["positions"])),
            "positionsNote": (
                "the scene report and the part manifest mesh are numerically identical; the scene report "
                "keeps the reader's signed zeros (-0) for positions and UV, while mesh.json serialized them "
                "as 0, so a byte hash over the two position arrays differs in the sign of zero only. The "
                "exported UV0 stream is the scene-report bit pattern, signed zeros included"),
            "uv0Source": "scene_inspect.exe merged mesh uv0 array, parallel to positions",
        },
        "uvStream": {
            "path": rel(uv_path),
            "storage": "float32-le",
            "components": 2,
            "vertexCount": vertex_count,
            "values": uv_values,
            "bytes": len(uv_bytes),
            "sha256": uv_values_sha,
            "order": "the car mesh vertex order in geometry.json",
            "bounds": {
                "min": [min(uv[0::2]), min(uv[1::2])],
                "max": [max(uv[0::2]), max(uv[1::2])],
            },
        },
        "textures": [texture_records[key] for key in sorted(
            texture_records, key=lambda value: (value.startswith("block"), value))],
        "draws": draws,
        "coverage": coverage,
    }


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(MANIFEST_OUT))
    args = parser.parse_args(argv)

    roster_index_path = CAR_MATERIALS / "index.json"
    roster_index_raw = load_pinned(roster_index_path, COMMITTED_ROSTER_INDEX, "P52 roster index")
    roster_index = json.loads(roster_index_raw)
    if roster_index.get("kind") != "blur.car-material-texture-index" or roster_index.get("version") != 1:
        raise SystemExit("FAILED: P52 roster index kind/version is wrong")

    car_index_path = CAR_PARTS / "index.json"
    car_index_raw = load_pinned(car_index_path, COMMITTED_CAR_INDEX, "car-parts index")
    car_index = json.loads(car_index_raw)
    if car_index.get("kind") != "car-parts.car-model-index" or car_index.get("version") != 1:
        raise SystemExit("FAILED: car-parts index kind/version is wrong")

    cars = [entry["slug"] for entry in roster_index["cars"]]
    by_slug = {entry["slug"]: entry for entry in roster_index["cars"]}
    car_index_by_slug = {entry["slug"]: entry for entry in car_index["cars"]}
    if set(cars) != set(car_index_by_slug):
        raise SystemExit("FAILED: the P52 roster and the car-parts index do not cover the same cars")
    roster_order = [car["slug"] for car in JsonReader.load(
        ROOT / "probes/e1-drive/cars/roster.json")["cars"]]
    if set(roster_order) != set(cars):
        raise SystemExit("FAILED: the e1-drive roster and the P52 roster do not cover the same cars")

    records = []
    for slug in roster_order:
        entry = by_slug[slug]
        car_index_entry = car_index_by_slug[slug]
        if not car_index_entry.get("mapped"):
            raise SystemExit(f"FAILED: {slug} is not mapped in the car-parts index")
        records.append(build_car(entry, car_index_entry))

    if not set(EXPECTED_BY_CAR) <= set(roster_order):
        raise SystemExit(
            "FAILED: the pinned per-car expectations name a car outside the roster"
        )
    if set(EXPECTED_BY_CAR) != set(roster_order):
        raise SystemExit(
            "FAILED: the pinned per-car expectations do not cover exactly the roster"
        )
    for record in records:
        coverage = record["coverage"]
        expected = EXPECTED_BY_CAR[record["slug"]]
        actual = {
            "draws": coverage["drawCount"],
            "staticAlbedoDraws": coverage["staticAlbedoDraws"],
            "paintDraws": coverage["runtimePaintDraws"],
            "lightDraws": coverage["runtimeLightBlendDraws"],
            "noAlbedoDraws": coverage["runtimeNoAlbedoDraws"],
            "textures": coverage["textureCount"],
            "rgbaBytes": coverage["rgbaBytes"],
            "uvValues": coverage["uvValues"],
        }
        for key, value in expected.items():
            if actual[key] != value:
                raise SystemExit(
                    f"FAILED: {record['slug']} {key} is {actual[key]}, pinned {value}"
                )

    totals = {
        "cars": len(records),
        "draws": sum(record["coverage"]["drawCount"] for record in records),
        "staticAlbedoDraws": sum(record["coverage"]["staticAlbedoDraws"] for record in records),
        "runtimePaintDraws": sum(record["coverage"]["runtimePaintDraws"] for record in records),
        "runtimeLightBlendDraws": sum(record["coverage"]["runtimeLightBlendDraws"] for record in records),
        "runtimeNoAlbedoDraws": sum(record["coverage"]["runtimeNoAlbedoDraws"] for record in records),
        "textures": sum(record["coverage"]["textureCount"] for record in records),
        "rgbaBytes": sum(record["coverage"]["rgbaBytes"] for record in records),
        "uvValues": sum(record["coverage"]["uvValues"] for record in records),
        "uvBytes": sum(record["coverage"]["uvBytes"] for record in records),
    }
    expected_map = {
        "cars": len(EXPECTED_BY_CAR),
        "draws": sum(row["draws"] for row in EXPECTED_BY_CAR.values()),
        "staticAlbedoDraws": sum(row["staticAlbedoDraws"] for row in EXPECTED_BY_CAR.values()),
        "runtimePaintDraws": sum(row["paintDraws"] for row in EXPECTED_BY_CAR.values()),
        "runtimeLightBlendDraws": sum(row["lightDraws"] for row in EXPECTED_BY_CAR.values()),
        "runtimeNoAlbedoDraws": sum(row["noAlbedoDraws"] for row in EXPECTED_BY_CAR.values()),
        "textures": sum(row["textures"] for row in EXPECTED_BY_CAR.values()),
        "rgbaBytes": sum(row["rgbaBytes"] for row in EXPECTED_BY_CAR.values()),
        "uvValues": sum(row["uvValues"] for row in EXPECTED_BY_CAR.values()),
    }
    for key, value in expected_map.items():
        if totals[key] != value:
            raise SystemExit(f"FAILED: total {key} is {totals[key]}, pinned {value}")

    # P52 also states that per-car static + paint + light + no-albedo == draws.
    for record in records:
        coverage = record["coverage"]
        if coverage["staticAlbedoDraws"] + coverage["runtimePaintDraws"] + \
                coverage["runtimeLightBlendDraws"] + coverage["runtimeNoAlbedoDraws"] != coverage["drawCount"]:
            raise SystemExit(f"FAILED: {record['slug']} draw classes do not add up")
        for draw in record["draws"]:
            if draw["drawClass"] == "staticAlbedo" and not draw["uv0Available"]:
                raise SystemExit(f"FAILED: {record['slug']} textured draw {draw['index']} has no UV0")

    manifest = {
        "kind": "e1-drive.car-textures",
        "version": 1,
        "generator": "probes/e1-drive/tools/build_car_textures.py",
        "scope": (
            "UV0 and static g_MeshTexture bindings for the five E1 roster cars. Draw/material/texture "
            "resolution and the decoded RGBA are the committed P52 manifest; the UV0 array is the "
            "committed scene_inspect.exe mesh stream whose positions equal the part manifest mesh. No UV, "
            "colour, address mode, mip level or runtime input is synthesised"
        ),
        "pins": {
            "p52RosterIndex": "sha256:" + COMMITTED_ROSTER_INDEX,
            "carPartsIndex": "sha256:" + COMMITTED_CAR_INDEX,
            "p52RosterIndexBytes": len(roster_index_raw),
            "carPartsIndexBytes": len(car_index_raw),
        },
        "sampler": SAMPLER,
        "uvConvention": UV_CONVENTION,
        "scopeLabels": {
            "materialsApplied": False,
            "shaderExecuted": False,
            "samplerApplied": False,
            "paintLookupRecovered": False,
            "lightBlendRecovered": False,
            "mipsApplied": False,
            "srgbApplied": False,
            "rendererClaim": False,
        },
        "cars": records,
        "totals": totals,
        "coverage": {
            "drawClasses": {
                "staticAlbedo": totals["staticAlbedoDraws"],
                "runtimePaintLookup": totals["runtimePaintDraws"],
                "runtimeLightBlend": totals["runtimeLightBlendDraws"],
                "runtimeShaderNoAlbedo": totals["runtimeNoAlbedoDraws"],
            },
            "note": (
                "224 draws sample a decoded static albedo image with the car's own UV0; 267 draws are "
                "runtime-only and keep the committed P52 reason and the diagnostic albedo (45 paint lookup, "
                "66 light off/on blend, 156 _NO_ALBEDO). No runtime image is invented"),
        },
        "limits": [
            "First RenderList base primitives, LOD0 only: later render lists, higher LODs, damage states, "
            "paint variants and runtime light states are not imported.",
            "No mip chain, sRGB conversion, anisotropy, material colour, blend state or shader stages: only the "
            "decoded mip0 albedo pixels are bound.",
            "The sampler is a declared PoC choice (repeat/linear on mip0), not recovered engine state.",
            "Paint lookups and light off/on blends are runtime inputs and stay unresolved by design.",
            "The car mesh is drawn in the engine body frame; the retail mesh import offset is not recovered.",
        ],
    }
    text = json.dumps(manifest, indent=1)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    # Write the exact bytes that were hashed, LF newlines, no platform translation.
    out.write_bytes(text.encode("utf-8"))

    print(json.dumps({
        "output": rel(out),
        "bytes": len(text.encode("utf-8")),
        "sha256": "sha256:" + sha256_bytes(text.encode("utf-8")),
        "cars": len(records),
        "totals": totals,
        "perCar": [
            {
                "slug": record["slug"],
                "draws": record["coverage"]["drawCount"],
                "textured": record["coverage"]["staticAlbedoDraws"],
                "paint": record["coverage"]["runtimePaintDraws"],
                "light": record["coverage"]["runtimeLightBlendDraws"],
                "noAlbedo": record["coverage"]["runtimeNoAlbedoDraws"],
                "textures": record["coverage"]["textureCount"],
                "rgbaBytes": record["coverage"]["rgbaBytes"],
                "uvValues": record["coverage"]["uvValues"],
                "uvSha256": record["uvStream"]["sha256"],
            }
            for record in records
        ],
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))



