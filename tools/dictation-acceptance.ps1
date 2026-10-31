#requires -Version 7
# Installed Windows package measurements. Explicit, offline, no microphone.
# Build the release dictation_benchmark example first; see docs/dictation-acceptance/issue-235.md.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $InstallDir,
    [Parameter(Mandatory)][string] $ModelHome,
    [Parameter(Mandatory)][ValidateSet('cpu', 'vulkan', 'cuda')][string] $Backend,
    [ValidateSet('tiny', 'base', 'small', 'medium', 'large-v3', 'large-v3-turbo')]
    [string[]] $Models = @('small'),
    [string] $AdapterId = '-',
    [string] $BenchmarkExe = "$PSScriptRoot/../target/release/examples/dictation_benchmark.exe",
    [Parameter(Mandatory)][string] $OutputDir
)
$ErrorActionPreference = 'Stop'
$installedHost = Join-Path (Resolve-Path -LiteralPath $InstallDir) 'oxide-app.exe'
$installedWorker = if ($Backend -eq 'cpu') { $installedHost } else { Join-Path $InstallDir "oxide-$Backend-worker.exe" }
$installedWorker = (Resolve-Path -LiteralPath $installedWorker).Path
$benchmark = (Resolve-Path -LiteralPath $BenchmarkExe).Path
$modelRoot = (Resolve-Path -LiteralPath $ModelHome).Path
if ($Backend -ne 'cpu' -and $AdapterId -eq '-') { throw 'Select the exact stable adapter ID from runtime discovery.' }
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

foreach ($model in $Models) {
    $reportPath = Join-Path $OutputDir "$Backend-$model.json"
    if (Test-Path -LiteralPath $reportPath) { throw "Report already exists for $Backend/$model; choose a fresh output folder." }
    $start = [System.Diagnostics.ProcessStartInfo]::new($benchmark)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    # Match an end-user environment; do not let development overrides choose another worker.
    foreach ($key in @($start.Environment.Keys)) {
        if ($key -match '^(path$|cuda_|vulkan_sdk$|vk_|ggml_|oxide_(cuda|vulkan)_worker$)') {
            $start.Environment.Remove($key) | Out-Null
        }
    }
    $start.Environment['PATH'] = "$env:SystemRoot\System32;$env:SystemRoot;$env:SystemRoot\System32\Wbem"
    foreach ($argument in @($modelRoot, $Backend, $installedWorker, $AdapterId, $model, $installedHost)) {
        $start.ArgumentList.Add($argument)
    }
    $child = [System.Diagnostics.Process]::Start($start)
    try {
        $stdout = $child.StandardOutput.ReadToEndAsync()
        # Consume but never persist raw errors: a failed native dependency could print user paths.
        $stderr = $child.StandardError.ReadToEndAsync()
        $workingSet = $null
        $privateCommit = $null
        $dedicated = $null
        $shared = $null
        $samples = 0
        $gpuSamples = 0
        $clock = [System.Diagnostics.Stopwatch]::StartNew()
        $previousMs = 0
        $maxGapMs = 0
        while (-not $child.HasExited) {
            $elapsed = $clock.ElapsedMilliseconds
            $maxGapMs = [Math]::Max($maxGapMs, $elapsed - $previousMs)
            $previousMs = $elapsed
            # Only the child of this diagnostic, never another running Oxide instance.
            $workers = Get-CimInstance Win32_Process -Filter "ParentProcessId = $($child.Id)" |
                Where-Object ExecutablePath -EQ $installedWorker
            foreach ($worker in $workers) {
                $process = Get-Process -Id $worker.ProcessId -ErrorAction SilentlyContinue
                if ($null -eq $process) { continue }
                $process.Refresh()
                $workingSet = [Math]::Max([long]$workingSet, $process.PeakWorkingSet64)
                $privateCommit = [Math]::Max([long]$privateCommit, $process.PeakPagedMemorySize64)
                $samples++
                if ($Backend -ne 'cpu') {
                    # These raw counters are byte gauges, not rates; no two-sample calculation.
                    $memory = @(Get-CimInstance Win32_PerfRawData_GPUPerformanceCounters_GPUProcessMemory -ErrorAction SilentlyContinue |
                        Where-Object Name -Like "pid_$($worker.ProcessId)_*")
                    if ($memory.Count -gt 0) {
                        $dedicated = [Math]::Max([long]$dedicated, ($memory | Measure-Object DedicatedUsage -Sum).Sum)
                        $shared = [Math]::Max([long]$shared, ($memory | Measure-Object SharedUsage -Sum).Sum)
                        $gpuSamples++
                    }
                }
            }
            Start-Sleep -Milliseconds 100
        }
        $child.WaitForExit()
        $diagnosticOutput = $stdout.GetAwaiter().GetResult()
        $diagnosticError = $stderr.GetAwaiter().GetResult()
        $result = $null
        $failure = $null
        if ($child.ExitCode -ne 0) {
            # Export only a fixed category, never the native text or panic context.
            $failure = if ($diagnosticError.Contains('Performance check timed out.')) { 'timeout' } else { 'worker-or-resource-failure' }
        }
        else {
            $results = @($diagnosticOutput | ConvertFrom-Json)
            if ($results.Count -ne 1 -or $results[0].model -ne $model -or $results[0].execution.backend -ne $Backend) {
                throw 'Unexpected performance result; no report published.'
            }
            $result = $results[0]
        }
        $report = [ordered]@{
            schema = 1
            requestedBackend = $Backend
            requestedModel = $model
            failure = $failure
            elapsedMs = $clock.ElapsedMilliseconds
            executableSha256 = (Get-FileHash -LiteralPath $installedWorker -Algorithm SHA256).Hash.ToLowerInvariant()
            hostSha256 = (Get-FileHash -LiteralPath $installedHost -Algorithm SHA256).Hash.ToLowerInvariant()
            result = $result
            memory = [ordered]@{
                method = 'Windows process high-water marks + sampled GPU Process Memory byte gauges; lower bounds, not calibration'
                requestedIntervalMs = 100
                maxObservedGapMs = $maxGapMs
                processSamples = $samples
                gpuSamples = $gpuSamples
                peakWorkingSetBytes = $workingSet
                peakPrivateCommitBytes = $privateCommit
                sampledDedicatedBytes = $dedicated
                sampledSharedBytes = $shared
            }
        }
        $report | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $reportPath -Encoding utf8
        if ($null -ne $failure) { throw "Recorded failed $Backend/$model check: $failure (exit $($child.ExitCode)). No measurement was accepted." }
        Write-Output "Recorded $Backend/$model (process samples: $samples; GPU samples: $gpuSamples)."
    }
    finally {
        if (-not $child.HasExited) {
            $child.Kill($true)
            $child.WaitForExit()
        }
        $child.Dispose()
    }
}
