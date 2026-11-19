# Fusion installer for an existing foobar2000 v2 setup.
#
# - finds the foobar2000 profile (portable or %APPDATA%\foobar2000-v2)
# - installs foo_ui_webview2 if it's missing or older than 2.1
#   (a foo_ui_webview2*.fb2k-component next to this script is used if there
#   is one, otherwise the latest release is downloaded from GitHub)
# - copies Fusion into <profile>\webview-ui\fusion, keeping the cover cache
# - backs up what it replaces to <profile>\fusion-backup\<date>\ and writes
#   an uninstall script there
#
# Run it with install.bat, or:
#   powershell -ExecutionPolicy Bypass -File install.ps1 [-Foobar <folder>]
# -Foobar takes the foobar2000 folder (with foobar2000.exe) or a profile folder.

param(
    [string]$Foobar = '',
    [switch]$NoComponent
)

$ErrorActionPreference = 'Stop'
$WebViewRepo = 'NereaFantasia/foo_ui_webview2'
$MinWebView = [version]'2.1'

function Say([string]$text, [string]$color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Fail([string]$text) { Say ''; Say $text 'Red'; exit 1 }

function Ask([string]$question, [bool]$default = $true) {
    $hint = if ($default) { '[Y/n]' } else { '[y/N]' }
    $a = Read-Host "$question $hint"
    if ([string]::IsNullOrWhiteSpace($a)) { return $default }
    return $a.Trim().ToLower().StartsWith('y')
}

function Quote([string]$s) { "'" + $s.Replace("'", "''") + "'" }

# --- What we're installing ----------------------------------------------------

$here = $PSScriptRoot
$src = Join-Path $here 'fusion'
if (-not (Test-Path (Join-Path $src 'index.html'))) {
    Fail "Can't find the fusion folder next to this script. Extract the whole zip first, then run install.bat from the extracted folder."
}
$fusionVersion = '?'
$vfile = Join-Path $src 'js\version.js'
if (Test-Path $vfile) {
    $m = [regex]::Match((Get-Content $vfile -Raw), "VERSION = '([^']+)'")
    if ($m.Success) { $fusionVersion = $m.Groups[1].Value }
}
Say ''
Say "Fusion $fusionVersion installer" 'Cyan'
Say ''

# --- Find foobar2000 ----------------------------------------------------------

# A candidate is a profile folder, plus the foobar2000.exe that uses it if known.
$candidates = New-Object System.Collections.ArrayList

function Add-Candidate([string]$prof, [string]$exe) {
    if (-not $prof) { return }
    try { $prof = [IO.Path]::GetFullPath($prof).TrimEnd('\') } catch { return }
    foreach ($c in $candidates) {
        if ($c.Profile -ieq $prof) {
            if (-not $c.Exe -and $exe) { $c.Exe = $exe }
            return
        }
    }
    [void]$candidates.Add([pscustomobject]@{ Profile = $prof; Exe = $exe })
}

function Add-AppFolder([string]$dir) {
    if (-not $dir) { return }
    $dir = $dir.Trim('"').TrimEnd('\')
    if ((Test-Path $dir -PathType Leaf) -and $dir.ToLower().EndsWith('.exe')) { $dir = Split-Path $dir }
    $exe = Join-Path $dir 'foobar2000.exe'
    if (-not (Test-Path $exe)) { return }
    if (Test-Path (Join-Path $dir 'portable_mode_enabled')) {
        Add-Candidate (Join-Path $dir 'profile') $exe
    } else {
        Add-Candidate (Join-Path $env:APPDATA 'foobar2000-v2') $exe
    }
}

function Add-Given([string]$path) {
    $path = $path.Trim('"').TrimEnd('\')
    if (-not (Test-Path $path)) { Fail "Folder not found: $path" }
    if ((Test-Path (Join-Path $path 'foobar2000.exe')) -or ((Test-Path $path -PathType Leaf) -and $path.ToLower().EndsWith('.exe'))) {
        Add-AppFolder $path
    } elseif ((Test-Path (Join-Path $path 'config.sqlite')) -or (Test-Path (Join-Path $path 'user-components-x64')) -or (Test-Path (Join-Path $path 'user-components'))) {
        Add-Candidate $path $null
    } else {
        Fail "That doesn't look like a foobar2000 folder or profile: $path"
    }
}

if ($Foobar) {
    Add-Given $Foobar
} else {
    foreach ($p in @(Get-Process foobar2000 -ErrorAction SilentlyContinue)) {
        try { if ($p.Path) { Add-AppFolder (Split-Path $p.Path) } } catch { }
    }
    $keys = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\foobar2000',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\foobar2000',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\foobar2000'
    )
    foreach ($k in $keys) {
        try {
            $item = Get-ItemProperty $k -ErrorAction Stop
            if ($item.InstallLocation) { Add-AppFolder $item.InstallLocation }
            if ($item.UninstallString) { Add-AppFolder (Split-Path ($item.UninstallString.Trim('"'))) }
        } catch { }
    }
    try {
        $ap = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\foobar2000.exe' -ErrorAction Stop
        if ($ap.'(default)') { Add-AppFolder $ap.'(default)' }
    } catch { }
    Add-AppFolder (Join-Path $env:ProgramFiles 'foobar2000')
    if (${env:ProgramFiles(x86)}) { Add-AppFolder (Join-Path ${env:ProgramFiles(x86)} 'foobar2000') }
    $roaming = Join-Path $env:APPDATA 'foobar2000-v2'
    if (Test-Path $roaming) { Add-Candidate $roaming $null }
}

# Only profiles that exist (foobar2000 has to have been run once).
$found = @($candidates | Where-Object { Test-Path $_.Profile })

while ($found.Count -eq 0) {
    Say "Couldn't find foobar2000. (It has to have been started at least once.)" 'Yellow'
    $p = Read-Host 'Paste the foobar2000 folder (where foobar2000.exe is), or press Enter to quit'
    if ([string]::IsNullOrWhiteSpace($p)) { exit 1 }
    $candidates.Clear()
    Add-Given $p
    $found = @($candidates | Where-Object { Test-Path $_.Profile })
}

if ($found.Count -eq 1) {
    $target = $found[0]
} else {
    Say 'Found more than one foobar2000 profile:'
    for ($i = 0; $i -lt $found.Count; $i++) {
        $what = if ($found[$i].Exe) { Split-Path $found[$i].Exe } else { '(standard install)' }
        Say ("  {0}. {1}   {2}" -f ($i + 1), $found[$i].Profile, $what)
    }
    do {
        $n = Read-Host "Which one? (1-$($found.Count))"
        $ok = $n -match '^\d+$' -and [int]$n -ge 1 -and [int]$n -le $found.Count
    } until ($ok)
    $target = $found[[int]$n - 1]
}

$profileDir = $target.Profile
$exe = $target.Exe
Say "Profile: $profileDir"

# --- 32 or 64-bit -------------------------------------------------------------

function Get-Machine([string]$file) {
    try {
        $fs = [IO.File]::OpenRead($file)
        try {
            $br = New-Object IO.BinaryReader($fs)
            $fs.Position = 0x3C
            $pe = $br.ReadInt32()
            $fs.Position = $pe + 4
            return $br.ReadUInt16()
        } finally { $fs.Close() }
    } catch { return 0 }
}

$arch = ''
if ($exe) {
    switch (Get-Machine $exe) {
        0x8664 { $arch = 'x64' }
        0x014C { $arch = 'x86' }
        0xAA64 { $arch = 'arm64' }
    }
}
if (-not $arch) {
    if (Test-Path (Join-Path $profileDir 'user-components-x64')) { $arch = 'x64' }
    elseif (Test-Path (Join-Path $profileDir 'user-components')) { $arch = 'x86' }
    else { $arch = 'x64' }
}
$componentsDir = if ($arch -eq 'x86') { Join-Path $profileDir 'user-components' } else { Join-Path $profileDir 'user-components-x64' }
Say "foobar2000: $arch"

# --- foobar2000 has to be closed ----------------------------------------------

function Get-Running {
    @(Get-Process foobar2000 -ErrorAction SilentlyContinue | Where-Object {
        try { -not $exe -or -not $_.Path -or ($_.Path -ieq $exe) } catch { $true }
    })
}
while ((Get-Running).Count -gt 0) {
    Say ''
    Say 'foobar2000 is running. Close it, then press Enter (or type Q to quit).' 'Yellow'
    $a = Read-Host
    if ($a -and $a.Trim().ToLower() -eq 'q') { exit 1 }
}

# --- Backup folder and uninstall record ---------------------------------------

$stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
$backup = Join-Path $profileDir "fusion-backup\$stamp"
New-Item -ItemType Directory -Force -Path $backup | Out-Null
$restoreTheme = $false
$componentAction = 'none'   # none | added | replaced
$webviewDir = Join-Path $componentsDir 'foo_ui_webview2'

# --- foo_ui_webview2 -----------------------------------------------------------

function Get-DllVersion([string]$dll) {
    try {
        $vi = (Get-Item $dll).VersionInfo
        $s = if ($vi.ProductVersion) { $vi.ProductVersion } else { $vi.FileVersion }
        $m = [regex]::Match($s, '\d+(\.\d+){1,3}')
        if ($m.Success) { return [version]$m.Value }
    } catch { }
    return $null
}

function Get-WebViewPackage {
    $local = Get-ChildItem -Path $here -Filter 'foo_ui_webview2*.fb2k-component' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($local) {
        Say "Using $($local.Name) from this folder."
        return $local.FullName
    }
    Say "Downloading foo_ui_webview2 from github.com/$WebViewRepo ..."
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $headers = @{ 'User-Agent' = 'fusion-installer' }
        $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$WebViewRepo/releases/latest" -Headers $headers
        $asset = @($rel.assets | Where-Object { $_.name -like '*.fb2k-component' }) | Select-Object -First 1
        if (-not $asset) { throw 'the latest release has no .fb2k-component file' }
        $out = Join-Path $env:TEMP $asset.name
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $out -Headers $headers -UseBasicParsing
        Say "Got $($asset.name) ($($rel.tag_name))."
        return $out
    } catch {
        Say "Download failed: $($_.Exception.Message)" 'Red'
        return $null
    }
}

function Install-WebView([string]$package) {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $tmp = Join-Path $env:TEMP ("fusion-webview2-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        # A .fb2k-component is a zip: 32-bit DLLs at the top, 64-bit ones in x64\.
        $zip = [IO.Compression.ZipFile]::OpenRead($package)
        try {
            foreach ($e in $zip.Entries) {
                $name = $e.FullName.Replace('\', '/')
                if ($name.EndsWith('/')) { continue }
                $dest = Join-Path $tmp ($name.Replace('/', '\'))
                New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
                [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $dest, $true)
            }
        } finally { $zip.Dispose() }

        $dllDir = if ($arch -eq 'x86') { $tmp } else { Join-Path $tmp 'x64' }
        if (-not (Test-Path (Join-Path $dllDir 'foo_ui_webview2.dll'))) {
            throw "the package has no $arch build of foo_ui_webview2.dll"
        }
        New-Item -ItemType Directory -Force -Path $webviewDir | Out-Null
        Get-ChildItem $dllDir -File | Copy-Item -Destination $webviewDir -Force
        $res = Join-Path $tmp 'foo_ui_webview2_resources'
        if (Test-Path $res) { Copy-Item $res -Destination $webviewDir -Recurse -Force }
    } finally {
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Say ''
if ($NoComponent) {
    Say 'Skipping foo_ui_webview2 (-NoComponent).'
} elseif ($arch -eq 'arm64') {
    Say 'This is the ARM build of foobar2000. Install foo_ui_webview2 yourself (File > Preferences > Components > Install...), then run this again with -NoComponent.' 'Yellow'
} else {
    $dll = Join-Path $webviewDir 'foo_ui_webview2.dll'
    $have = if (Test-Path $dll) { Get-DllVersion $dll } else { $null }
    $need = $false
    if (-not (Test-Path $dll)) {
        Say 'foo_ui_webview2 is not installed.'
        $need = $true
    } elseif ($have -and $have -lt $MinWebView) {
        Say "foo_ui_webview2 $have is installed; Fusion needs $MinWebView or later."
        $need = $true
    } else {
        $shown = if ($have) { $have } else { '(version unknown)' }
        Say "foo_ui_webview2 $shown is installed." 'Green'
    }
    if ($need) {
        $pkg = Get-WebViewPackage
        if (-not $pkg) {
            Fail "Couldn't get foo_ui_webview2. Download the .fb2k-component from https://github.com/$WebViewRepo/releases, put it next to install.bat and run it again."
        }
        if (Test-Path $webviewDir) {
            Copy-Item $webviewDir -Destination (Join-Path $backup 'foo_ui_webview2') -Recurse -Force
            $componentAction = 'replaced'
            Remove-Item $webviewDir -Recurse -Force
        } else {
            $componentAction = 'added'
        }
        try { Install-WebView $pkg } catch { Fail "Installing foo_ui_webview2 failed: $($_.Exception.Message)" }
        Say 'foo_ui_webview2 installed.' 'Green'
    }
}

# --- Fusion -------------------------------------------------------------------

$uiDir = Join-Path $profileDir 'webview-ui'
$dest = Join-Path $uiDir 'fusion'
$fresh = -not (Test-Path (Join-Path $dest 'index.html'))
$oldVersion = ''
if (-not $fresh) {
    $ov = Join-Path $dest 'js\version.js'
    if (Test-Path $ov) {
        $m = [regex]::Match((Get-Content $ov -Raw), "VERSION = '([^']+)'")
        if ($m.Success) { $oldVersion = $m.Groups[1].Value }
    }
    # Back up the old theme files (not the cover cache, which stays where it is).
    $bk = Join-Path $backup 'fusion'
    New-Item -ItemType Directory -Force -Path $bk | Out-Null
    Get-ChildItem $dest -Force | Where-Object { $_.Name -ne 'art-cache' } |
        Copy-Item -Destination $bk -Recurse -Force
    $restoreTheme = $true
    # Remove the old theme files so nothing stale is left behind.
    foreach ($n in @('index.html', 'css', 'js')) {
        $p = Join-Path $dest $n
        if (Test-Path $p) { Remove-Item $p -Recurse -Force }
    }
}
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Get-ChildItem $src -Force | Copy-Item -Destination $dest -Recurse -Force

Say ''
if ($fresh) {
    Say "Fusion $fusionVersion installed to $dest" 'Green'
} elseif ($oldVersion) {
    Say "Fusion updated from $oldVersion to $fusionVersion (covers kept)." 'Green'
} else {
    Say "Fusion $fusionVersion installed over the old copy (covers kept)." 'Green'
}

# --- Uninstall script ---------------------------------------------------------

$u = @"
# Undoes the Fusion install of $stamp.
`$ErrorActionPreference = 'Stop'
`$backup = $(Quote $backup)
`$dest = $(Quote $dest)
`$webviewDir = $(Quote $webviewDir)
`$exe = $(Quote ([string]$exe))
`$restoreTheme = `$$restoreTheme
`$componentAction = '$componentAction'

while (@(Get-Process foobar2000 -ErrorAction SilentlyContinue | Where-Object { try { -not `$exe -or -not `$_.Path -or (`$_.Path -ieq `$exe) } catch { `$true } }).Count -gt 0) {
    Write-Host 'foobar2000 is running. Close it, then press Enter.' -ForegroundColor Yellow
    [void](Read-Host)
}

if (`$restoreTheme) {
    foreach (`$n in @('index.html', 'css', 'js')) {
        `$p = Join-Path `$dest `$n
        if (Test-Path `$p) { Remove-Item `$p -Recurse -Force }
    }
    Get-ChildItem (Join-Path `$backup 'fusion') -Force | Copy-Item -Destination `$dest -Recurse -Force
    Write-Host 'Put the previous Fusion back.' -ForegroundColor Green
} elseif (Test-Path `$dest) {
    Remove-Item `$dest -Recurse -Force
    Write-Host 'Removed Fusion (and its cover cache).' -ForegroundColor Green
}

if (`$componentAction -eq 'added') {
    if (Test-Path `$webviewDir) { Remove-Item `$webviewDir -Recurse -Force }
    Write-Host 'Removed foo_ui_webview2. foobar2000 will ask which interface to use next time it starts.' -ForegroundColor Green
} elseif (`$componentAction -eq 'replaced') {
    if (Test-Path `$webviewDir) { Remove-Item `$webviewDir -Recurse -Force }
    Copy-Item (Join-Path `$backup 'foo_ui_webview2') -Destination `$webviewDir -Recurse -Force
    Write-Host 'Put the previous foo_ui_webview2 back.' -ForegroundColor Green
}
Write-Host 'Done.'
"@
Set-Content -Path (Join-Path $backup 'uninstall.ps1') -Value $u -Encoding UTF8
Set-Content -Path (Join-Path $backup 'uninstall.bat') -Encoding ASCII -Value @'
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
echo.
pause
'@
Say "Backup and uninstall script: $backup"

# --- Optional components ------------------------------------------------------

$optional = @(
    @('foo_playcount', 'play counts, the shelves and Listening stats', 'https://www.foobar2000.org/components/view/foo_playcount'),
    @('foo_enhanced_playcount', 'the time-of-day chart', 'https://www.foobar2000.org/components/view/foo_enhanced_playcount'),
    @('foo_openlyrics', 'lyrics', 'https://www.foobar2000.org/components/view/foo_openlyrics'),
    @('foo_outinfo', 'the output side of the signal path', 'https://foobar.hyv.fi/?view=foo_outinfo')
)
$appComponents = if ($exe) { Join-Path (Split-Path $exe) 'components' } else { $null }
$missing = @($optional | Where-Object {
    $n = $_[0]
    -not (Test-Path (Join-Path $componentsDir "$n\$n.dll")) -and
    -not ($appComponents -and (Test-Path (Join-Path $appComponents "$n.dll")))
})
if ($missing.Count -gt 0) {
    Say ''
    Say 'Optional components you don''t have yet:'
    foreach ($o in $missing) { Say ("  {0} - {1}`n    {2}" -f $o[0], $o[1], $o[2]) }
}

# --- Last steps ---------------------------------------------------------------

Say ''
if ($fresh -or $componentAction -eq 'added') {
    Say 'Two things left to do in foobar2000:' 'Cyan'
    Say '  1. Preferences > Display > Default User Interface: choose WebView2 UI'
    Say '  2. Preferences > Display > WebView2 UI: set the template to fusion, then Apply'
} else {
    Say 'Start foobar2000 (or press Ctrl+Shift+F5 if it was already showing Fusion).' 'Cyan'
}

if ($exe -and (Ask "`nStart foobar2000 now?")) {
    Start-Process -FilePath $exe
}
