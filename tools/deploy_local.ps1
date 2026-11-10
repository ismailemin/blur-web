param(
    [int]$Port = 8443,
    [string]$Bind = '127.0.0.1',
    [switch]$RegenerateCert,
    [switch]$SkipProxy
)

# One-command local deploy check: page + room behind a TLS reverse proxy.
#
# It starts the game server and the room service on loopback, generates a local
# development certificate when needed, and starts `tools/tls-proxy.mjs` on
# https://localhost:<port>. The production equivalent is `deploy/Caddyfile` or
# `deploy/nginx.conf`.
#
#   powershell -ExecutionPolicy Bypass -File tools/deploy_local.ps1
#
# The certificate is a development certificate for localhost only. It is never
# a production certificate and is not committed.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pfx = Join-Path $root 'deploy/local-dev.pfx'
$pfxPassphrase = 'blur'
$node = Join-Path $root '_work/toolchains/emsdk/node/24.19.0_64bit/node.exe'
if (-not (Test-Path $node)) { $node = 'node' }

function Test-Port([int]$port) {
    return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

# ---------------------------------------------------------------- certificate
if ($RegenerateCert -or -not (Test-Path $pfx)) {
    Write-Host 'Generating the local development certificate (localhost, 365 days)...' -ForegroundColor Cyan
    $cert = New-SelfSignedCertificate -DnsName 'localhost', '127.0.0.1' `
        -CertStoreLocation 'Cert:\CurrentUser\My' -NotAfter (Get-Date).AddDays(365)
    $secure = ConvertTo-SecureString -String $pfxPassphrase -Force -AsPlainText
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $pfx) | Out-Null
    Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $secure | Out-Null
    Remove-Item -Path ("Cert:\CurrentUser\My\" + $cert.Thumbprint) -Force -ErrorAction SilentlyContinue
    Write-Host ('Certificate written to ' + $pfx + ' (passphrase "' + $pfxPassphrase + '")')
}

# ---------------------------------------------------------------- game + room
if (-not (Test-Port 8801) -or -not (Test-Port 8811)) {
    Write-Host 'Starting the game server and the room service on 8801/8811...' -ForegroundColor Cyan
    Start-Process -FilePath $node -ArgumentList @(
        'probes/e1-drive/tools/serve.mjs', '--port', '8801', '--with-room',
        '--room-port', '8811', '--host', $Bind
    ) -WorkingDirectory $root `
      -RedirectStandardOutput (Join-Path $root '_work/logs/deploy-server.log') `
      -RedirectStandardError (Join-Path $root '_work/logs/deploy-server.err.log') | Out-Null
    for ($i = 0; $i -lt 40 -and -not (Test-Port 8801); $i++) { Start-Sleep -Milliseconds 250 }
} else {
    Write-Host 'Game server and room service already listening on 8801/8811.'
}

# ---------------------------------------------------------------- TLS proxy
if (-not $SkipProxy) {
    if (Test-Port $Port) {
        Write-Host ('TLS proxy port ' + $Port + ' is already in use; reusing it.')
    } else {
        Write-Host ('Starting the TLS proxy on https://localhost:' + $Port + '/ ...') -ForegroundColor Cyan
        Start-Process -FilePath $node -ArgumentList @(
            'tools/tls-proxy.mjs', '--port', [string]$Port,
            '--page', '127.0.0.1:8801', '--room', '127.0.0.1:8811',
            '--pfx', 'deploy/local-dev.pfx', '--passphrase', $pfxPassphrase
        ) -WorkingDirectory $root `
          -RedirectStandardOutput (Join-Path $root '_work/logs/deploy-proxy.log') `
          -RedirectStandardError (Join-Path $root '_work/logs/deploy-proxy.err.log') | Out-Null
        for ($i = 0; $i -lt 40 -and -not (Test-Port $Port); $i++) { Start-Sleep -Milliseconds 250 }
    }
}

# ---------------------------------------------------------------- summary
$lan = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254*' } |
    Select-Object -First 1 -ExpandProperty IPAddress)

Write-Host ''
Write-Host 'Blur Web deploy check' -ForegroundColor Green
Write-Host ('  page (loopback)   http://127.0.0.1:8801/')
Write-Host ('  page (TLS proxy)  https://localhost:' + $Port + '/')
if ($lan) { Write-Host ('  page (LAN)        https://' + $lan + ':' + $Port + '/') }
Write-Host ('  room (TLS proxy)  wss://localhost:' + $Port + '/ws')
Write-Host ''
Write-Host 'The browser will warn about the development certificate; accept it once'
Write-Host 'for localhost, or run the self-check which ignores it explicitly:'
Write-Host ('  node probes/e2e/run.mjs --scenarios mp-two --base https://localhost:' + $Port +
    '/ --room-url wss://localhost:' + $Port + '/ws --ignore-cert')
Write-Host ''
Write-Host 'Production: point deploy/Caddyfile or deploy/nginx.conf at the real'
Write-Host 'hostname and run the game process with -Bind 127.0.0.1.'
