<#
.SYNOPSIS
    Renders the made-up report data into pages, for screenshots and browser tests.
#>
param([Parameter(Mandatory)][string]$Out)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$null = New-Item -ItemType Directory -Force -Path $Out
Push-Location $root
try {
    cargo build -q -p diskly-core --example render_report
    if ($LASTEXITCODE -ne 0) { throw 'build failed' }
    foreach ($scenario in 'normal', 'first', 'walk-unknown', 'engines', 'hostile', 'empty', 'big') {
        $json = node scripts\demo\demo-data.js $scenario
        if ($LASTEXITCODE -ne 0) { throw "demo data failed for $scenario" }
        $file = Join-Path $Out "$scenario.json"
        [IO.File]::WriteAllText($file, ($json -join ''), (New-Object Text.UTF8Encoding($false)))
        & target\debug\examples\render_report.exe $file (Join-Path $Out "$scenario.html")
        if ($LASTEXITCODE -ne 0) { throw "render failed for $scenario" }
    }
} finally {
    Pop-Location
}
