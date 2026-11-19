# Fusion installer for an existing foobar2000 v2 setup.
#
# - finds the foobar2000 profile (portable or %APPDATA%\foobar2000-v2)
# - installs foo_ui_webview2 if it's missing or older than 2.1
#   (a foo_ui_webview2*.fb2k-component next to this script is used if there
#   is one, otherwise the latest release is downloaded from GitHub)
# - offers to install the optional components that are missing
# - copies Fusion (with the artist info script) into
#   <profile>\webview-ui\fusion, keeping the cover cache and the script's
#   settings
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
    $path = $path.Trim().Trim('"').TrimEnd('\')
    if (-not (Test-Path $path)) { Say "Folder not found: $path" 'Red'; return $false }
    if ((Test-Path (Join-Path $path 'foobar2000.exe')) -or ((Test-Path $path -PathType Leaf) -and $path.ToLower().EndsWith('.exe'))) {
        Add-AppFolder $path
    } elseif ((Test-Path (Join-Path $path 'config.sqlite')) -or (Test-Path (Join-Path $path 'user-components-x64')) -or (Test-Path (Join-Path $path 'user-components'))) {
        Add-Candidate $path $null
    } else {
        Say "That doesn't look like a foobar2000 folder or profile: $path" 'Red'
        return $false
    }
    return $true
}

if ($Foobar) {
    if (-not (Add-Given $Foobar)) { exit 1 }
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

# Asks for a foobar2000 folder until one works; $null if the user gives up.
function Read-Folder {
    while ($true) {
        $p = Read-Host 'Paste the foobar2000 folder (where foobar2000.exe is), or press Enter to quit'
        if ([string]::IsNullOrWhiteSpace($p)) { return $null }
        $candidates.Clear()
        if (-not (Add-Given $p)) { continue }
        $got = @($candidates | Where-Object { Test-Path $_.Profile })
        if ($got.Count -gt 0) { return $got[0] }
        Say "That foobar2000 has no profile yet. Start it once, close it, then try again." 'Yellow'
    }
}

$target = $null
if ($Foobar -and $found.Count -eq 1) {
    $target = $found[0]
} elseif ($found.Count -eq 0) {
    Say "Couldn't find foobar2000. (It has to have been started at least once.)" 'Yellow'
    $target = Read-Folder
} else {
    # Even with one found, ask: it may not be the copy the user means.
    $word = if ($found.Count -eq 1) { 'this' } else { 'these' }
    Say "Found $word foobar2000 install$(if ($found.Count -gt 1) { 's' }):"
    for ($i = 0; $i -lt $found.Count; $i++) {
        $what = if ($found[$i].Exe) { Split-Path $found[$i].Exe } else { 'standard install' }
        Say ("  {0}. {1}" -f ($i + 1), $what)
        Say ("     profile: {0}" -f $found[$i].Profile) 'DarkGray'
    }
    Say '  O. Somewhere else'
    $range = if ($found.Count -eq 1) { '1' } else { "1-$($found.Count)" }
    while (-not $target) {
        $n = (Read-Host "Install into which one? ($range, O for another folder, Enter for 1)").Trim().ToLower()
        if ($n -eq '') { $n = '1' }
        if ($n -eq 'o') {
            $target = Read-Folder
            if (-not $target) { exit 1 }
        } elseif ($n -match '^\d+$' -and [int]$n -ge 1 -and [int]$n -le $found.Count) {
            $target = $found[[int]$n - 1]
        }
    }
}
if (-not $target) { exit 1 }

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
$changed = New-Object System.Collections.ArrayList   # @(name, 'added' | 'replaced')

# --- Components ---------------------------------------------------------------

# Where each component comes from. 'github' takes the newest release's
# .fb2k-component; 'fb2k' reads the download link off its foobar2000.org page
# (the link changes with every version); 'url' is a fixed download.
$optional = @(
    @{ Name = 'foo_playcount'; For = 'play counts, the shelves and Listening stats'; Kind = 'fb2k'; Page = 'https://www.foobar2000.org/components/view/foo_playcount' },
    @{ Name = 'foo_enhanced_playcount'; For = 'the time-of-day chart'; Kind = 'fb2k'; Page = 'https://www.foobar2000.org/components/view/foo_enhanced_playcount' },
    @{ Name = 'foo_openlyrics'; For = 'lyrics'; Kind = 'fb2k'; Page = 'https://www.foobar2000.org/components/view/foo_openlyrics' },
    @{ Name = 'foo_outinfo'; For = 'the output side of the signal path'; Kind = 'url'; Page = 'https://foobar.hyv.fi/?view=foo_outinfo'; Url = 'https://foobar.hyv.fi/foo_outinfo.fb2k-component' }
)
$webview = @{ Name = 'foo_ui_webview2'; Kind = 'github'; Repo = $WebViewRepo; Page = "https://github.com/$WebViewRepo/releases" }

$headers = @{ 'User-Agent' = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) fusion-installer' }
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

function Get-DllVersion([string]$dll) {
    try {
        $vi = (Get-Item $dll).VersionInfo
        $s = if ($vi.ProductVersion) { $vi.ProductVersion } else { $vi.FileVersion }
        $m = [regex]::Match($s, '\d+(\.\d+){1,3}')
        if ($m.Success) { return [version]$m.Value }
    } catch { }
    return $null
}

$appComponents = if ($exe) { Join-Path (Split-Path $exe) 'components' } else { $null }
function Test-Installed([string]$name) {
    (Test-Path (Join-Path $componentsDir "$name\$name.dll")) -or
    ($appComponents -and (Test-Path (Join-Path $appComponents "$name.dll")))
}

# The .fb2k-component file for a component: one next to this script if there
# is one, otherwise downloaded. $null if that fails.
function Get-Package($c) {
    $name = $c.Name
    $local = Get-ChildItem -Path $here -Filter "$name*.fb2k-component" -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match ('^' + [regex]::Escape($name) + '([-_.]|$)') } |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($local) {
        Say "  Using $($local.Name) from this folder."
        return $local.FullName
    }
    try {
        switch ($c.Kind) {
            'github' {
                $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$($c.Repo)/releases/latest" -Headers $headers
                $asset = @($rel.assets | Where-Object { $_.name -like '*.fb2k-component' }) | Select-Object -First 1
                if (-not $asset) { throw 'the latest release has no .fb2k-component file' }
                $url = $asset.browser_download_url
            }
            'fb2k' {
                $page = Invoke-WebRequest -Uri $c.Page -Headers $headers -UseBasicParsing
                $m = [regex]::Match($page.Content, 'href="([^"]*/getcomponent/[^"]+?\.fb2k-component)"')
                if (-not $m.Success) { throw "no download link on $($c.Page)" }
                $url = $m.Groups[1].Value
                if ($url.StartsWith('/')) { $url = 'https://www.foobar2000.org' + $url }
            }
            default { $url = $c.Url }
        }
        $file = [IO.Path]::GetFileName(([uri]$url).AbsolutePath)
        if (-not $file.EndsWith('.fb2k-component')) { $file = "$name.fb2k-component" }
        $out = Join-Path $env:TEMP $file
        Say "  Downloading $file ..."
        Invoke-WebRequest -Uri $url -OutFile $out -Headers $headers -UseBasicParsing
        return $out
    } catch {
        Say "  Download failed: $($_.Exception.Message)" 'Red'
        return $null
    }
}

# A .fb2k-component is a zip. 32-bit files sit at the top, with the 64-bit
# DLLs in an x64 folder; anything else at the top (resources, licences) is
# shared. Unpacked into <profile>\user-components(-x64)\<name>, the way
# foobar2000's own Install button does it.
function Expand-Component([string]$package, [string]$name, [string]$into) {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $tmp = Join-Path $env:TEMP ("fusion-" + $name + "-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        $zip = [IO.Compression.ZipFile]::OpenRead($package)
        try {
            foreach ($e in $zip.Entries) {
                $entry = $e.FullName.Replace('\', '/')
                if ($entry.EndsWith('/')) { continue }
                $to = Join-Path $tmp ($entry.Replace('/', '\'))
                New-Item -ItemType Directory -Force -Path (Split-Path $to) | Out-Null
                [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $to, $true)
            }
        } finally { $zip.Dispose() }

        $archDirs = @('x64', 'arm64ec', 'arm64', 'x86')
        if ($arch -ne 'x86' -and -not (Test-Path (Join-Path $tmp "x64\$name.dll"))) {
            throw "the package has no 64-bit build"
        }
        if ($arch -eq 'x86' -and -not (Test-Path (Join-Path $tmp "$name.dll"))) {
            throw "the package has no 32-bit build"
        }
        New-Item -ItemType Directory -Force -Path $into | Out-Null
        foreach ($item in Get-ChildItem $tmp -Force) {
            if ($item.PSIsContainer -and $archDirs -contains $item.Name.ToLower()) { continue }
            # For 64-bit, the 32-bit programs at the top stay behind.
            if ($arch -ne 'x86' -and -not $item.PSIsContainer -and @('.dll', '.exe') -contains $item.Extension.ToLower()) { continue }
            Copy-Item $item.FullName -Destination $into -Recurse -Force
        }
        if ($arch -ne 'x86') {
            Get-ChildItem (Join-Path $tmp 'x64') -Force | Copy-Item -Destination $into -Recurse -Force
        }
    } finally {
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# Download and install one component, backing up the old one. $true if it worked.
function Install-Component($c) {
    $name = $c.Name
    $pkg = Get-Package $c
    if (-not $pkg) { return $false }
    $dir = Join-Path $componentsDir $name
    $action = 'added'
    if (Test-Path $dir) {
        Copy-Item $dir -Destination (Join-Path $backup "components\$name") -Recurse -Force
        Remove-Item $dir -Recurse -Force
        $action = 'replaced'
    }
    try {
        Expand-Component $pkg $name $dir
    } catch {
        Say "  Installing $name failed: $($_.Exception.Message)" 'Red'
        if (Test-Path $dir) { Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue }
        if ($action -eq 'replaced') { Copy-Item (Join-Path $backup "components\$name") -Destination $dir -Recurse -Force }
        return $false
    }
    [void]$changed.Add(@($name, $action))
    Say "  $name installed." 'Green'
    return $true
}

$webviewAdded = $false
Say ''
if ($NoComponent) {
    Say 'Skipping components (-NoComponent).'
} elseif ($arch -eq 'arm64') {
    Say 'This is the ARM build of foobar2000. Install foo_ui_webview2 yourself (File > Preferences > Components > Install...), then run this again with -NoComponent.' 'Yellow'
} else {
    # foo_ui_webview2: needed.
    $dll = Join-Path $componentsDir 'foo_ui_webview2\foo_ui_webview2.dll'
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
        $wasThere = Test-Path $dll
        if (-not (Install-Component $webview)) {
            Fail "Couldn't install foo_ui_webview2. Download the .fb2k-component from $($webview.Page), put it next to install.bat and run it again."
        }
        $webviewAdded = -not $wasThere
    }

    # The optional ones: offered one by one.
    $missing = @($optional | Where-Object { -not (Test-Installed $_.Name) })
    if ($missing.Count -gt 0) {
        Say ''
        Say 'Optional components (Fusion works without them):'
        foreach ($c in $missing) {
            if (Ask ("Install {0} for {1}?" -f $c.Name, $c.For)) {
                if (-not (Install-Component $c)) {
                    Say "  You can get it from $($c.Page)" 'Yellow'
                }
            }
        }
    } else {
        Say 'The optional components are all installed.' 'Green'
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

# One "name|added" or "name|replaced" per line (an array of arrays would
# flatten when there's only one).
$changedLines = ($changed | ForEach-Object { "    $(Quote ($_[0] + '|' + $_[1]))" }) -join ",`r`n"
$u = @"
# Undoes the Fusion install of $stamp.
`$ErrorActionPreference = 'Stop'
`$backup = $(Quote $backup)
`$dest = $(Quote $dest)
`$componentsDir = $(Quote $componentsDir)
`$exe = $(Quote ([string]$exe))
`$restoreTheme = `$$restoreTheme
`$changed = @(
$changedLines
)

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

foreach (`$c in `$changed) {
    if (-not `$c) { continue }
    `$name, `$action = `$c.Split('|')
    `$dir = Join-Path `$componentsDir `$name
    if (Test-Path `$dir) { Remove-Item `$dir -Recurse -Force }
    if (`$action -eq 'replaced') {
        Copy-Item (Join-Path `$backup "components\`$name") -Destination `$dir -Recurse -Force
        Write-Host "Put the previous `$name back." -ForegroundColor Green
    } else {
        Write-Host "Removed `$name." -ForegroundColor Green
        if (`$name -eq 'foo_ui_webview2') { Write-Host '  foobar2000 will ask which interface to use next time it starts.' }
    }
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
Say ''
Say "Backup and uninstall script: $backup"

# --- Last steps ---------------------------------------------------------------

$started = $false
if ($exe -and (Ask "`nStart foobar2000 now?")) {
    Start-Process -FilePath $exe
    $started = $true
}

Say ''
if ($fresh -or $webviewAdded) {
    Say 'Two things left to do in foobar2000:' 'Cyan'
    Say '  1. File > Preferences > Display > Default User Interface: choose WebView2 UI'
    Say '  2. WebView2 UI has no menu bar until Fusion is on: right-click anywhere,'
    Say '     File > Preferences..., then Display > WebView2 UI: set the template to'
    Say '     fusion and click Apply'
} elseif ($started) {
    Say 'All done. Fusion is ready in foobar2000.' 'Cyan'
} else {
    Say 'All done. Start foobar2000 to use Fusion.' 'Cyan'
}

# Stay open (foobar2000 may have opened on top) until these have been read.
Say ''
[void](Read-Host 'Press Enter to close this window')
