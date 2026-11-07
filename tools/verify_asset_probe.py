"""Rebuild local fixtures and run the reproducible native/WASM asset verification suite."""
from __future__ import annotations
import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--skip-build',action='store_true')
    args=parser.parse_args()
    evidence=ROOT/'_work/verification'
    evidence.mkdir(parents=True,exist_ok=True)
    steps=[
        ('model-fixture',[sys.executable,'tools/prepare_model_fixture.py']),
        ('model-corpus',[sys.executable,'tools/prepare_model_corpus.py']),
        ('texture-arrow',[sys.executable,'tools/prepare_texture_fixture.py']),
        ('texture-bc2',[sys.executable,'tools/prepare_texture_fixture.py','--path',r'\dontship\textures\debugframe.texture','--output-name','debugframe']),
        ('texture-bc3',[sys.executable,'tools/prepare_texture_fixture.py','--path',r'\graphics\textures\particles\splash01.texture','--output-name','splash']),
        ('material-binding',[sys.executable,'tools/inspect_material_binding.py']),
        ('xt-fixtures',[sys.executable,'tools/prepare_xt_fixture.py']),
        ('car-reference',[sys.executable,'tools/inspect_car_level_assets.py']),
        ('car-material-reference',[sys.executable,'tools/inspect_car_materials.py']),
        ('level-reference',[sys.executable,'tools/inspect_level_chunk.py']),
    ]
    if not args.skip_build:steps.append(('build-native-wasm',[sys.executable,'tools/build_asset_probe.py']))
    steps.extend([
        ('level-candidates-reference',[sys.executable,'tools/inspect_level_candidates.py']),
        ('pak-independent',[sys.executable,'tools/verify_pak_reference.py']),
        *[(name,['node',f'probes/asset-reader/tests/{file}.mjs']) for name,file in [
            ('pak-native-wasm','verify_wasm'),('model-native-wasm','verify_model_wasm'),
            ('mesh-native-wasm','verify_mesh_wasm'),('scene-native-wasm','verify_scene_wasm'),
            ('texture-native-wasm','verify_texture_wasm'),('car-native-wasm','verify_car_wasm'),
            ('resource-binding','verify_resource_binding'),
            ('xt-native-wasm','verify_xt_wasm'),('level-native-wasm','verify_level_wasm'),
            ('level-instances-native-wasm','verify_instances_wasm'),
            ('level-candidates-native-wasm','verify_level_candidates_wasm'),('packet-cases','verify_packets'),
            ('packet-independent','verify_packet_reference'),('viewer-math','verify_viewer_math')]],
        ('level-http-bounds',[sys.executable,'probes/asset-reader/tests/verify_level_http.py']),
        ('scheduler-probe',[sys.executable,'probes/scheduler-probe/tests/run_scheduler_probe.py']+(['--skip-build'] if args.skip_build else [])),
        ('collision-oracle',[sys.executable,'probes/collision-oracle/tests/run_collision_oracle.py']+(['--skip-build'] if args.skip_build else [])),
        ('net-layout',[sys.executable,'probes/net-layout/tests/run_net_layout.py']+(['--skip-build'] if args.skip_build else [])),
        ('powerups-definitions',[sys.executable,'probes/powerups/tools/verify_powerups.py']),
        ('powerups-rules',['node','probes/powerups/rules/tests.mjs']),
        ('pickup-placements',[sys.executable,'probes/powerups/tools/verify_pickup_placement.py']),
        ('powerups-model',['node','probes/e1-drive/tools/powerups_model_tests.mjs']),
        ('vehicle-pipeline',[sys.executable,'probes/vehicle-pipeline/tools/verify_vehicle_pipeline.py']),
        ('map-pipeline',[sys.executable,'probes/map-pipeline/tools/verify_maps.py']),
        ('prop-collision-v2',['node','probes/prop-collision/tools/verify_v2.mjs']),
        ('race-rules',['node','probes/race-rules/verify.mjs']),
        ('net-mvp-selftest',['node','probes/net-mvp/selftest.mjs']),
        ('map-slice-amboy',[sys.executable,'probes/map-slice/tools/verify_slice.py','--package','_work/map-slice/amboy']),
        ('ai-driver',['node','probes/ai-driver/verify.mjs']),
        ('amboy-textures',[sys.executable,'probes/map-slice/tools/verify_amboy_texture_bindings.py']),
        ('amboy-render',[sys.executable,'probes/map-slice/tools/verify_amboy_render.py','--package','_work/map-slice/amboy-render']),
        ('gracia-slice',[sys.executable,'probes/map-slice/tools/verify_slice.py','--package','_work/map-slice/gracia']),
        ('gracia-textures',[sys.executable,'probes/map-slice/tools/verify_amboy_texture_bindings.py','--level','spa_barcelona_gracia']),
        ('gracia-render',[sys.executable,'probes/map-slice/tools/verify_amboy_render.py','--package','_work/map-slice/gracia-render','--level','spa_barcelona_gracia']),
    ])
    results=[]
    for name,command in steps:
        log=evidence/(name+'.log')
        with log.open('w',encoding='utf-8') as stream:
            completed=subprocess.run(command,cwd=ROOT,stdout=stream,stderr=subprocess.STDOUT)
        results.append({'step':name,'exitCode':completed.returncode,'log':str(log)})
        (evidence/'suite.json').write_text(json.dumps({'utc':datetime.now(timezone.utc).isoformat(),'checks':results},indent=2)+'\n',encoding='utf-8')
        print(f'{name}: {"PASS" if completed.returncode==0 else "FAIL"}',flush=True)
        if completed.returncode:
            print(log.read_text(encoding='utf-8')[-4000:])
            raise SystemExit(completed.returncode)
    print(f'Passed {len(results)} checks. Browser/GPU visual checks are separate.')

if __name__=='__main__':main()
