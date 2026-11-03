<#
.SYNOPSIS
    Builds the Windows downloads into dist\: the installer, a portable executable
    and their SHA-256 checksums. Needs Rust and Node; the Tauri CLI comes from npm
    for this run and is not added to the project.
#>
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$config = Get-Content -Encoding UTF8 -Raw (Join-Path $root 'app\src-tauri\tauri.conf.json') | ConvertFrom-Json
$version = $config.version
$dist = Join-Path $root 'dist'
$null = New-Item -ItemType Directory -Force -Path $dist

Push-Location (Join-Path $root 'app\src-tauri')
try {
    # The CLI writes its progress to stderr, which is not an error: the exit code says.
    $ErrorActionPreference = 'Continue'
    npx --yes '@tauri-apps/cli@2' build --bundles nsis
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($code -ne 0) { throw "the build failed with exit code $code" }
} finally {
    Pop-Location
}

$setup = Join-Path $root "target\release\bundle\nsis\Diskly_${version}_x64-setup.exe"
$portable = Join-Path $root 'target\release\diskly.exe'
Copy-Item -LiteralPath $setup -Destination (Join-Path $dist "Diskly-$version-setup.exe") -Force
Copy-Item -LiteralPath $portable -Destination (Join-Path $dist "Diskly-$version-portable.exe") -Force

$sums = foreach ($name in "Diskly-$version-setup.exe", "Diskly-$version-portable.exe") {
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $dist $name)).Hash.ToLowerInvariant()
    "$hash  $name"
}
[IO.File]::WriteAllLines((Join-Path $dist 'SHA256SUMS.txt'), [string[]]$sums)

Get-ChildItem -LiteralPath $dist -File | Select-Object Name, @{ n = 'MB'; e = { [Math]::Round($_.Length / 1MB, 2) } } | Format-Table -AutoSize
$sums
