param(
    [int]$Port = 8801,
    [int]$RoomPort = 8811,
    [string]$HostAddress = '127.0.0.1',
    [switch]$KeepStale
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = Join-Path $root '_work/toolchains/emsdk/node/24.19.0_64bit/node.exe'
if (-not (Test-Path $node)) { $node = 'node' }

function Stop-Port($port, $label) {
    $listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if (-not $listeners) { return }
    if ($KeepStale) {
        throw "$label port $port is already in use; stop it first or drop -KeepStale."
    }
    foreach ($pid in ($listeners | Select-Object -ExpandProperty OwningProcess -Unique)) {
        try {
            $proc = Get-Process -Id $pid -ErrorAction Stop
            Write-Host "Stopping stale $label listener on $port (PID $pid, $($proc.ProcessName))" -ForegroundColor Yellow
        } catch {
            Write-Host "Stopping stale $label listener on $port (PID $pid)" -ForegroundColor Yellow
        }
        taskkill /PID $pid /T /F 2>&1 | Out-Null
    }
    Start-Sleep -Milliseconds 500
}

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

Stop-Port $Port 'static'
Stop-Port $RoomPort 'room'

$base = "http://127.0.0.1:$Port/"
Write-Host ''
Write-Host "E1 PoC       ->  $base" -ForegroundColor Green
Write-Host "Manual drive ->  ${base}" -ForegroundColor Green
Write-Host "Lap race     ->  ${base}?course=lap"
Write-Host "Free roam    ->  ${base}?course=free"
Write-Host "Amboy        ->  ${base}?map=amboy"
Write-Host "Gracia       ->  ${base}?map=gracia"
Write-Host "MP host      ->  ${base}?mp=1&host=1"
Write-Host "MP guest     ->  ${base}?mp=1&room=<CODE>"
Write-Host "Room service ->  ws://127.0.0.1:$RoomPort/ws"
Write-Host 'Stop with Ctrl+C (or tools/stop_e1_poc.ps1).'
Write-Host ''
& $node (Join-Path $root 'probes/e1-drive/tools/serve.mjs') --port $Port --with-room --room-port $RoomPort --host $HostAddress
