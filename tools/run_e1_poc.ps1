$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = Join-Path $root '_work/toolchains/emsdk/node/24.19.0_64bit/node.exe'
if (-not (Test-Path $node)) { $node = 'node' }

$required = @(
    '_work/e1-drive/module/e1_drive.mjs',
    '_work/e1-drive/module/e1_drive.wasm',
    '_work/e1-drive/geometry.json',
    '_work/e1-drive/Level.levelphysics',
    '_work/e1-drive/spawn.json',
    '_work/e1-drive/cars.json',
    '_work/e1-drive/cars/audi-r8v10-stock.fields'
)
$missing = @()
foreach ($rel in $required) {
    if (-not (Test-Path (Join-Path $root $rel))) { $missing += $rel }
}
if ($missing.Count -gt 0) {
    Write-Host 'E1 PoC artifacts are missing:' -ForegroundColor Yellow
    $missing | ForEach-Object { Write-Host "  $_" }
    Write-Host ''
    Write-Host 'Build them with:'
    Write-Host '  node probes/render-packet/tools/build_packet.mjs'
    Write-Host '  python engine/verify_vehicle.py --skip-build'
    Write-Host '  node probes/e1-drive/tools/build_module.mjs --force-objects'
    Write-Host '  node probes/e1-drive/tools/build_geometry.mjs'
    Write-Host '  python probes/e1-drive/tools/car_roster.py'
    exit 2
}

Write-Host 'E1 PoC  ->  http://127.0.0.1:8801/' -ForegroundColor Green
Write-Host 'Scripted ->  http://127.0.0.1:8801/?script=drive&car=audi-r8v10-stock'
Write-Host 'Stop with Ctrl+C.'
& $node (Join-Path $root 'probes/e1-drive/tools/serve.mjs') --port 8801
