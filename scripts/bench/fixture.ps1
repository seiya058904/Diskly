<#
.SYNOPSIS
    Builds a small tree with known sizes in a NEW folder under -Root and checks
    what the Diskghost core reports for it. Only ever writes inside that folder.
    The folder is left in place: delete it yourself once you have looked at it.
    Any deny rule it sets on its own folder is removed again before it exits.
#>
param(
    [Parameter(Mandatory)][string]$Exe,
    [Parameter(Mandatory)][string]$Root
)
$ErrorActionPreference = 'Stop'
$Exe = (Resolve-Path $Exe).Path
$base = Join-Path $Root ("diskly-fixture-{0:yyyyMMdd-HHmmss}" -f (Get-Date))
$tree = Join-Path $base 'tree'
$null = New-Item -ItemType Directory -Force -Path $tree

function Write-Bytes([string]$Path, [int64]$Count) {
    $stream = [IO.File]::Create($Path)
    try {
        $block = New-Object byte[] 65536
        (New-Object Random 7).NextBytes($block) # incompressible, so compression is visible only where asked for
        $left = $Count
        while ($left -gt 0) {
            $n = [Math]::Min($left, 65536)
            $stream.Write($block, 0, [int]$n)
            $left -= $n
        }
    } finally { $stream.Dispose() }
}
function Invoke-Diskghost([string[]]$Arguments) {
    $output = & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "diskghost $Arguments failed with exit code $LASTEXITCODE" }
    ($output -join "`n") | ConvertFrom-Json
}
function Check([string]$Name, $Actual, $Expected) {
    $ok = "$Actual" -eq "$Expected"
    [pscustomobject]@{ check = $Name; ok = $ok; actual = "$Actual"; expected = "$Expected" }
}

$results = New-Object Collections.ArrayList

# --- Known sizes -------------------------------------------------------------
$plain = Join-Path $tree 'plain'; $null = New-Item -ItemType Directory $plain
Write-Bytes (Join-Path $plain 'a.bin') 1000000
Write-Bytes (Join-Path $plain 'b.bin') 250000
$chinese = Join-Path $tree '中文目录'; $null = New-Item -ItemType Directory $chinese
Write-Bytes (Join-Path $chinese '报告 2026.bin') 300000

# Hard link: one file on disk, two names.
$links = Join-Path $tree 'links'; $null = New-Item -ItemType Directory $links
Write-Bytes (Join-Path $links 'original.bin') 500000
$null = New-Item -ItemType HardLink -Path (Join-Path $links 'second-name.bin') -Target (Join-Path $links 'original.bin')

# Junction pointing back at the tree: must not be followed or counted.
$null = New-Item -ItemType Junction -Path (Join-Path $tree 'junction-to-plain') -Target $plain

# Sparse: large logical size, nothing allocated.
$sparseDir = Join-Path $tree 'sparse'; $null = New-Item -ItemType Directory $sparseDir
$sparse = Join-Path $sparseDir 'hole.bin'
$null = New-Item -ItemType File -Path $sparse
& fsutil sparse setflag $sparse | Out-Null
& fsutil file seteof $sparse 10000000 | Out-Null
& fsutil sparse setrange $sparse 0 10000000 | Out-Null

# NTFS compression of compressible data.
$compressedDir = Join-Path $tree 'compressed'; $null = New-Item -ItemType Directory $compressedDir
$compressed = Join-Path $compressedDir 'zeros.bin'
[IO.File]::WriteAllBytes($compressed, (New-Object byte[] 2000000))
& compact /c /q $compressed | Out-Null

# A path longer than MAX_PATH.
$long = '\\?\' + $tree + '\long'
$null = [IO.Directory]::CreateDirectory($long)
for ($i = 0; $i -lt 8; $i++) {
    $long += '\' + ('d' * 40)
    $null = [IO.Directory]::CreateDirectory($long)
}
Write-Bytes ($long + '\deep.bin') 70000

# --- Scan and compare with what was written ----------------------------------
$expectedFiles = 8 # a, b, 报告, original, second-name, hole, zeros, deep
$snapshotA = Join-Path $base 'a.dgs'
$report = Invoke-Diskghost @('scan', $tree, '--top', '50', '--json', '--save', $snapshotA)
[void]$results.Add((Check 'files counted (hard link counts once per name)' $report.total_files $expectedFiles))
$bySubfolder = @{}
foreach ($child in $report.children) { $bySubfolder[(Split-Path -Leaf $child.path)] = $child }
[void]$results.Add((Check 'plain folder is the sum of its files' $bySubfolder['plain'].size 1250000))
[void]$results.Add((Check 'Chinese names survive' $bySubfolder['中文目录'].size 300000))
[void]$results.Add((Check 'hard link is counted once per name' $bySubfolder['links'].size 1000000))
[void]$results.Add((Check 'junction is not followed' $bySubfolder.ContainsKey('junction-to-plain') $false))
[void]$results.Add((Check 'sparse file counts allocated size, not 10 MB' ($bySubfolder['sparse'].size -lt 100000) $true))
[void]$results.Add((Check 'compressed file counts on-disk size, not 2 MB' ($bySubfolder['compressed'].size -lt 2000000) $true))
[void]$results.Add((Check 'path beyond MAX_PATH is read' $bySubfolder['long'].size 70000))
[void]$results.Add((Check 'nothing was skipped so far' $report.skipped 0))

# --- Real change: grows and shrinks ------------------------------------------
Write-Bytes (Join-Path $plain 'new.bin') 400000
Remove-Item -LiteralPath (Join-Path $plain 'b.bin')
$snapshotB = Join-Path $base 'b.dgs'
$null = Invoke-Diskghost @('scan', $tree, '--top', '50', '--json', '--save', $snapshotB)
$diff = Invoke-Diskghost @('diff', $snapshotA, $snapshotB, '--top', '50', '--json')
[void]$results.Add((Check 'real growth is the exact delta' $diff.delta 150000))
[void]$results.Add((Check 'new file is listed' $diff.new_files_count 1))
[void]$results.Add((Check 'gone file is listed' $diff.removed_files_count 1))

# --- The defect: an unreadable folder must not look emptied ------------------
$denied = Join-Path $tree '中文目录'
$account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$snapshotC = Join-Path $base 'c.dgs'
& icacls $denied /deny "${account}:(OI)(CI)(RX)" | Out-Null
try {
    $withDeny = Invoke-Diskghost @('scan', $tree, '--top', '50', '--json', '--save', $snapshotC)
} finally {
    & icacls $denied /remove:d $account | Out-Null
}
$diffDeny = Invoke-Diskghost @('diff', $snapshotB, $snapshotC, '--top', '50', '--json')
$deniedChild = $withDeny.children | Where-Object { (Split-Path -Leaf $_.path) -eq '中文目录' }
$shrunk = @($diffDeny.shrunk | Where-Object { (Split-Path -Leaf $_.path) -eq '中文目录' })

[void]$results.Add((Check 'DEFECT unreadable folder raises skipped' $withDeny.skipped 1))
[void]$results.Add((Check 'DEFECT unreadable folder is reported as complete (want: false)' ($null -eq $deniedChild.complete -or $deniedChild.complete) $false))
[void]$results.Add((Check 'DEFECT unreadable folder is reported as shrunk (want: 0 rows)' $shrunk.Count 0))
[void]$results.Add((Check 'DEFECT whole-tree delta claims space was freed (want: 0)' $diffDeny.delta 0))
[void]$results.Add((Check 'DEFECT its file is reported as removed (want: 0)' $diffDeny.removed_files_count 0))

$results | Format-Table -AutoSize -Wrap
Write-Output "fixture left at: $base"
