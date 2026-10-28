const os = require('node:os');
const { execFile } = require('node:child_process');

const STATIC_MAX_AGE = 5 * 60 * 1000;
const LHM_URL = 'http://127.0.0.1:8085/data.json';

// Alles Feste in einem PowerShell-Aufruf (CIM): Prozessor, Grafik, Board, RAM-Riegel, Laufwerke, Windows …
const SCRIPT = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$o = [ordered]@{}
$o.cpu = @(Get-CimInstance Win32_Processor | Select-Object Name, Manufacturer, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed, L2CacheSize, L3CacheSize, SocketDesignation)
$o.gpu = @(Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion, AdapterRAM, CurrentHorizontalResolution, CurrentVerticalResolution, CurrentRefreshRate, VideoProcessor)
$o.vram = @(Get-ItemProperty 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' | Select-Object DriverDesc, @{ n = 'Size'; e = { $_.'HardwareInformation.qwMemorySize' } })
$o.board = @(Get-CimInstance Win32_BaseBoard | Select-Object Manufacturer, Product, Version)
$o.bios = @(Get-CimInstance Win32_BIOS | Select-Object Manufacturer, SMBIOSBIOSVersion)
$o.ram = @(Get-CimInstance Win32_PhysicalMemory | Select-Object Manufacturer, PartNumber, Capacity, Speed, ConfiguredClockSpeed, DeviceLocator)
$o.disks = @(Get-CimInstance Win32_DiskDrive | Select-Object Model, Size, InterfaceType, MediaType)
$o.physical = @(Get-PhysicalDisk | Select-Object FriendlyName, MediaType, BusType)
$o.volumes = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID, VolumeName, Size, FreeSpace, FileSystem)
$o.os = @(Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture)
$o.system = @(Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer, Model, Name)
$o.net = @(Get-CimInstance Win32_NetworkAdapter -Filter 'NetEnabled=true AND PhysicalAdapter=true' | Select-Object Name, Speed)
$o.monitors = @(Get-CimInstance -Namespace root\\wmi WmiMonitorID | ForEach-Object { [pscustomobject]@{ Name = (($_.UserFriendlyName | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ }) -join ''); Maker = (($_.ManufacturerName | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ }) -join '') } })
$o.audio = @(Get-CimInstance Win32_SoundDevice | Select-Object Name)
$o | ConvertTo-Json -Depth 4 -Compress
`;

function run(file, args, timeout) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * PC-Info für die Webseite (Home → PC-Info): feste Hardware-Daten (zwischengespeichert) und Live-Werte
 * (Auslastung, Speicher, Temperaturen). Temperaturen: NVIDIA über nvidia-smi, alles andere über
 * LibreHardwareMonitor (Webserver an Port 8085), falls es läuft – Windows selbst liefert sie nicht.
 */
class PcInfo {
  constructor() {
    this.cache = null;
    this.loading = null;
    this.lastCpu = os.cpus();
  }

  async hardware(force = false) {
    if (!force && this.cache && Date.now() - this.cache.at < STATIC_MAX_AGE) return this.cache.data;
    this.loading ||= (async () => {
      const raw = process.platform === 'win32' ? await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], 30000) : null;
      let data = {};
      try {
        data = JSON.parse(raw || '{}');
      } catch {
        data = {};
      }
      const result = this.shape(data);
      this.cache = { at: Date.now(), data: result };
      this.loading = null;
      return result;
    })();
    return this.loading;
  }

  shape(d) {
    const vram = list(d.vram);
    return {
      system: { ...(list(d.system)[0] || {}), host: os.hostname(), user: os.userInfo().username },
      os: list(d.os)[0] || { Caption: `${os.type()} ${os.release()}` },
      cpu: list(d.cpu).map((c) => ({ ...c, Name: String(c.Name || '').trim() })),
      gpu: list(d.gpu).map((g) => {
        // AdapterRAM endet bei 4 GB – die genaue Größe steht in der Registry
        const exact = num(vram.find((v) => v.DriverDesc === g.Name)?.Size);
        return { ...g, Memory: exact || num(g.AdapterRAM) };
      }),
      board: list(d.board)[0] || null,
      bios: list(d.bios)[0] || null,
      ram: list(d.ram),
      disks: list(d.disks).map((disk) => {
        const phys = list(d.physical).find((p) => p.FriendlyName && disk.Model && disk.Model.includes(p.FriendlyName));
        return { ...disk, Kind: phys?.MediaType || null, Bus: phys?.BusType || disk.InterfaceType || null };
      }),
      volumes: list(d.volumes),
      net: list(d.net),
      monitors: list(d.monitors).filter((m) => m.Name),
      audio: list(d.audio),
    };
  }

  // Prozessor-Auslastung seit dem letzten Aufruf (0–100)
  cpuLoad() {
    const now = os.cpus();
    let idle = 0;
    let total = 0;
    now.forEach((cpu, i) => {
      const before = this.lastCpu[i]?.times;
      if (!before) return;
      for (const key of Object.keys(cpu.times)) total += cpu.times[key] - before[key];
      idle += cpu.times.idle - before.idle;
    });
    this.lastCpu = now;
    return total > 0 ? Math.round((1 - idle / total) * 1000) / 10 : null;
  }

  async nvidia() {
    const out = await run('nvidia-smi', ['--query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total,fan.speed,power.draw,clocks.gr', '--format=csv,noheader,nounits'], 4000);
    if (!out) return [];
    return out.trim().split(/\r?\n/).map((line) => {
      const [name, temp, load, memUsed, memTotal, fan, power, clock] = line.split(',').map((s) => s.trim());
      return { name, temp: num(temp), load: num(load), memUsed: num(memUsed), memTotal: num(memTotal), fan: num(fan), power: num(power), clock: num(clock) };
    });
  }

  // LibreHardwareMonitor: alle Temperatur-Sensoren mit dem Gerät, zu dem sie gehören
  async libreHardware() {
    try {
      const res = await fetch(LHM_URL, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return null;
      const root = await res.json();
      const temps = [];
      const loads = [];
      const walk = (node, device) => {
        const children = node.Children || [];
        const value = parseFloat(String(node.Value || '').replace(',', '.'));
        if (!children.length && Number.isFinite(value)) {
          const unit = String(node.Value);
          if (node.Type === 'Temperature' || unit.includes('°C')) temps.push({ device, name: node.Text, value });
          else if (node.Type === 'Load' && /total|core$/i.test(node.Text || '')) loads.push({ device, name: node.Text, value });
        }
        for (const child of children) walk(child, node.ImageURL && /cpu|nvidia|ati|amd|intel|hdd|ssd|mainboard|ram|chip/i.test(node.ImageURL) ? node.Text : device);
      };
      walk(root, '');
      return { temps, loads };
    } catch {
      return null;
    }
  }

  async live() {
    const [nvidia, lhm] = await Promise.all([this.nvidia(), this.libreHardware()]);
    return {
      at: Date.now(),
      cpuLoad: this.cpuLoad(),
      memTotal: os.totalmem(),
      memFree: os.freemem(),
      uptime: os.uptime(),
      nvidia,
      sensors: lhm,
    };
  }
}

module.exports = { PcInfo };
