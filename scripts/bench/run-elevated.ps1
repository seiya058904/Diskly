<#
.SYNOPSIS
    The part of the core acceptance that needs administrator rights, in one go:
    the MFT engine, and a directory walk under the same token to check it against.
    Read-only towards the scanned volumes; writes only into -OutDir.
#>
param(
    [Parameter(Mandatory)][string]$Exe,
    [Parameter(Mandatory)][string]$ProbeExe,
    [Parameter(Mandatory)][string]$OutDir,
    [string[]]$Volumes = @('C:\', 'D:\')
)
$ErrorActionPreference = 'Continue'
$null = New-Item -ItemType Directory -Force -Path $OutDir
$log = Join-Path $OutDir 'elevated.log'
$bench = Join-Path $PSScriptRoot 'bench.ps1'
function Log([string]$Text) { [IO.File]::AppendAllText($log, "$(Get-Date -Format HH:mm:ss) $Text`n") }

try {
    Log 'started'
    $snap = Join-Path $OutDir 'snapshots'
    & $bench -Exe $Exe -Out (Join-Path $OutDir 'mft-sequential.jsonl') -Volumes $Volumes -Runs 3 -Mode mft -SnapshotDir $snap | ForEach-Object { Log $_ }
    & $bench -Exe $Exe -Out (Join-Path $OutDir 'walk-elevated.jsonl') -Volumes $Volumes -Runs 3 -Mode walk -Threads 8 -SnapshotDir $snap | ForEach-Object { Log $_ }
    & $bench -Exe $Exe -Out (Join-Path $OutDir 'mft-parallel.jsonl') -Volumes $Volumes -Runs 3 -Mode mft -Parallel | ForEach-Object { Log $_ }

    # MFT against a walk under the same rights, as close together as possible.
    foreach ($volume in $Volumes) {
        $letter = $volume.Substring(0, 1)
        $a = Join-Path $OutDir "$letter-a-mft.dgs"
        $b = Join-Path $OutDir "$letter-b-walk.dgs"
        $json = Join-Path $OutDir "$letter-mft-vs-walk.json"
        & $Exe scan $volume --top 0 --json --mft --save $a | Out-Null
        & $Exe scan $volume --top 0 --json --threads 8 --save $b | Out-Null
        & $Exe diff $a $b --top 200 --json | Out-File -Encoding utf8 $json
        Log "diff $letter done"
    }
    # A cancelled scan and a raw probe of each engine.
    foreach ($volume in $Volumes) {
        foreach ($ms in 50, 300) {
            & $ProbeExe $volume --mft --cancel-ms $ms | Out-File -Append -Encoding utf8 (Join-Path $OutDir 'cancel.jsonl')
            & $ProbeExe $volume --threads 8 --cancel-ms $ms | Out-File -Append -Encoding utf8 (Join-Path $OutDir 'cancel.jsonl')
        }
        & $ProbeExe $volume --mft | Out-File -Append -Encoding utf8 (Join-Path $OutDir 'probe-mft.jsonl')
        & $ProbeExe $volume --threads 8 | Out-File -Append -Encoding utf8 (Join-Path $OutDir 'probe-walk-elevated.jsonl')
    }
    Log 'finished'
} catch {
    Log "FAILED: $_"
}
Set-Content -Path (Join-Path $OutDir 'done.flag') -Value 'done'
