<#
.SYNOPSIS
    Runs the DiskPulse scanner on the same volumes as bench.ps1, as a baseline.
    DiskPulse excludes $RECYCLE.BIN and System Volume Information and reparse
    points, and records aggregates two levels deep. Numbers only, no paths.

.PARAMETER ScannerSource
    Path to src\scanner\DiskPulseFastScanner.cs in a read-only DiskPulse checkout.
#>
param(
    [Parameter(Mandatory)][string]$ScannerSource,
    [Parameter(Mandatory)][string]$Out,
    [string[]]$Volumes = @('C:', 'D:'),
    [int]$Runs = 3
)
$ErrorActionPreference = 'Stop'
Add-Type -Path $ScannerSource
$outDir = Split-Path -Parent $Out
if ($outDir) { $null = New-Item -ItemType Directory -Force -Path $outDir }

for ($run = 1; $run -le $Runs; $run++) {
    foreach ($volume in $Volumes) {
        $watch = [Diagnostics.Stopwatch]::StartNew()
        $result = [DiskPulseFastScanner]::Scan($volume, "$volume\", $null)
        $watch.Stop()
        $top = @($result.records | Where-Object { $_.level -eq 1 })
        $bytes = ($top | Measure-Object -Property sizeBytes -Sum).Sum
        $files = ($top | Measure-Object -Property fileCount -Sum).Sum
        $denied = @($result.excluded | Where-Object { $_.reason -eq 'access-denied' }).Count
        $reparse = @($result.excluded | Where-Object { $_.reason -eq 'reparse-point' }).Count
        $configured = @($result.excluded | Where-Object { $_.reason -eq 'configured-exclusion' }).Count
        $row = [ordered]@{
            tool = 'diskpulse'; run = $run; volume = $volume; status = $result.status
            seconds = [Math]::Round($watch.Elapsed.TotalSeconds, 3)
            files = $files; bytes = $bytes
            access_denied = $denied; reparse_points = $reparse; configured_exclusions = $configured
            unavailable = @($result.unavailable).Count; errors = @($result.errors).Count
        }
        $line = $row | ConvertTo-Json -Compress
        [IO.File]::AppendAllText($Out, $line + "`n", (New-Object Text.UTF8Encoding($false)))
        Write-Output $line
    }
}
