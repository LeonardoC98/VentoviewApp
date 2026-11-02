# Hilfsprozess für den Bildschirm-Test: hängt Fenster in die Desktop-Ebene von Windows (wie Wallpaper Engine) bzw.
# legt sie direkt über den Desktop, unter alle anderen Fenster. Liest Befehle zeilenweise, antwortet mit einer Zeile:
#   behind <hwnd> <x> <y> <breite> <höhe>   → hinter die Desktop-Symbole (ersetzt das Hintergrundbild)
#   above <hwnd>                            → über Hintergrund und Symbole, unter allen Fenstern
#   info                                    → wie der Desktop gerade aufgebaut ist
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class VVDesk {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr FindWindow(string cls, string name);
  [DllImport("user32.dll")] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string name);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr child, IntPtr parent);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  const uint SWP_NOSIZE = 1, SWP_NOMOVE = 2, SWP_NOZORDER = 4, SWP_NOACTIVATE = 0x10, SWP_SHOWWINDOW = 0x40, SWP_NOOWNERZORDER = 0x200;
  const uint GW_HWNDPREV = 3;

  // Koordinaten in echten Pixeln (sonst rechnet Windows bei 125 %/150 % Skalierung um)
  static void Dpi() { SetThreadDpiAwarenessContext(new IntPtr(-4)); }

  static IntPtr Progman() { return FindWindow("Progman", null); }

  // Das Fenster mit den Desktop-Symbolen (SHELLDLL_DefView): Progman oder ein WorkerW
  static IntPtr IconHost() {
    IntPtr host = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (FindWindowEx(h, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero) { host = h; return false; }
      return true;
    }, IntPtr.Zero);
    return host;
  }

  public static string Info() {
    IntPtr progman = Progman();
    IntPtr host = IconHost();
    IntPtr child = FindWindowEx(progman, IntPtr.Zero, "WorkerW", null);
    return "Progman " + progman.ToInt64() + " · Symbole in " + (host == progman ? "Progman" : "WorkerW " + host.ToInt64())
      + " · WorkerW in Progman: " + (child == IntPtr.Zero ? "nein (klassisch)" : "ja (Windows 11 24H2+)");
  }

  // Hinter die Desktop-Symbole hängen – dorthin, wo auch Wallpaper Engine sein Bild zeigt
  public static string Behind(long hwnd, int x, int y, int w, int h) {
    Dpi();
    IntPtr progman = Progman();
    IntPtr r;
    // Bittet Windows, die Hintergrund-Ebene (WorkerW) anzulegen
    SendMessageTimeout(progman, 0x052C, new IntPtr(0xD), new IntPtr(0x1), 0, 1000, out r);
    SendMessageTimeout(progman, 0x052C, IntPtr.Zero, IntPtr.Zero, 0, 1000, out r);
    IntPtr worker = FindWindowEx(progman, IntPtr.Zero, "WorkerW", null); // Windows 11 24H2+
    string kind = "24H2";
    if (worker == IntPtr.Zero) {
      IntPtr host = IconHost();
      worker = host == IntPtr.Zero ? IntPtr.Zero : FindWindowEx(IntPtr.Zero, host, "WorkerW", null);
      kind = "klassisch";
    }
    if (worker == IntPtr.Zero) return "FEHLER: keine Hintergrund-Ebene (WorkerW) gefunden";
    IntPtr me = new IntPtr(hwnd);
    SetParent(me, worker);
    // Die Ebene liegt am Ursprung des gesamten Bildschirm-Bereichs (kann bei Bildschirmen links davon negativ sein)
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77);
    SetWindowPos(me, IntPtr.Zero, x - vx, y - vy, w, h, SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
    return "OK: hinter den Symbolen (" + kind + ", WorkerW " + worker.ToInt64() + ")";
  }

  // Direkt über die Desktop-Symbole, aber unter alle anderen Fenster
  public static string Above(long hwnd) {
    IntPtr host = IconHost();
    if (host == IntPtr.Zero) return "FEHLER: Desktop nicht gefunden";
    IntPtr me = new IntPtr(hwnd);
    IntPtr prev = GetWindow(host, GW_HWNDPREV); // das Fenster direkt über dem Desktop
    if (prev == me) return "OK: liegt schon über dem Desktop";
    if (prev == IntPtr.Zero) return "FEHLER: nichts über dem Desktop";
    // „prev“ als Vorgänger → unser Fenster kommt direkt darunter, also direkt über den Desktop
    SetWindowPos(me, prev, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
    return "OK: über dem Desktop, unter den Fenstern";
  }
}
'@

[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::Out.WriteLine('bereit')
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $p = $line.Trim() -split '\s+'
  try {
    switch ($p[0]) {
      'behind' { $out = [VVDesk]::Behind([long]$p[1], [int]$p[2], [int]$p[3], [int]$p[4], [int]$p[5]) }
      'above'  { $out = [VVDesk]::Above([long]$p[1]) }
      'info'   { $out = [VVDesk]::Info() }
      default  { $out = "FEHLER: unbekannter Befehl $($p[0])" }
    }
  } catch {
    $out = "FEHLER: $($_.Exception.Message)"
  }
  [Console]::Out.WriteLine($out)
}
