param(
    [switch]$SkipBuild,
    [switch]$SkipBrowser,
    [string]$Tag = ''
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$py = 'C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
if (-not (Test-Path $py)) { $py = 'python' }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if (-not $Tag) { $Tag = 'gate' }
$logDir = Join-Path $root "_work/logs/gate/$stamp-$Tag"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$results = @()

function Run-Step($name, $exe, $arguments) {
    $log = Join-Path $logDir ($name + '.log')
    Write-Host ""
    Write-Host "== $name" -ForegroundColor Cyan
    $start = Get-Date
    & $exe @arguments *> $log
    $code = $LASTEXITCODE
    $seconds = [math]::Round(((Get-Date) - $start).TotalSeconds, 1)
    $tail = if (Test-Path $log) { (Get-Content $log -Tail 3) -join ' | ' } else { 'no log' }
    Write-Host ("   exit=$code  {0}s  {1}" -f $seconds, $tail)
    $script:results += [pscustomobject]@{ step = $name; exit = $code; seconds = $seconds; log = $log; tail = $tail }
}

if (-not $SkipBuild) {
    Run-Step 'asset-probe' $py @('tools/verify_asset_probe.py')
} else {
    Run-Step 'asset-probe' $py @('tools/verify_asset_probe.py', '--skip-build')
}
$ctest = (Get-Command ctest -ErrorAction SilentlyContinue)
if ($null -eq $ctest) {
    $candidate = Get-ChildItem 'C:\Program Files*\CMake\bin\ctest.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($candidate) { $ctest = $candidate.FullName }
}
if ($ctest) {
    Run-Step 'ctest' $ctest @('--test-dir', '_work/build/asset-reader-native', '-C', 'Release', '--output-on-failure')
} else {
    Write-Host ""
    Write-Host '== ctest SKIPPED (ctest.exe not installed on this machine)' -ForegroundColor Yellow
    $results += [pscustomobject]@{ step = 'ctest'; exit = 0; seconds = 0; log = ''; tail = 'skipped: ctest not installed' }
}
Run-Step 'check-e1-poc' $py @('tools/check_e1_poc.py')
$node = Join-Path $root '_work/toolchains/emsdk/node/24.19.0_64bit/node.exe'
if (-not (Test-Path $node)) { $node = 'node' }
Run-Step 'verify-e1-drive' $node @('probes/e1-drive/tools/verify_e1_drive.mjs')
if (-not $SkipBrowser) {
    $e2e = Join-Path $root 'probes/e2e/run.mjs'
    if (Test-Path $e2e) {
        Run-Step 'e2e' $node @('probes/e2e/run.mjs', '--base', 'http://127.0.0.1:8801/')
    } else {
        Write-Host ""
        Write-Host '== e2e skipped (probes/e2e/run.mjs not present yet)' -ForegroundColor Yellow
    }
}

$report = Join-Path $logDir 'summary.json'
$results | ConvertTo-Json -Depth 4 | Set-Content -Path $report -Encoding UTF8

Write-Host ""
$failed = @($results | Where-Object { $_.exit -ne 0 })
foreach ($r in $results) {
    $colour = if ($r.exit -eq 0) { 'Green' } else { 'Red' }
    Write-Host ("{0,-16} {1}" -f $r.step, ($(if ($r.exit -eq 0) { 'PASS' } else { 'FAIL ' + $r.exit }))) -ForegroundColor $colour
}
Write-Host ""
Write-Host "logs: $logDir"
if ($failed.Count -gt 0) {
    exit 1
}
exit 0
