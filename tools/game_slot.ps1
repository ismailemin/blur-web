# Local launch adapter: same named game queue as upstream, with explicit window style.
param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [string]$WorkingDirectory = (Split-Path -Parent $Exe),
    [int]$TimeoutSeconds = 0
)
$ErrorActionPreference = 'Stop'
$blurSlot = [System.Threading.Mutex]::new($false, 'Global\Blur2PC.GameSlot')
try { [void]$blurSlot.WaitOne() } catch [System.Threading.AbandonedMutexException] { }
try {
    foreach ($blurExisting in @(Get-Process Amax, Blur, BlurRebuilt -ErrorAction SilentlyContinue)) {
        $blurExisting.WaitForExit()
    }
    $blurStarted = Start-Process -FilePath $Exe -WorkingDirectory $WorkingDirectory -WindowStyle Minimized -PassThru
    Write-Output "Started Rebuilt PID $($blurStarted.Id)"
    $blurTimedOut = $false
    if ($TimeoutSeconds -gt 0) { $blurTimedOut = -not $blurStarted.WaitForExit($TimeoutSeconds * 1000) }
    else { $blurStarted.WaitForExit() }
    if ($blurTimedOut) { Stop-Process -Id $blurStarted.Id; $blurStarted.WaitForExit() }
    [pscustomobject]@{ ProcessId = $blurStarted.Id; ExitCode = $blurStarted.ExitCode; TimedOut = $blurTimedOut }
}
finally { $blurSlot.ReleaseMutex(); $blurSlot.Dispose() }
