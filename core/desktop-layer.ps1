# Haengt ein Fenster in die Hintergrund-Ebene von Windows (hinter die Desktop-Symbole, dorthin, wo auch Wallpaper
# Engine sein Bild zeigt). Laeuft dauerhaft und liest Befehle zeilenweise, antwortet mit einer Zeile:
#   behind <hwnd> <x> <y> <breite> <hoehe>   -> "ok <art>" oder "err <grund>"
# Nur ASCII in den Antworten (PowerShell 5.1 liest/schreibt sonst je nach System eine andere Codepage).
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class VVDesktopLayer {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr FindWindow(string cls, string name);
  [DllImport("user32.dll")] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string name);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr child, IntPtr parent);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

  static IntPtr IconHost() {
    IntPtr host = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (FindWindowEx(h, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero) { host = h; return false; }
      return true;
    }, IntPtr.Zero);
    return host;
  }

  public static string Behind(long hwnd, int x, int y, int w, int h) {
    SetThreadDpiAwarenessContext(new IntPtr(-4)); // echte Pixel, auch bei 125 % / 150 % Skalierung
    IntPtr progman = FindWindow("Progman", null);
    IntPtr r;
    SendMessageTimeout(progman, 0x052C, new IntPtr(0xD), new IntPtr(0x1), 0, 1000, out r);
    SendMessageTimeout(progman, 0x052C, IntPtr.Zero, IntPtr.Zero, 0, 1000, out r);
    IntPtr worker = FindWindowEx(progman, IntPtr.Zero, "WorkerW", null); // Windows 11 24H2 und neuer
    string kind = "24h2";
    if (worker == IntPtr.Zero) {
      IntPtr host = IconHost();
      worker = host == IntPtr.Zero ? IntPtr.Zero : FindWindowEx(IntPtr.Zero, host, "WorkerW", null);
      kind = "classic";
    }
    if (worker == IntPtr.Zero) return "err noworker";
    IntPtr me = new IntPtr(hwnd);
    SetParent(me, worker);
    // Die Ebene beginnt am Ursprung des gesamten Bildschirm-Bereichs (links davon liegende Bildschirme: negativ)
    SetWindowPos(me, IntPtr.Zero, x - GetSystemMetrics(76), y - GetSystemMetrics(77), w, h, 0x4 | 0x10 | 0x40);
    return "ok " + kind;
  }
}
'@

[Console]::Out.WriteLine('ready')
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $p = $line.Trim() -split '\s+'
  try {
    if ($p[0] -eq 'behind') { $out = [VVDesktopLayer]::Behind([long]$p[1], [int]$p[2], [int]$p[3], [int]$p[4], [int]$p[5]) }
    else { $out = 'err unknown' }
  } catch {
    $out = 'err exception'
  }
  [Console]::Out.WriteLine($out)
}
