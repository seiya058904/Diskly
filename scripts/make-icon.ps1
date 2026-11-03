<#
.SYNOPSIS
    Draws Diskly's app icon: a capacity ring on a blue tile, with the part that
    grew since last time in orange. Writes a 1024 px PNG for `tauri icon`.
#>
param([Parameter(Mandatory)][string]$Out)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$size = 1024
$bitmap = New-Object Drawing.Bitmap $size, $size, ([Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [Drawing.Graphics]::FromImage($bitmap)
$g.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.Clear([Drawing.Color]::Transparent)

# The tile: a rounded square, as app icons are on Apple's and Microsoft's systems.
$inset = 56
$side = $size - 2 * $inset
$radius = 230
$tile = New-Object Drawing.Drawing2D.GraphicsPath
$d = 2 * $radius
$tile.AddArc($inset, $inset, $d, $d, 180, 90)
$tile.AddArc($inset + $side - $d, $inset, $d, $d, 270, 90)
$tile.AddArc($inset + $side - $d, $inset + $side - $d, $d, $d, 0, 90)
$tile.AddArc($inset, $inset + $side - $d, $d, $d, 90, 90)
$tile.CloseFigure()
$fill = New-Object Drawing.Drawing2D.LinearGradientBrush(
    (New-Object Drawing.Point 0, $inset),
    (New-Object Drawing.Point 0, ($inset + $side)),
    [Drawing.Color]::FromArgb(255, 52, 132, 250),
    [Drawing.Color]::FromArgb(255, 10, 84, 214))
$g.FillPath($fill, $tile)

# The ring.
$ringInset = 262
$ringSide = $size - 2 * $ringInset
$rect = New-Object Drawing.Rectangle $ringInset, $ringInset, $ringSide, $ringSide
$width = 118
$track = New-Object Drawing.Pen ([Drawing.Color]::FromArgb(70, 255, 255, 255)), $width
$g.DrawEllipse($track, $rect)
$used = New-Object Drawing.Pen ([Drawing.Color]::FromArgb(255, 255, 255, 255)), $width
$used.StartCap = [Drawing.Drawing2D.LineCap]::Round
$used.EndCap = [Drawing.Drawing2D.LineCap]::Round
$g.DrawArc($used, $rect, 112, 208)
$grew = New-Object Drawing.Pen ([Drawing.Color]::FromArgb(255, 255, 159, 67)), $width
$grew.StartCap = [Drawing.Drawing2D.LineCap]::Round
$grew.EndCap = [Drawing.Drawing2D.LineCap]::Round
$g.DrawArc($grew, $rect, -40, 72)

$g.Dispose()
$bitmap.Save($Out, [Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
