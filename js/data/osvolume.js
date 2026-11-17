// One volume everywhere: the slider shows and sets Windows' volume (the
// default output device, as the taskbar and the volume keys change it), and
// foobar2000's own volume follows the output mode:
//
// - shared (WASAPI shared, DirectSound): Windows applies its volume, so
//   foobar2000 stays at 0 dB, and the slider follows Windows (keys, flyout).
// - exclusive and ASIO: Windows' volume doesn't reach the output, so
//   foobar2000 applies the slider's level. The two stay linked anyway: the
//   slider is sent to Windows (it takes it where it can; the rest is sent
//   again when it has the device back), and a change made in Windows (keys,
//   flyout) moves the slider. Reports right after the output changes or
//   playback starts are ignored (Windows' reading can jump as the device is
//   taken). Mute there is foobar2000's volume at its lowest.
//
// How loud a Windows level actually is depends on the device's driver (the
// dB Windows reports isn't always what's applied), so the curve used on
// exclusive/ASIO outputs is a setting.
//
// The page can't reach Windows' audio API, so a small PowerShell helper does
// (written to the profile and started from here; it quits with foobar2000).
// They talk through two files in the profile: the helper writes the volume to
// fusion-volume-v*.json when it changes, and applies what Fusion writes to
// fusion-volume-v*-set.json.

import { call, tryCall, on } from '../core/bridge.js';
import { Emitter } from '../core/emitter.js';
import { logInfo } from '../core/log.js';
import * as store from '../core/store.js';

// Bump with any change to the script: a helper from an older Fusion keeps
// running until foobar2000 restarts, and a new one runs beside it.
const VERSION = 3;

const SCRIPT = `param([string]$Dir)
$ErrorActionPreference = 'Stop'
$log = Join-Path $Dir 'fusion-volume.log'
function Log($m) { try { Add-Content -Path $log -Value ((Get-Date).ToString('s') + ' ' + $m) } catch {} }
$mutex = New-Object System.Threading.Mutex($false, 'Local\\FusionVolumeHelper-${VERSION}')
if (-not $mutex.WaitOne(0)) { exit 0 }
try {
  Add-Type -TypeDefinition @'
using System;
using System.Globalization;
using System.Runtime.InteropServices;
[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  [PreserveSig] int RegisterControlChangeNotify(IntPtr p);
  [PreserveSig] int UnregisterControlChangeNotify(IntPtr p);
  [PreserveSig] int GetChannelCount(out uint c);
  [PreserveSig] int SetMasterVolumeLevel(float db, ref Guid ctx);
  [PreserveSig] int SetMasterVolumeLevelScalar(float v, ref Guid ctx);
  [PreserveSig] int GetMasterVolumeLevel(out float db);
  [PreserveSig] int GetMasterVolumeLevelScalar(out float v);
  [PreserveSig] int SetChannelVolumeLevel(uint ch, float db, ref Guid ctx);
  [PreserveSig] int SetChannelVolumeLevelScalar(uint ch, float v, ref Guid ctx);
  [PreserveSig] int GetChannelVolumeLevel(uint ch, out float db);
  [PreserveSig] int GetChannelVolumeLevelScalar(uint ch, out float v);
  [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool m, ref Guid ctx);
  [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool m);
  [PreserveSig] int GetVolumeStepInfo(out uint step, out uint count);
  [PreserveSig] int VolumeStepUp(ref Guid ctx);
  [PreserveSig] int VolumeStepDown(ref Guid ctx);
  [PreserveSig] int QueryHardwareSupport(out uint mask);
  [PreserveSig] int GetVolumeRange(out float min, out float max, out float inc);
}
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  [PreserveSig] int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o);
  [PreserveSig] int OpenPropertyStore(int access, out IntPtr store);
  [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
}
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  [PreserveSig] int EnumAudioEndpoints(int flow, int mask, out IntPtr devices);
  [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}
public static class FusionVol {
  static IAudioEndpointVolume Endpoint(out string id) {
    var e = (IMMDeviceEnumerator)new MMDeviceEnumerator();
    IMMDevice d;
    Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0, 0, out d));
    d.GetId(out id);
    var iid = typeof(IAudioEndpointVolume).GUID;
    object o;
    Marshal.ThrowExceptionForHR(d.Activate(ref iid, 23, IntPtr.Zero, out o));
    return (IAudioEndpointVolume)o;
  }
  public static string Get() {
    string id;
    var v = Endpoint(out id);
    float s, db, min, max, inc; bool m; uint hw;
    v.GetMasterVolumeLevelScalar(out s);
    v.GetMasterVolumeLevel(out db);
    v.GetMute(out m);
    v.QueryHardwareSupport(out hw);
    v.GetVolumeRange(out min, out max, out inc);
    return string.Format(CultureInfo.InvariantCulture, "{{\\"scalar\\":{0},\\"db\\":{1},\\"muted\\":{2},\\"hw\\":{3},\\"min\\":{4},\\"max\\":{5},\\"device\\":\\"{6}\\"}}", s, db, m ? "true" : "false", hw, min, max, id.Replace("\\\\", "\\\\\\\\"));
  }
  public static int SetScalar(float s) { string id; var g = Guid.Empty; return Endpoint(out id).SetMasterVolumeLevelScalar(Math.Max(0f, Math.Min(1f, s)), ref g); }
  public static int SetMute(bool m) { string id; var g = Guid.Empty; return Endpoint(out id).SetMute(m, ref g); }
}
'@
  $parent = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId
  Log "started, version ${VERSION}, for process $parent"
  $state = Join-Path $Dir 'fusion-volume-v${VERSION}.json'
  $tmp = $state + '.tmp'
  $cmd = Join-Path $Dir 'fusion-volume-v${VERSION}-set.json'
  $last = ''
  $seq = -1
  $lastHr = 0
  $stamp = $null
  if (Test-Path $cmd) { try { $seq = [long]((Get-Content $cmd -Raw | ConvertFrom-Json).seq) } catch {} }
  $n = 0
  while ($true) {
    if (($n % 25) -eq 0 -and -not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { break }
    $n++
    try {
      if (Test-Path $cmd) {
        $t = (Get-Item $cmd).LastWriteTimeUtc
        if ($t -ne $stamp) {
          $stamp = $t
          $c = Get-Content $cmd -Raw | ConvertFrom-Json
          if ([long]$c.seq -gt $seq) {
            $seq = [long]$c.seq
            $hr = 0
            if ($null -ne $c.scalar) { $hr = [FusionVol]::SetScalar([float]$c.scalar) }
            if ($null -ne $c.mute) { $hr = [FusionVol]::SetMute([bool]$c.mute) }
            # E_HANDLE while ASIO or an exclusive stream holds the device: Windows
            # keeps the value but can't reach the hardware. Logged once.
            if ($hr -ne 0 -and $hr -ne $lastHr) { Log ('setting the volume returned 0x{0:X8}' -f $hr) }
            $lastHr = $hr
          }
        }
      }
      $now = [FusionVol]::Get()
      $now = $now.Substring(0, $now.Length - 1) + ',"hr":' + $lastHr + ',"seq":' + $seq + '}'
      if ($now -ne $last) {
        [IO.File]::WriteAllText($tmp, $now)
        Move-Item -Path $tmp -Destination $state -Force
        $last = $now
      }
    } catch {
      Log $_.Exception.Message
      Start-Sleep -Milliseconds 1000
    }
    Start-Sleep -Milliseconds 100
  }
  Log 'foobar2000 has closed; stopping'
} catch {
  Log $_.Exception.Message
} finally {
  $mutex.ReleaseMutex()
}
`;

// How foobar2000's percentage maps to its dB (the component doesn't say):
// worked out from what it reports, among the usual curves.
const CURVES = {
  amp: { toDb: (p) => 20 * Math.log10(p / 100), toPct: (db) => 100 * 10 ** (db / 20) },
  sqrt: { toDb: (p) => 40 * Math.log10(p / 100), toPct: (db) => 100 * 10 ** (db / 40) },
  cube: { toDb: (p) => 60 * Math.log10(p / 100), toPct: (db) => 100 * 10 ** (db / 60) },
  linear: { toDb: (p) => p - 100, toPct: (db) => 100 + db },
};
const CURVE_KEY = 'fusion.volumeCurve';

const TARGET_KEY = 'fusion.volumeLevel';
const TAPER_KEY = 'fusion.volumeTaper';
const load = (k, d) => {
  try {
    const v = JSON.parse(localStorage.getItem(k));
    return v ?? d;
  } catch {
    return d;
  }
};
const keep = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* fine */
  }
};

class OsVolume extends Emitter {
  active = false; // the helper is running and reporting
  scalar = load(TARGET_KEY, 1); // the slider's level, 0..1 (Windows' while it has the device)
  muted = false;
  #win = null; // Windows' last report
  #taper = load(TAPER_KEY, {}); // Windows' dB at each percent, as seen in shared mode
  #pending = null; // { scalar, until }: what the slider asked for, until Windows reports it
  #profile = '';
  #seq = Date.now();
  #exclusive = null; // the output mode, as last seen
  #lastSync = '';
  #quietUntil = 0;
  #outName = null; // the output, as last seen
  #syncing = null;
  #curve = (() => {
    try {
      return localStorage.getItem(CURVE_KEY) || '';
    } catch {
      return '';
    }
  })();

  async init() {
    if (!store.get('volumeFollowsWindows')) return;
    const prof = await tryCall('misc.getProfilePath');
    this.#profile = String(prof?.path || prof?.value || '').replace(/[\\/]$/, '');
    if (!this.#profile) return;
    const script = `${this.#profile}\\fusion-volume-v${VERSION}.ps1`;
    const wrote = await tryCall('file.write', { path: script, content: SCRIPT });
    if (!wrote) return logInfo('volume: couldn’t write the helper script');
    const started = await tryCall('shell.spawn', { executable: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, '-Dir', this.#profile], hidden: true });
    if (!started) return logInfo('volume: couldn’t start the helper');
    logInfo(`volume: helper started (process ${started.processId})`);
    await this.#checkMode();
    // Its reports: read a few times a second (cheap), until it stops.
    setInterval(() => this.#read(), 250);
    // The output mode: on the event, and looked at now and then.
    on('audio:outputDeviceChanged', () => this.#checkMode());
    on('playback:stateChanged', () => this.#quiet());
    on('playback:trackChanged', () => this.#quiet());
    store.subscribe((k) => k === 'exclusiveCurve' && ((this.#lastSync = ''), this.#sync()));
    setInterval(() => this.#checkMode(), 3000);
  }

  /** Muted (Windows' mute, or on exclusive/ASIO, Fusion's). */
  get isMuted() {
    return this.muted;
  }

  async #read() {
    const res = await tryCall('file.read', { path: `${this.#profile}\\fusion-volume-v${VERSION}.json` });
    const text = String(res?.content ?? '').replace(/^\uFEFF/, '');
    if (!text) return;
    let v;
    try {
      v = JSON.parse(text);
    } catch {
      return; // caught mid-write: next time
    }
    const first = !this.active;
    const prev = this.#win;
    this.#win = v;
    if (first) {
      this.active = true;
      logInfo(`volume: helper reporting (device ${v.device}, Windows at ${Math.round(v.scalar * 100)}%, ${v.db.toFixed(1)} dB${v.hw & 1 ? ', hardware volume' : ''}${v.muted ? ', muted' : ''}; ${this.#exclusive ? 'exclusive' : 'shared'} output, level ${Math.round(this.scalar * 100)}%)`);
    }
    const moved = first || !prev || Math.abs(v.scalar - prev.scalar) > 1e-4 || !!v.muted !== !!prev.muted;
    if (moved && !first) await this.#checkMode();
    if (first) {
      // On an exclusive output the level carries on from last time; shared,
      // Windows' is the level.
      if (this.#exclusive) {
        this.emit('change');
        this.#sync();
        this.#send();
        return;
      }
    } else if (!moved) {
      return;
    }
    if (!this.#exclusive) this.#learnTaper(v);
    if (performance.now() < this.#quietUntil) return; // the device just changed hands
    // Held by ASIO/exclusive, Windows can read 100% whatever it was: a jump
    // there isn't a change.
    // (A step up to 100% from nearby, as scrolling Windows' volume does, is real.)
    if (this.#exclusive && v.scalar >= 0.999 && v.hr !== 0 && (!prev || prev.scalar < 0.9)) return;
    if (this.#pending) {
      // The slider's own value stays until Windows reports it (a moment later),
      // so older reports don't pull it back while it's being moved.
      if ((Math.abs(v.scalar - this.#pending.scalar) < 0.006 && !!v.muted === this.#pending.muted) || performance.now() > this.#pending.until) this.#pending = null;
      return;
    }
    if (Math.abs(v.scalar - this.scalar) < 1e-4 && !!v.muted === this.muted) return;
    if (this.#exclusive) logInfo(`volume: Windows moved to ${Math.round(v.scalar * 100)}%${v.muted ? ', muted' : ''}; following`);
    this.#setLevel(v.scalar);
    this.muted = !!v.muted;
    this.emit('change');
    this.#sync();
  }

  /** Playback started or the output changed: Windows' next readings aren't a change of level. */
  #quiet(ms = 2500) {
    this.#quietUntil = performance.now() + ms;
    this.#pending = null;
  }

  #setLevel(scalar) {
    this.scalar = Math.max(0, Math.min(1, scalar));
    keep(TARGET_KEY, Math.round(this.scalar * 1000) / 1000);
  }

  #learnTaper(v) {
    const pct = Math.round(v.scalar * 100);
    if (Math.abs(v.scalar * 100 - pct) > 0.2 || this.#taper[pct] === v.db) return;
    this.#taper[pct] = Math.round(v.db * 100) / 100;
    keep(TAPER_KEY, this.#taper);
  }

  /** Windows' dB for a level: from what it's reported (in between, interpolated). */
  #windowsDb(scalar) {
    if (scalar <= 0) return -100;
    const p = scalar * 100;
    const known = Object.keys(this.#taper).map(Number).sort((a, b) => a - b);
    let lo = null;
    let hi = null;
    for (const k of known) {
      if (k <= p) lo = k;
      if (k >= p && hi == null) hi = k;
    }
    if (lo == null || hi == null) return 20 * Math.log10(scalar); // not seen yet
    if (lo === hi) return this.#taper[lo];
    return this.#taper[lo] + ((this.#taper[hi] - this.#taper[lo]) * (p - lo)) / (hi - lo);
  }

  async #checkMode() {
    const conf = await tryCall('config.getOutputConfig');
    if (!conf) return;
    const name = `${conf.outputName || ''} ${conf.deviceName || ''}`.trim();
    const exclusive = /asio|exclusive|kernel streaming|\bks\b/i.test(name);
    if (name !== this.#outName) {
      const first = this.#outName == null;
      this.#outName = name;
      this.#exclusive = exclusive;
      if (!first) {
        logInfo(`volume: output now “${name}” (${exclusive ? 'exclusive' : 'shared'}), level ${Math.round(this.scalar * 100)}%${this.muted ? ', muted' : ''}`);
        // The level carries over: Windows gets it (it takes it if it has the
        // device), and foobar2000's volume is set for the new mode.
        this.#quiet(3000);
        this.#send();
      } else {
        logInfo(`volume: output “${name}” (${exclusive ? 'exclusive' : 'shared'})`);
      }
      this.#lastSync = '';
    }
    // Every time: foobar2000's volume is checked against the slider, and put right.
    this.#sync();
  }

  /** foobar2000's volume, for the output mode: 0 dB shared; the level on exclusive/ASIO. */
  #target() {
    if (!this.#exclusive) return 0;
    if (this.muted) return -100;
    const db = store.get('exclusiveCurve') === 'windows' ? this.#windowsDb(this.scalar) : 20 * Math.log10(Math.max(1e-5, this.scalar));
    return Math.max(-100, Math.min(0, db));
  }
  #sync() {
    if (!this.active || this.#exclusive == null) return;
    // One at a time; the last asked for wins.
    if (this.#syncing) return (this.#syncing.again = true), this.#syncing.done;
    const job = { again: false };
    job.done = (async () => {
      try {
        do {
          job.again = false;
          await this.#apply();
        } while (job.again);
      } finally {
        this.#syncing = null;
      }
    })();
    this.#syncing = job;
    return job.done;
  }
  async #apply() {
    const target = this.#target();
    const key = `${this.#exclusive}|${target.toFixed(1)}`;
    // Already set: still checked against what foobar2000 reports (anything
    // else may have changed it), and set again if it's off.
    if (key === this.#lastSync) {
      const now = await tryCall('playback.getVolume');
      if (!now || now.volumeDb == null) return;
      const off = target <= -99 ? now.volumeDb > -99 : Math.abs(now.volumeDb - target) > 0.6;
      if (!off && !now.muted && !now.isMuted) return;
      logInfo(`volume: foobar2000 was at ${Number(now.volumeDb).toFixed(1)} dB${now.muted || now.isMuted ? ' (muted)' : ''}, not ${target.toFixed(1)}; setting it again`);
    }
    this.#lastSync = key;
    await tryCall('playback.mute', { muted: false });
    await this.#setFoobarDb(target);
  }

  /** The device let go (stopped, or paused with "Pause releases ASIO"): Windows gets the level. */
  pushToDevice() {
    if (this.active) return this.#send();
  }

  async #setFoobarDb(db) {
    if (db >= -0.05) return tryCall('playback.setVolume', { volume: 100 });
    if (db <= -99) return tryCall('playback.setVolume', { volume: 0 });
    const curve = CURVES[this.#curve] || CURVES.amp;
    await tryCall('playback.setVolume', { volume: Math.max(1, Math.min(100, curve.toPct(db))) });
    const now = await tryCall('playback.getVolume');
    if (!now || now.volumeDb == null) return;
    // Learn the curve from what foobar2000 reports, then land on the level.
    if (Math.abs(now.volumeDb - db) > 0.6) {
      const p = now.volume;
      if (p > 0 && p < 100) {
        let best = '';
        let err = Infinity;
        for (const [k, c] of Object.entries(CURVES)) {
          const e = Math.abs(c.toDb(p) - now.volumeDb);
          if (e < err) [best, err] = [k, e];
        }
        if (best && best !== this.#curve) {
          this.#curve = best;
          try {
            localStorage.setItem(CURVE_KEY, best);
          } catch {
            /* fine */
          }
          logInfo(`volume: foobar2000's percent scale is "${best}"`);
          await tryCall('playback.setVolume', { volume: Math.max(1, Math.min(100, CURVES[best].toPct(db))) });
        }
      }
      // Still off: one-decibel steps the rest of the way.
      for (let i = 0; i < 6; i++) {
        const v = await tryCall('playback.getVolume');
        if (!v || v.volumeDb == null || Math.abs(v.volumeDb - db) <= 0.6) break;
        await tryCall(v.volumeDb > db ? 'playback.volumeDown' : 'playback.volumeUp');
      }
    }
  }

  /** Sets the level (0..1): Windows' volume, and foobar2000's on exclusive/ASIO. */
  set(scalar) {
    this.#setLevel(scalar);
    this.emit('change');
    this.#hold();
    if (this.#exclusive) this.#sync();
    return this.#send();
  }
  setMute(muted) {
    this.muted = !!muted;
    this.emit('change');
    this.#hold();
    // Windows can't mute a device ASIO or an exclusive stream holds:
    // foobar2000's volume goes to its lowest instead.
    if (this.#exclusive) this.#sync();
    return this.#send();
  }
  #hold() {
    this.#pending = { scalar: this.scalar, muted: this.muted, until: performance.now() + 1500 };
  }
  // Always the whole state (level and mute): one write can replace another
  // before the helper reads it.
  #send() {
    ++this.#seq;
    return call('file.write', { path: `${this.#profile}\\fusion-volume-v${VERSION}-set.json`, content: JSON.stringify({ seq: this.#seq, scalar: this.scalar, mute: this.muted }) });
  }
}

export const osVolume = new OsVolume();
