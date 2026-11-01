# Live-Audio für Overlays: nimmt den Ton des ganzen PCs (Mode sys), eines einzelnen Programms (Mode app, Name =
# Prozessname, z. B. spotify – Process Loopback ab Windows 10 2004) oder eines Eingangs wie dem Mikrofon (Mode mic,
# Name = Geräte-ID oder default) auf und schreibt ihn roh auf stdout: 48 kHz, Stereo, 16 Bit, little endian – ohne Kopf,
# Paket für Paket, so wie Windows ihn liefert (im Takt des Geräts, ohne Umweg über den Browser).
# Mode list gibt stattdessen die Programme, die gerade Ton ausgeben können, als JSON aus: [{"name":"spotify","title":"Spotify"}],
# Mode inputs die Eingänge: [{"id":"{0.0.1.…}","name":"Mikrofon (…)"}]
param([string]$Mode = 'list', [string]$Name = '')

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class VvEnumeratorCom {}

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IVvDeviceEnumerator {
  [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IVvDeviceCollection devices);
  [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IVvDevice device);
  [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IVvDevice device);
}

[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IVvDeviceCollection {
  [PreserveSig] int GetCount(out uint count);
  [PreserveSig] int Item(uint index, out IVvDevice device);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IVvDevice {
  [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object result);
  [PreserveSig] int OpenPropertyStore(int access, out IVvPropertyStore store);
  [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  [PreserveSig] int GetState(out int state);
}

[StructLayout(LayoutKind.Sequential)]
struct VvPropertyKey { public Guid fmtid; public int pid; }

[StructLayout(LayoutKind.Sequential)]
struct VvPropVariant { public ushort vt; public ushort r1; public ushort r2; public ushort r3; public IntPtr p; public IntPtr p2; }

[ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IVvPropertyStore {
  [PreserveSig] int GetCount(out uint count);
  [PreserveSig] int GetAt(uint index, out VvPropertyKey key);
  [PreserveSig] int GetValue(ref VvPropertyKey key, out VvPropVariant value);
}

[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IVvSessionManager2 {
  [PreserveSig] int GetAudioSessionControl(IntPtr groupingParam, int flags, out IntPtr control);
  [PreserveSig] int GetSimpleAudioVolume(IntPtr groupingParam, int flags, out IntPtr volume);
  [PreserveSig] int GetSessionEnumerator(out IVvSessionEnumerator sessions);
}

[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IVvSessionEnumerator {
  [PreserveSig] int GetCount(out int count);
  [PreserveSig] int GetSession(int index, out IVvSessionControl2 session);
}

[ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IVvSessionControl2 {
  [PreserveSig] int GetState(out int state);
  [PreserveSig] int GetDisplayName(out IntPtr name);
  [PreserveSig] int SetDisplayName(IntPtr name, IntPtr eventContext);
  [PreserveSig] int GetIconPath(out IntPtr path);
  [PreserveSig] int SetIconPath(IntPtr path, IntPtr eventContext);
  [PreserveSig] int GetGroupingParam(out Guid groupingParam);
  [PreserveSig] int SetGroupingParam(ref Guid groupingParam, IntPtr eventContext);
  [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
  [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
  [PreserveSig] int GetSessionIdentifier(out IntPtr id);
  [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr id);
  [PreserveSig] int GetProcessId(out uint pid);
}

[ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IVvAudioClient {
  [PreserveSig] int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
  [PreserveSig] int GetBufferSize(out uint frames);
  [PreserveSig] int GetStreamLatency(out long latency);
  [PreserveSig] int GetCurrentPadding(out uint frames);
  [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch);
  [PreserveSig] int GetMixFormat(out IntPtr format);
  [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
  [PreserveSig] int Start();
  [PreserveSig] int Stop();
  [PreserveSig] int Reset();
  [PreserveSig] int SetEventHandle(IntPtr handle);
  [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
}

[ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IVvCaptureClient {
  [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
  [PreserveSig] int ReleaseBuffer(uint frames);
  [PreserveSig] int GetNextPacketSize(out uint frames);
}

[ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IVvActivateOperation {
  void GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
}

[ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IVvActivateHandler {
  void ActivateCompleted(IVvActivateOperation operation);
}

// Markiert den Rückruf als threadunabhängig – sonst lehnt Windows ihn ab
[ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IVvAgileObject {}

[ComVisible(true)]
public class VvActivation : IVvActivateHandler, IVvAgileObject {
  public readonly ManualResetEvent Done = new ManualResetEvent(false);
  public int Result = -1;
  public object Client;
  public void ActivateCompleted(IVvActivateOperation operation) {
    try { operation.GetActivateResult(out Result, out Client); } catch (Exception e) { Result = Marshal.GetHRForException(e); }
    Done.Set();
  }
}

[StructLayout(LayoutKind.Sequential)]
struct VvLoopbackParams { public int ActivationType; public int TargetProcessId; public int Mode; }

[StructLayout(LayoutKind.Sequential)]
struct VvBlobPropVariant { public ushort vt; public ushort r1; public ushort r2; public ushort r3; public uint size; public IntPtr data; }

[StructLayout(LayoutKind.Sequential, Pack = 2)]
struct VvWaveFormat { public ushort tag; public ushort channels; public uint rate; public uint bytesPerSecond; public ushort blockAlign; public ushort bits; public ushort extra; }

public static class VvCapture {
  [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
  static extern void ActivateAudioInterfaceAsync([MarshalAs(UnmanagedType.LPWStr)] string path, [MarshalAs(UnmanagedType.LPStruct)] Guid iid,
    IntPtr activationParams, IVvActivateHandler handler, out IVvActivateOperation operation);

  const int Rate = 48000;

  static IVvDevice DefaultRender() {
    var enumerator = (IVvDeviceEnumerator)new VvEnumeratorCom();
    IVvDevice device;
    if (enumerator.GetDefaultAudioEndpoint(0, 1, out device) != 0 || device == null) throw new Exception("kein Wiedergabegerät");
    return device;
  }

  // Programme mit einer Audio-Sitzung auf dem Standard-Wiedergabegerät: Prozessname → PID
  static List<KeyValuePair<string, int>> Sessions() {
    var list = new List<KeyValuePair<string, int>>();
    var device = DefaultRender();
    var iid = typeof(IVvSessionManager2).GUID;
    object managerObject;
    if (device.Activate(ref iid, 23, IntPtr.Zero, out managerObject) != 0) return list;
    IVvSessionEnumerator sessions;
    if (((IVvSessionManager2)managerObject).GetSessionEnumerator(out sessions) != 0) return list;
    int count;
    sessions.GetCount(out count);
    for (int i = 0; i < count; i++) {
      IVvSessionControl2 control;
      if (sessions.GetSession(i, out control) != 0 || control == null) continue;
      uint pid;
      control.GetProcessId(out pid);
      if (pid == 0) continue; // Systemklänge
      try { list.Add(new KeyValuePair<string, int>(Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant(), (int)pid)); } catch {}
    }
    return list;
  }

  static string Json(string text) {
    var sb = new StringBuilder();
    foreach (char c in text) {
      if (c == '"' || c == '\\') sb.Append('\\').Append(c);
      else if (c < 32) sb.Append(' ');
      else sb.Append(c);
    }
    return sb.ToString();
  }

  // Eingänge (Mikrofone, Line-In, virtuelle Kabel) mit ihrem Namen aus Windows
  public static void Inputs() {
    var parts = new List<string>();
    var enumerator = (IVvDeviceEnumerator)new VvEnumeratorCom();
    IVvDeviceCollection devices;
    if (enumerator.EnumAudioEndpoints(1, 1, out devices) == 0 && devices != null) { // Aufnahme, nur aktive
      uint count;
      devices.GetCount(out count);
      var nameKey = new VvPropertyKey { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
      for (uint i = 0; i < count; i++) {
        IVvDevice device;
        if (devices.Item(i, out device) != 0 || device == null) continue;
        string id;
        if (device.GetId(out id) != 0 || id == null) continue;
        string name = id;
        IVvPropertyStore store;
        if (device.OpenPropertyStore(0, out store) == 0 && store != null) {
          VvPropVariant value;
          if (store.GetValue(ref nameKey, out value) == 0 && value.vt == 31 && value.p != IntPtr.Zero) name = Marshal.PtrToStringUni(value.p);
        }
        parts.Add("{\"id\":\"" + Json(id) + "\",\"name\":\"" + Json(name) + "\"}");
      }
    }
    var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    stdout.Write("[" + String.Join(",", parts) + "]");
    stdout.Flush();
  }

  static IVvAudioClient InputClient(string id) {
    var enumerator = (IVvDeviceEnumerator)new VvEnumeratorCom();
    IVvDevice device;
    int hr = id == "default" ? enumerator.GetDefaultAudioEndpoint(1, 0, out device) : enumerator.GetDevice(id, out device);
    if (hr != 0 || device == null) throw new Exception("Eingang nicht gefunden");
    var iid = typeof(IVvAudioClient).GUID;
    object client;
    hr = device.Activate(ref iid, 23, IntPtr.Zero, out client);
    if (hr != 0) throw new Exception("Activate 0x" + hr.ToString("X8"));
    return (IVvAudioClient)client;
  }

  public static void List() {
    var seen = new HashSet<string>();
    var parts = new List<string>();
    foreach (var s in Sessions()) {
      if (!seen.Add(s.Key) || s.Key == "ventoview" || s.Key == "electron" || s.Key == "powershell") continue;
      string title = null;
      try { title = Process.GetProcessById(s.Value).MainModule.FileVersionInfo.FileDescription; } catch {}
      if (String.IsNullOrWhiteSpace(title)) title = s.Key.Substring(0, 1).ToUpperInvariant() + s.Key.Substring(1);
      parts.Add("{\"name\":\"" + Json(s.Key) + "\",\"title\":\"" + Json(title.Trim()) + "\"}");
    }
    var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    stdout.Write("[" + String.Join(",", parts) + "]");
    stdout.Flush();
  }

  // Bevorzugt den Prozess, der gerade eine Audio-Sitzung hat (bei Browsern der Audio-Dienst), sonst irgendeinen
  static int FindPid(string name) {
    foreach (var s in Sessions()) if (s.Key == name) return s.Value;
    var all = Process.GetProcessesByName(name);
    return all.Length > 0 ? all[0].Id : 0;
  }

  static IVvAudioClient ProcessClient(int pid) {
    IntPtr blob = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(VvLoopbackParams)));
    IntPtr variant = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(VvBlobPropVariant)));
    try {
      Marshal.StructureToPtr(new VvLoopbackParams { ActivationType = 1, TargetProcessId = pid, Mode = 0 }, blob, false); // inkl. Unterprozesse
      Marshal.StructureToPtr(new VvBlobPropVariant { vt = 65, size = (uint)Marshal.SizeOf(typeof(VvLoopbackParams)), data = blob }, variant, false); // VT_BLOB
      var handler = new VvActivation();
      IVvActivateOperation operation;
      ActivateAudioInterfaceAsync("VAD\\Process_Loopback", typeof(IVvAudioClient).GUID, variant, handler, out operation);
      if (!handler.Done.WaitOne(5000)) throw new Exception("keine Antwort von Windows");
      if (handler.Result != 0 || handler.Client == null) throw new Exception("Fehler 0x" + handler.Result.ToString("X8"));
      return (IVvAudioClient)handler.Client;
    } finally {
      Marshal.FreeHGlobal(variant);
      Marshal.FreeHGlobal(blob);
    }
  }

  static IVvAudioClient SystemClient() {
    var iid = typeof(IVvAudioClient).GUID;
    object client;
    int hr = DefaultRender().Activate(ref iid, 23, IntPtr.Zero, out client);
    if (hr != 0) throw new Exception("Activate 0x" + hr.ToString("X8"));
    return (IVvAudioClient)client;
  }

  public static int Run(string mode, string name) {
    int code = 0;
    var thread = new Thread(() => { code = Capture(mode, name); });
    thread.SetApartmentState(ApartmentState.MTA);
    thread.Start();
    thread.Join();
    return code;
  }

  static int Capture(string mode, string name) {
    IntPtr format = IntPtr.Zero;
    IVvAudioClient client = null;
    Process target = null;
    try {
      bool evented = mode != "sys"; // Process Loopback und Eingänge mit Ereignissen, der System-Loopback wird abgefragt
      if (mode == "sys") client = SystemClient();
      else if (mode == "mic") client = InputClient(name);
      else {
        int pid = FindPid(name.ToLowerInvariant());
        if (pid <= 0) { Console.Error.WriteLine("Programm läuft nicht: " + name); return 3; }
        target = Process.GetProcessById(pid);
        client = ProcessClient(pid);
      }
      // 16 Bit Stereo, 48 kHz – Windows rechnet selbst um
      format = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(VvWaveFormat)));
      Marshal.StructureToPtr(new VvWaveFormat { tag = 1, channels = 2, rate = Rate, bytesPerSecond = Rate * 4, blockAlign = 4, bits = 16, extra = 0 }, format, false);
      uint flags = 0x80000000u | 0x08000000u; // Umrechnen (Rate, Kanäle), gute Qualität
      if (mode != "mic") flags |= 0x00020000u; // Loopback
      if (evented) flags |= 0x00040000u;
      int hr = client.Initialize(0, flags, mode == "mic" ? 100000 : 200000, 0, format, IntPtr.Zero); // 10 ms (Eingang) bzw. 20 ms Puffer
      if (hr != 0) throw new Exception("Initialize 0x" + hr.ToString("X8"));
      AutoResetEvent ready = null;
      if (evented) {
        ready = new AutoResetEvent(false);
        client.SetEventHandle(ready.SafeWaitHandle.DangerousGetHandle());
      }
      var captureIid = typeof(IVvCaptureClient).GUID;
      object service;
      hr = client.GetService(ref captureIid, out service);
      if (hr != 0) throw new Exception("GetService 0x" + hr.ToString("X8"));
      var capture = (IVvCaptureClient)service;
      hr = client.Start();
      if (hr != 0) throw new Exception("Start 0x" + hr.ToString("X8"));

      var stdout = Console.OpenStandardOutput();
      var bytes = new byte[Rate * 4];
      var checkedAt = DateTime.UtcNow;
      while (true) {
        if (evented) ready.WaitOne(50); else Thread.Sleep(5);
        uint packet;
        while (capture.GetNextPacketSize(out packet) == 0 && packet > 0) {
          IntPtr data; uint frames, state; ulong a, b;
          if (capture.GetBuffer(out data, out frames, out state, out a, out b) != 0) break;
          int length = (int)Math.Min(frames * 4, (uint)bytes.Length);
          if ((state & 2) != 0) Array.Clear(bytes, 0, length); // Stille
          else Marshal.Copy(data, bytes, 0, length);
          capture.ReleaseBuffer(frames);
          stdout.Write(bytes, 0, length); // App beendet → Schreibfehler → Ende
          stdout.Flush();
        }
        if (target != null && (DateTime.UtcNow - checkedAt).TotalSeconds > 2) {
          checkedAt = DateTime.UtcNow;
          target.Refresh();
          if (target.HasExited) return 4; // Programm beendet – die App startet neu, sobald es wieder läuft
        }
      }
    } catch (IOException) {
      return 0;
    } catch (Exception e) {
      Console.Error.WriteLine(e.Message);
      return 2;
    } finally {
      if (client != null) { try { client.Stop(); } catch {} Marshal.ReleaseComObject(client); }
      if (format != IntPtr.Zero) Marshal.FreeHGlobal(format);
    }
  }
}
"@

if ($Mode -eq 'list') { [VvCapture]::List(); exit 0 }
if ($Mode -eq 'inputs') { [VvCapture]::Inputs(); exit 0 }
exit [VvCapture]::Run($Mode, $Name)
