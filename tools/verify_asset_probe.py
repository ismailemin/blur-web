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
        ('pickup-amboy',[sys.executable,'probes/powerups/tools/verify_pickup_placement_levels.py','--level','usa_amboy']),
        ('pickup-gracia',[sys.executable,'probes/powerups/tools/verify_pickup_placement_levels.py','--level','spa_barcelona_gracia']),
        ('powerups-model',['node','probes/e1-drive/tools/powerups_model_tests.mjs']),
        ('projectiles',[sys.executable,'probes/powerups/tools/verify_projectiles.py']),
        ('supershield',[sys.executable,'probes/powerups/tools/verify_supershield.py']),
        ('supershield-rules',['node','probes/powerups/rules/supershield.test.mjs']),
        ('projectile-rules',['node','probes/powerups/rules/projectiles.test.mjs']),
        ('boost-model',['node','probes/e1-drive/tools/boost_model_tests.mjs']),
        ('minimap',['node','probes/e1-drive/tools/minimap_tests.mjs']),
        ('race-modes',['node','probes/e1-drive/tools/race_modes_tests.mjs']),
        ('amboy-map',['node','probes/e1-drive/tools/verify_e1_map.mjs']),
        ('gracia-map',['node','probes/e1-drive/tools/verify_e1_map.mjs','--map','gracia']),
        ('longbeach-map',['node','probes/e1-drive/tools/verify_e1_map.mjs','--map','longbeach']),
        ('observatory-map',['node','probes/e1-drive/tools/verify_e1_map.mjs','--map','observatory']),
        ('downtown-map',['node','probes/e1-drive/tools/verify_e1_map.mjs','--map','downtown']),
        ('mharuna-map',['node','probes/e1-drive/tools/verify_e1_map.mjs','--map','mharuna']),
        ('highrise-map',['node','probes/e1-drive/tools/verify_e1_map.mjs','--map','highrise']),
        ('shutoko-map',['node','probes/e1-drive/tools/verify_e1_map.mjs','--map','shutoko']),
        ('oval-map',['node','probes/e1-drive/tools/verify_e1_map.mjs','--map','oval']),
        ('amboy-mp-map',['node','probes/e1-drive/tools/verify_e1_map.mjs','--map','amboy-mp']),
        ('hackney-map',['node','probes/e1-drive/tools/verify_e1_map.mjs','--map','hackney']),
        ('russianhill-map',['node','probes/e1-drive/tools/verify_e1_map.mjs','--map','russianhill']),
        ('brighton-map',['node','probes/e1-drive/tools/verify_e1_map.mjs','--map','brighton']),
        ('longbeach-path',['node','probes/map-laps/tools/verify_longbeach_path.mjs']),
        ('vehicle-pipeline',[sys.executable,'probes/vehicle-pipeline/tools/verify_vehicle_pipeline.py']),
        ('vehicle-c-aliases',[sys.executable,'probes/vehicle-pipeline/tools/verify_c_aliases.py']),
        ('vehicle-batch3',[sys.executable,'probes/vehicle-pipeline/tools/verify_batch3.py']),
        ('map-pipeline',[sys.executable,'probes/map-pipeline/tools/verify_maps.py']),
        ('prop-collision-v2',['node','probes/prop-collision/tools/verify_v2.mjs']),
        ('retail-parity-inventory',[sys.executable,'probes/retail-parity/tools/inventory.py']),
        ('pickup-runtime-amboy',[sys.executable,'probes/powerups/tools/verify_pickup_runtime.py','--level','usa_amboy']),
        ('pickup-runtime-gracia',[sys.executable,'probes/powerups/tools/verify_pickup_runtime.py','--level','spa_barcelona_gracia']),
        ('map-laps-amboy',[sys.executable,'probes/map-laps/tools/verify_map_loops.py','--level','usa_amboy']),
        ('map-laps-gracia',[sys.executable,'probes/map-laps/tools/verify_map_loops.py','--level','spa_barcelona_gracia']),
        ('map-textures',[sys.executable,'probes/textures/verify.py']),
        ('race-rules',['node','probes/race-rules/verify.mjs']),
        ('net-mvp-selftest',['node','probes/net-mvp/selftest.mjs']),
        ('map-slice-amboy',[sys.executable,'probes/map-slice/tools/verify_slice.py','--package','_work/map-slice/amboy']),
        ('ai-driver',['node','probes/ai-driver/verify.mjs']),
        ('ai-maps',['node','probes/ai-driver/verify-maps.mjs']),
        ('amboy-textures',[sys.executable,'probes/map-slice/tools/verify_amboy_texture_bindings.py']),
        ('amboy-render',[sys.executable,'probes/map-slice/tools/verify_amboy_render.py','--package','_work/map-slice/amboy-render']),
        ('gracia-slice',[sys.executable,'probes/map-slice/tools/verify_slice.py','--package','_work/map-slice/gracia']),
        ('gracia-textures',[sys.executable,'probes/map-slice/tools/verify_amboy_texture_bindings.py','--level','spa_barcelona_gracia']),
        ('gracia-render',[sys.executable,'probes/map-slice/tools/verify_amboy_render.py','--package','_work/map-slice/gracia-render','--level','spa_barcelona_gracia']),
        ('longbeach-slice',[sys.executable,'probes/map-slice/tools/verify_slice.py','--package','_work/map-slice/longbeach']),
        ('longbeach-textures',[sys.executable,'probes/map-slice/tools/verify_amboy_texture_bindings.py','--level','usa_la_longbeachdocks']),
        ('longbeach-render',[sys.executable,'probes/map-slice/tools/verify_amboy_render.py','--package','_work/map-slice/longbeach-render','--level','usa_la_longbeachdocks']),
        # Wave-2 verifiers: the mode catalog, the blocked-map inventory, the
        # nineteen-level batch, the instance/decal census, the net prediction
        # bound, the malformed-input inventory, the measured Amboy lap, the
        # Amboy/Gracia prop colliders and the projected pickup placement.
        ('race-rules-modes',['node','probes/race-rules/verify-modes.mjs']),
        ('map-pipeline-blocked',[sys.executable,'probes/map-pipeline/tools/verify_blocked.py']),
        ('map-batch',[sys.executable,'probes/map-batch/tools/verify_batch.py']),
        ('instances',[sys.executable,'probes/instances/tools/verify_instances_decals.py','--skip-rebuild']),
        ('net-prediction',['node','probes/net-prediction/verify.mjs']),
        ('robustness',['node','probes/robustness/verify.mjs']),
        ('map-laps-amboy-lap',['node','probes/map-laps/tools/verify_amboy_lap.mjs']),
        ('map-props',['node','probes/map-props/tools/verify.mjs']),
        ('powerups-runtime-placement',['node','probes/powerups/tools/verify_runtime_placement.mjs']),
        # Runtime modules the page can mount: lighting, car materials, HUD, the
        # nineteen-level decision table and the Gracia no-lap decision.
        ('lighting-runtime',['node','probes/lighting/tools/verify_runtime_lighting.mjs']),
        ('lighting-lightmap',['node','probes/lighting/tools/verify_lightmap.mjs']),
        ('lighting-lightmap-runtime',['node','probes/lighting/tools/verify_lightmap_runtime.mjs']),
        ('audio-runtime',['node','probes/audio/tools/verify_runtime_audio.mjs']),
        ('car-materials-runtime',['node','probes/car-materials/tools/verify_runtime_materials.mjs']),
        ('hud-ui',['node','--test','probes/hud-ui/test/']),
        ('map-pipeline-decisions',[sys.executable,'probes/map-pipeline/tools/verify_map_decisions.py']),
        ('map-laps-gracia-nolap',['node','probes/map-laps/tools/verify_gracia_no_lap.mjs']),
        ('powerups-pickup-routes',['node','probes/powerups/tools/verify_pickup_routes.mjs']),
        ('powerups-retail-placement',['node','probes/powerups/tools/verify_retail_placement.mjs']),
        ('powerups-aid',['node','probes/powerups-aid/tools/verify_physical_placement.mjs']),
        ('map-laps-aid',['node','probes/map-laps-aid/tools/verify_aid_paths.mjs']),
        ('vehicle-batch-roster',[sys.executable,'probes/vehicle-batch/tools/verify_batch_roster.py']),
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
            print(log.read_text(encoding='utf-8',errors='replace')[-4000:])
            raise SystemExit(completed.returncode)
    print(f'Passed {len(results)} checks. Browser/GPU visual checks are separate.')

if __name__=='__main__':main()
