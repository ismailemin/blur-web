param(
    [int[]]$Ports = @(8801, 8811)
)

$stopped = @()
foreach ($port in $Ports) {
    $listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if (-not $listeners) {
        Write-Host "port $port : not listening"
        continue
    }
    foreach ($pid in ($listeners | Select-Object -ExpandProperty OwningProcess -Unique)) {
        try {
            $proc = Get-Process -Id $pid -ErrorAction Stop
            Write-Host "port $port : stopping PID $pid ($($proc.ProcessName))"
        } catch {
            Write-Host "port $port : stopping PID $pid"
        }
        taskkill /PID $pid /T /F 2>&1 | Out-Null
        $stopped += $port
    }
}

if ($stopped.Count -eq 0) {
    Write-Host 'nothing to stop'
} else {
    Write-Host ("stopped: " + ($stopped -join ', '))
}
