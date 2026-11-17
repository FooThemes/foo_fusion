// One volume everywhere: the slider shows and sets Windows' volume (the
// default output device, as the taskbar and the volume keys change it), and
// foobar2000's own volume follows the output mode:
//
// - shared (WASAPI shared, DirectSound): Windows' mixer applies its volume,
//   so foobar2000 stays at 0 dB;
// - exclusive and ASIO: Windows' volume doesn't reach the device, so
//   foobar2000 attenuates by the same dB instead. The volume keys, Windows'
//   own pop-up and switching outputs all stay in step. That holds for a DAC
//   with hardware volume too: while ASIO or an exclusive stream holds it,
//   Windows can't reach its volume control (setting it fails with E_HANDLE,
//   though Windows keeps the value). The DAC keeps the level Windows last set
//   (applied in every mode), so foobar2000 makes up only the difference, and
//   the level is pushed to the DAC again when the device is let go.
// - mute: Windows can't mute a held device at all (nor keeps it), so on
//   exclusive and ASIO outputs it's foobar2000's mute.
//
// The page can't reach Windows' audio API, so a small PowerShell helper does
// (written to the profile and started from here; it quits with foobar2000).
// They talk through two files in the profile: the helper writes the volume to
// fusion-volume.json when it changes, and applies what Fusion writes to
// fusion-volume-set.json.

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

class OsVolume extends Emitter {
  active = false; // the helper is running and reporting
  scalar = 1; // Windows' volume, 0..1
  db = 0;
  muted = false;
  hw = false; // the device has hardware volume
  hwDb = null; // the level the DAC itself is at (Windows' last that reached it)
  #localMute = false; // muted in foobar2000 (exclusive/ASIO: Windows can't)
  #pending = null; // { scalar, until }: what the slider asked for, until Windows reports it
  #lastSeq = 0;
  #profile = '';
  #seq = Date.now();
  #exclusive = null; // the output mode, as last seen
  #lastSync = '';
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
    // Its reports: read a few times a second (cheap), until it stops.
    setInterval(() => this.#read(), 250);
    // The output mode: on the event, and looked at now and then.
    on('audio:outputDeviceChanged', () => this.#checkMode());
    setInterval(() => this.#checkMode(), 3000);
    this.#checkMode();
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
    if (first) logInfo(`volume: following Windows (device ${v.device}, ${Math.round(v.scalar * 100)}%, ${v.db.toFixed(1)} dB${v.hw & 1 ? ', hardware volume' : ''}${v.muted ? ', muted' : ''})`);
    this.active = true;
    const hw = !!(v.hw & 1);
    // The DAC's own level: Windows' while Windows has the device (shared), and
    // after a change that reached it (the helper says so); else where it was.
    const hwBefore = this.hwDb;
    if (hw && (this.hwDb == null || !this.#exclusive || (v.seq === this.#lastSeq && v.hr === 0 && v.seq > 0))) this.hwDb = v.db;
    if (hwBefore != null && this.hwDb !== hwBefore && this.#exclusive) logInfo(`volume: the DAC is now at ${this.hwDb.toFixed(1)} dB`);
    // The slider's own value stays until Windows reports it (a moment later),
    // so older reports don't pull it back while it's being moved.
    if (this.#pending) {
      if (Math.abs(v.scalar - this.#pending.scalar) < 0.006 || performance.now() > this.#pending.until) this.#pending = null;
      else return;
    }
    const changed = first || Math.abs(v.scalar - this.scalar) > 1e-4 || Math.abs(v.db - this.db) > 0.01 || !!v.muted !== this.muted || hw !== this.hw || this.hwDb !== hwBefore;
    this.scalar = v.scalar;
    this.db = v.db;
    this.muted = !!v.muted;
    this.hw = hw;
    if (changed) {
      this.emit('change');
      this.#sync();
    }
  }

  /** Muted: in Windows, or (exclusive/ASIO) in foobar2000. */
  get isMuted() {
    return this.muted || this.#localMute;
  }

  async #checkMode() {
    const conf = await tryCall('config.getOutputConfig');
    if (!conf) return;
    const name = `${conf.outputName || ''} ${conf.deviceName || ''}`;
    const exclusive = /asio|exclusive|kernel streaming|\bks\b/i.test(name);
    if (exclusive !== this.#exclusive) {
      const was = this.#exclusive;
      this.#exclusive = exclusive;
      if (was && !exclusive) {
        // Windows has the device back: the DAC gets its level (Windows may
        // not send it until the next change), and a foobar2000 mute moves over.
        if (this.hw && this.hwDb != null && Math.abs(this.db - this.hwDb) > 0.05) await this.#send({ scalar: this.scalar });
        if (this.#localMute) {
          this.#localMute = false;
          await this.#send({ mute: true });
        }
      }
      this.#sync();
    }
  }

  /** foobar2000's volume, for the output mode: 0 dB, or what Windows' level needs on top of the DAC's. */
  async #sync() {
    if (!this.active || this.#exclusive == null) return;
    const follow = this.#exclusive;
    // A DAC with its own volume keeps the level Windows last set: foobar2000
    // makes up the rest (it can only lower, so the DAC's level is the ceiling).
    const dac = this.hw && this.hwDb != null ? this.hwDb : 0;
    const muted = this.muted || this.#localMute;
    const target = follow ? (muted ? 'mute' : Math.max(-100, Math.min(0, this.db - dac))) : 0;
    const key = `${follow}|${target === 'mute' ? 'mute' : target.toFixed(1)}`;
    if (key === this.#lastSync) return;
    this.#lastSync = key;
    if (target === 'mute') return void tryCall('playback.mute', { muted: true });
    await tryCall('playback.mute', { muted: false });
    await this.#setFoobarDb(target);
  }

  /** The device let go (stopped, or paused with "Pause releases ASIO"): Windows' level pushed to the DAC again. */
  pushToDevice() {
    if (this.active && this.hw && this.#exclusive && this.hwDb != null && Math.abs(this.db - this.hwDb) > 0.05) return this.#send({ scalar: this.scalar });
  }

  async #setFoobarDb(db) {
    if (db >= -0.05) return tryCall('playback.setVolume', { volume: 100 });
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

  /** Sets Windows' volume (0..1). */
  set(scalar) {
    scalar = Math.max(0, Math.min(1, scalar));
    this.#pending = { scalar, until: performance.now() + 1500 };
    this.scalar = scalar;
    return this.#send({ scalar });
  }
  setMute(muted) {
    // Windows can't mute a device ASIO or an exclusive stream holds.
    if (this.#exclusive) {
      this.#localMute = !!muted && !this.muted;
      if (!muted && this.muted) this.#send({ mute: false });
      this.emit('change');
      this.#lastSync = '';
      return this.#sync();
    }
    return this.#send({ mute: !!muted });
  }
  #send(cmd) {
    this.#lastSeq = ++this.#seq;
    return call('file.write', { path: `${this.#profile}\\fusion-volume-v${VERSION}-set.json`, content: JSON.stringify({ seq: this.#seq, ...cmd }) });
  }
}

export const osVolume = new OsVolume();
