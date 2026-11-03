<#
.SYNOPSIS
    Measures the Diskghost core on real volumes. Read-only: it never touches
    scanned files. Records numbers only (no paths) so results can be published.

.EXAMPLE
    .\bench.ps1 -Exe ..\..\target\release\diskghost.exe -Out out.jsonl -Volumes C:\,D:\ -Runs 3
    .\bench.ps1 ... -Mode mft      # needs an elevated shell, otherwise it falls back and says so
#>
param(
    [Parameter(Mandatory)][string]$Exe,
    [Parameter(Mandatory)][string]$Out,
    [string[]]$Volumes = @('C:\', 'D:\'),
    [int]$Runs = 3,
    [ValidateSet('walk', 'mft')][string]$Mode = 'walk',
    [int[]]$Threads = @(0),
    [switch]$Parallel,
    [string]$SnapshotDir
)
$ErrorActionPreference = 'Stop'
$Exe = (Resolve-Path $Exe).Path
$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)

function Start-Scan {
    param([string]$Volume, [int]$ThreadCount, [string]$Save)
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $Exe
    # Volume roots stay unquoted: a quoted "C:\" would escape its closing quote.
    $arguments = "scan $Volume --top 0 --json"
    if ($Mode -eq 'mft') { $arguments += ' --mft' }
    if ($ThreadCount -gt 0) { $arguments += " --threads $ThreadCount" }
    if ($Save) { $arguments += " --save `"$Save`"" }
    $psi.Arguments = $arguments
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $process = [Diagnostics.Process]::Start($psi)
    [pscustomobject]@{
        Process = $process
        Stdout  = $process.StandardOutput.ReadToEndAsync()
        Stderr  = $process.StandardError.ReadToEndAsync()
        Watch   = [Diagnostics.Stopwatch]::StartNew()
        Volume  = $Volume
        Peak    = [int64]0
        Cpu     = [double]0
        Save    = $Save
        Threads = $ThreadCount
    }
}

function Wait-Scans {
    param([object[]]$Scans)
    while ($Scans | Where-Object { -not $_.Process.HasExited }) {
        foreach ($scan in $Scans) {
            if ($scan.Process.HasExited) {
                if ($scan.Watch.IsRunning) { $scan.Watch.Stop() }
                continue
            }
            try {
                $scan.Process.Refresh()
                $scan.Peak = [Math]::Max($scan.Peak, $scan.Process.PeakWorkingSet64)
                $scan.Cpu = $scan.Process.TotalProcessorTime.TotalSeconds
            } catch { }
        }
        Start-Sleep -Milliseconds 40
    }
    foreach ($scan in $Scans) { if ($scan.Watch.IsRunning) { $scan.Watch.Stop() } }
}

function Write-Result {
    param($Scan, [int]$Run, [string]$Group)
    $stdout = $Scan.Stdout.Result
    $stderr = $Scan.Stderr.Result
    $report = $null
    if ($stdout) { $report = $stdout | ConvertFrom-Json }
    $snapshotBytes = $null
    if ($Scan.Save -and (Test-Path -LiteralPath $Scan.Save)) { $snapshotBytes = (Get-Item -LiteralPath $Scan.Save).Length }
    $row = [ordered]@{
        group          = $Group
        run            = $Run
        volume         = $Scan.Volume
        requested_mode = $Mode
        engine         = if ($report) { $report.engine } else { $null }
        mft_fallback   = if ($report) { $report.mft_fallback } else { $null }
        elevated       = $elevated
        threads        = $Scan.Threads
        seconds        = [Math]::Round($Scan.Watch.Elapsed.TotalSeconds, 3)
        peak_mb        = [Math]::Round($Scan.Peak / 1MB, 1)
        cpu_seconds    = [Math]::Round($Scan.Cpu, 2)
        files          = if ($report) { $report.total_files } else { $null }
        dirs           = if ($report) { $report.total_dirs } else { $null }
        bytes          = if ($report) { $report.total_size } else { $null }
        skipped        = if ($report) { $report.skipped } else { $null }
        disk_total     = if ($report) { $report.disk_total } else { $null }
        disk_free      = if ($report) { $report.disk_free } else { $null }
        snapshot_bytes = $snapshotBytes
        exit_code      = $Scan.Process.ExitCode
        error          = if ($stderr) { $stderr.Trim() } else { $null }
    }
    $line = $row | ConvertTo-Json -Compress
    [IO.File]::AppendAllText($Out, $line + "`n", (New-Object Text.UTF8Encoding($false)))
    Write-Output $line
}

$outDir = Split-Path -Parent $Out
if ($outDir) { $null = New-Item -ItemType Directory -Force -Path $outDir }

foreach ($threadCount in $Threads) {
    for ($run = 1; $run -le $Runs; $run++) {
        if ($Parallel) {
            $scans = foreach ($volume in $Volumes) { Start-Scan -Volume $volume -ThreadCount $threadCount }
            $all = [Diagnostics.Stopwatch]::StartNew()
            Wait-Scans -Scans @($scans)
            $all.Stop()
            foreach ($scan in $scans) { Write-Result -Scan $scan -Run $run -Group 'parallel' }
            $summary = [ordered]@{ group = 'parallel-total'; run = $run; requested_mode = $Mode; elevated = $elevated; threads = $threadCount; seconds = [Math]::Round($all.Elapsed.TotalSeconds, 3) }
            $line = $summary | ConvertTo-Json -Compress
            [IO.File]::AppendAllText($Out, $line + "`n", (New-Object Text.UTF8Encoding($false)))
            Write-Output $line
        } else {
            foreach ($volume in $Volumes) {
                $save = $null
                if ($SnapshotDir) {
                    $null = New-Item -ItemType Directory -Force -Path $SnapshotDir
                    $save = Join-Path $SnapshotDir ("{0}-{1}-t{2}-r{3}.dgs" -f $volume.Substring(0, 1), $Mode, $threadCount, $run)
                }
                $scan = Start-Scan -Volume $volume -ThreadCount $threadCount -Save $save
                Wait-Scans -Scans @($scan)
                Write-Result -Scan $scan -Run $run -Group 'sequential'
            }
        }
    }
}
