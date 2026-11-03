<#
.SYNOPSIS
    Saves a picture of a real window as it is on screen, frosted background and all,
    which the DevTools protocol cannot see.
#>
param(
    [Parameter(Mandatory)][string]$Title,
    [Parameter(Mandatory)][string]$Out
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CaptureWindow {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT rect, int size);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[void][CaptureWindow]::SetProcessDPIAware()
$hwnd = [CaptureWindow]::FindWindow([NullString]::Value, $Title)
if ($hwnd -eq [IntPtr]::Zero) { throw "no window titled '$Title'" }
[void][CaptureWindow]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 350
$rect = New-Object CaptureWindow+RECT
# DWMWA_EXTENDED_FRAME_BOUNDS: the visible window, without its invisible resize border.
[void][CaptureWindow]::DwmGetWindowAttribute($hwnd, 9, [ref]$rect, 16)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
$bitmap = New-Object Drawing.Bitmap $width, $height
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object Drawing.Size $width, $height))
$graphics.Dispose()
$null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Out)
$bitmap.Save($Out, [Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
Write-Output "$width x $height"
