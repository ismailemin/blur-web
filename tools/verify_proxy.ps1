param(
    [int]$Port = 8443,
    [switch]$KeepRunning
)

# Self-check for the internet deploy path: page + room behind the TLS proxy,
# two real pages, one shared race result.
#
#   powershell -ExecutionPolicy Bypass -File tools/verify_proxy.ps1
#
# It starts the game server, the room service and the TLS proxy (idempotent),
# then runs the `mp-two` e2e scenario against https://localhost:<port>/ with
# --ignore-cert. The certificate is the local development certificate created
# by tools/deploy_local.ps1; it is never a production certificate.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

Write-Host '1/3  starting the game + room + TLS proxy (idempotent)...' -ForegroundColor Cyan
& (Join-Path $PSScriptRoot 'deploy_local.ps1') -Port $Port | Out-Null

Write-Host '2/3  checking the proxy health endpoint...' -ForegroundColor Cyan
$healthPort = $Port + 1
$healthy = $false
for ($i = 0; $i -lt 40; $i++) {
    try {
        $response = Invoke-WebRequest -UseBasicParsing ("http://127.0.0.1:" + $healthPort + "/") -TimeoutSec 3
        if ($response.Content -eq 'tls-proxy-ok') { $healthy = $true; break }
    } catch { Start-Sleep -Milliseconds 250 }
}
if (-not $healthy) { throw ('the TLS proxy health endpoint on ' + $healthPort + ' did not answer') }
Write-Host '     tls-proxy-ok'

Write-Host '3/3  running the two-page race over the proxied origin...' -ForegroundColor Cyan
$node = Join-Path $root '_work/toolchains/emsdk/node/24.19.0_64bit/node.exe'
if (-not (Test-Path $node)) { $node = 'node' }
& $node (Join-Path $root 'probes/e2e/run.mjs') --scenarios mp-two `
    --base ("https://localhost:" + $Port + "/") `
    --room-url ("wss://localhost:" + $Port + "/ws") `
    --ignore-cert
$code = $LASTEXITCODE

if ($code -ne 0) {
    Write-Host 'PROXY CHECK FAILED' -ForegroundColor Red
    exit $code
}
Write-Host ''
Write-Host 'PROXY CHECK PASSED: two pages raced through the TLS reverse proxy.' -ForegroundColor Green
Write-Host ('  page  https://localhost:' + $Port + '/')
Write-Host ('  room  wss://localhost:' + $Port + '/ws')
Write-Host 'The same two routes are in deploy/Caddyfile and deploy/nginx.conf.'
if (-not $KeepRunning) {
    Write-Host '(The servers stay up; stop them with tools/stop_e1_poc.ps1 or by port.)'
}
