<#
.SYNOPSIS
    Lists the titles of all visible top-level windows that contain a text. A process
    only reports one main window, and a browser can have several.
#>
param([Parameter(Mandatory)][string]$Contains)
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class WindowTitles {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int size);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  public static List<string> All() {
    var titles = new List<string>();
    EnumWindows((hwnd, _) => {
      if (!IsWindowVisible(hwnd)) return true;
      var text = new StringBuilder(512);
      if (GetWindowText(hwnd, text, text.Capacity) > 0) titles.Add(text.ToString());
      return true;
    }, IntPtr.Zero);
    return titles;
  }
}
'@
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[WindowTitles]::All() | Where-Object { $_ -like "*$Contains*" }
