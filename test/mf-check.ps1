# mf-check.ps1 - Windows Media Foundation playback compatibility self-check.
#
# Why: some malformed-but-tolerated MP4 boxes (e.g. a dref box missing its
# version/flags field) play fine in VLC and parse fine in mp4box.js, yet make
# Windows Media Foundation drop every track. This script uses the same engine
# as the Windows built-in player, so it catches exactly those regressions.
#
# Usage (Windows PowerShell 5.1, no admin needed):
#   powershell -ExecutionPolicy Bypass -File mf-check.ps1 <file.mp4>
#
# Exit code: 0 = Media Foundation can open/play, 1 = cannot open, 2 = no event.

param([string]$File)
$ErrorActionPreference = 'Stop'
$full = (Resolve-Path $File).Path
Write-Host ("FILE: " + $full)

# ---------- 1) Source reader diagnostic: real HRESULT + per-stream media types ----------
$code = @'
using System;
using System.Runtime.InteropServices;

public class MFDiag {
    [DllImport("mfplat.dll", ExactSpelling = true)]
    public static extern int MFStartup(int Version, int dwFlags);
    [DllImport("mfplat.dll", ExactSpelling = true)]
    public static extern int MFShutdown();
    [DllImport("mfreadwrite.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    public static extern int MFCreateSourceReaderFromURL(string url, IntPtr attrs, out IntPtr reader);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int GetNativeMediaTypeFn(IntPtr self, int streamIndex, int mediaTypeIndex, out IntPtr mediaType);

    static IntPtr VtblFn(IntPtr comObject, int index) {
        IntPtr vtbl = Marshal.ReadIntPtr(comObject);
        return Marshal.ReadIntPtr(vtbl, index * IntPtr.Size);
    }

    public static string Check(string path) {
        string log = "";
        int hr = MFStartup(0x00020070, 0);
        if (hr != 0) return "MFStartup failed: 0x" + hr.ToString("X8");
        IntPtr reader;
        hr = MFCreateSourceReaderFromURL(path, IntPtr.Zero, out reader);
        log += "  MFCreateSourceReaderFromURL: 0x" + hr.ToString("X8");
        if (hr != 0) { MFShutdown(); return log + "  (FAILED - Media Foundation rejects this file)"; }
        int[] ids = new int[] { -4, -3 };          // FIRST_VIDEO_STREAM, FIRST_AUDIO_STREAM
        string[] names = new string[] { "video", "audio" };
        int usable = 0;
        for (int i = 0; i < ids.Length; i++) {
            var fn = (GetNativeMediaTypeFn)Marshal.GetDelegateForFunctionPointer(VtblFn(reader, 5), typeof(GetNativeMediaTypeFn));
            IntPtr mt;
            int r = fn(reader, ids[i], 0, out mt);
            log += "\r\n  GetNativeMediaType(" + names[i] + "): 0x" + r.ToString("X8");
            if (r == 0) { usable++; if (mt != IntPtr.Zero) Marshal.Release(mt); }
        }
        log += "\r\n  usable streams: " + usable;
        Marshal.Release(reader);
        MFShutdown();
        return log;
    }
}
'@
Add-Type -TypeDefinition $code -Language CSharp | Out-Null
Write-Host "MEDIA FOUNDATION SOURCE READER:"
Write-Host ([MFDiag]::Check($full))

# ---------- 2) WPF MediaPlayer (same engine as the built-in player) ----------
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
$uri = [System.Uri]::new('file:///' + $full.Replace('\', '/'))
$player = New-Object System.Windows.Media.MediaPlayer
$script:state = 'pending'
$script:err = $null
$player.add_MediaOpened({ $script:state = 'opened' })
$player.add_MediaFailed({ param($s, $e) $script:state = 'failed'; $script:err = $e.ErrorException })
$player.Volume = 0
$player.Open($uri)
$player.Play()
$deadline = (Get-Date).AddSeconds(20)
$frame = New-Object System.Windows.Threading.DispatcherFrame
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(200)
$timer.add_Tick({ if ($script:state -ne 'pending' -or (Get-Date) -gt $deadline) { $frame.Continue = $false } })
$timer.Start()
if ([System.Threading.Thread]::CurrentThread.GetApartmentState() -eq 'STA') {
    [System.Windows.Threading.Dispatcher]::PushFrame($frame)
} else {
    Write-Host "WPF PLAYER: skipped (run with -STA to enable the MediaPlayer check)"
}
$timer.Stop()
$w = $player.NaturalVideoWidth; $h = $player.NaturalVideoHeight
$dur = $player.NaturalDuration; $hasAudio = $player.HasAudio
$player.Stop(); $player.Close()

if ($script:state -eq 'opened') {
    Write-Host "WPF PLAYER: OK - Windows can play this file" -ForegroundColor Green
    Write-Host ("  video: {0}x{1}  duration: {2}  has audio: {3}" -f $w, $h, $dur, $hasAudio)
    exit 0
} elseif ($script:state -eq 'failed') {
    Write-Host "WPF PLAYER: FAIL - Windows cannot play this file" -ForegroundColor Red
    Write-Host ("  error: {0}" -f $script:err.Message)
    if ($script:err.HResult) { Write-Host ("  HRESULT: 0x{0:X8}" -f $script:err.HResult) }
    exit 1
} else {
    Write-Host "WPF PLAYER: TIMEOUT - no event received" -ForegroundColor Yellow
    exit 2
}
