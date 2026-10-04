# JetBrains Mono font fetch script (docs/ui_premium_dev_plan.md batch 3).
# Downloads @fontsource/jetbrains-mono from the npm registry, verifies every
# file against the sha256 values locked in ci/versions.toml [fonts], then
# extracts 4 woff2 subsets + the OFL license into shell/public/fonts/.
#
# Unlike tools/fetch-debugpy.ps1 the output is COMMITTED rather than
# gitignored: @font-face resolves fonts through URLs, so they must ship next
# to the frontend bundle (see the rationale block in ci/versions.toml [fonts]).
# fetch-debugpy.ps1 can use vendor/ + bundle.resources because it is read from
# the Rust side as a filesystem path, not over HTTP.
#
# Idempotent: re-hashes what is already on disk and exits early when all five
# files match the locked values. -Force refetches even if the cache is warm.
#   powershell -ExecutionPolicy Bypass -File .\tools\fetch-fonts.ps1
#   powershell -File .\tools\fetch-fonts.ps1 -Force
#
# Requires tar.exe (bundled with Windows 10 1803+): the npm package is a .tgz,
# and System.IO.Compression on .NET Framework 4.x has no tar reader.
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads BOM-less
# scripts as ANSI(GBK); UTF-8 CJK comment tails can swallow line breaks and
# silently merge code lines into comments (verified on this repo).

param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot   # parent of tools/ = repo root

function Step([string]$msg) {
    Write-Host ""
    Write-Host ("==> " + $msg) -ForegroundColor Cyan
}

function Fail([string]$msg) {
    Write-Host ("ERROR: " + $msg) -ForegroundColor Red
    exit 1
}

function Get-FileSha256([string]$path) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $stream = [System.IO.File]::OpenRead($path)
        try {
            $hash = $sha.ComputeHash($stream)
            return ([BitConverter]::ToString($hash) -replace "-", "").ToLowerInvariant()
        } finally { $stream.Dispose() }
    } finally { $sha.Dispose() }
}

# ---------- 1. read ci/versions.toml [fonts] ----------
Step "Read ci/versions.toml [fonts]"

$versionsToml = Join-Path $Root "ci\versions.toml"
if (-not (Test-Path $versionsToml)) {
    Fail "ci/versions.toml not found"
}

# Minimal TOML section parser (key = "value" pairs in [fonts] only).
# -Encoding UTF8 is mandatory: PS 5.1 defaults to ANSI(GBK), whose decoder can
# merge CJK comment tails with the following line breaks (verified pitfall).
$fonts = @{}
$inSection = $false
foreach ($line in Get-Content $versionsToml -Encoding UTF8) {
    $t = $line.Trim()
    if ($t -match '^\[(.+)\]$') { $inSection = ($Matches[1] -eq "fonts"); continue }
    if (-not $inSection) { continue }
    if ($t -match '^([A-Za-z0-9_]+)\s*=\s*"([^"]*)"') {
        $fonts[$Matches[1]] = $Matches[2]
    }
}

$Version = $fonts["jetbrains_mono"]
if (-not $Version) { Fail "[fonts] jetbrains_mono version missing in ci/versions.toml" }

# key in versions.toml -> @{ pkg = path inside the npm tarball; out = filename in shell/public/fonts }
$Files = [ordered]@{
    jetbrains_mono_latin_400_normal   = @{ pkg = "package/files/jetbrains-mono-latin-400-normal.woff2";   out = "JetBrainsMono-latin-400-normal.woff2" }
    jetbrains_mono_latin_400_italic   = @{ pkg = "package/files/jetbrains-mono-latin-400-italic.woff2";   out = "JetBrainsMono-latin-400-italic.woff2" }
    jetbrains_mono_latin_700_normal   = @{ pkg = "package/files/jetbrains-mono-latin-700-normal.woff2";   out = "JetBrainsMono-latin-700-normal.woff2" }
    jetbrains_mono_latin_ext_400_normal = @{ pkg = "package/files/jetbrains-mono-latin-ext-400-normal.woff2"; out = "JetBrainsMono-latin-ext-400-normal.woff2" }
    jetbrains_mono_ofl                = @{ pkg = "package/LICENSE";                                          out = "OFL.txt" }
}
foreach ($key in $Files.Keys) {
    if (-not $fonts[$key]) { Fail "[fonts] $key sha256 missing in ci/versions.toml" }
}

$OutDir = Join-Path $Root "shell\public\fonts"

# ---------- 2. idempotency check (hash what is already on disk) ----------
if (-not $Force) {
    $stale = @()
    foreach ($key in $Files.Keys) {
        $dest = Join-Path $OutDir $Files[$key].out
        if (-not (Test-Path $dest)) {
            $stale += $Files[$key].out
        } elseif ((Get-FileSha256 $dest) -ne $fonts[$key]) {
            $stale += $Files[$key].out
        }
    }
    if ($stale.Count -eq 0) {
        Write-Host "shell/public/fonts already matches the locked sha256 set ($($Files.Count) files), skip (use -Force to refetch)"
        exit 0
    }
    Write-Host ("stale/missing: " + ($stale -join ", "))
}

# ---------- 3. download the npm tarball (sha256 verified) ----------
Step "Download @fontsource/jetbrains-mono $Version"

$CacheDir = Join-Path $Root "ci\.cache\fonts"
New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
$tgz = Join-Path $CacheDir "jetbrains-mono-$Version.tgz"

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$expectedSize = $fonts["jetbrains_mono_tgz"]
if ($expectedSize) {
    if ((Test-Path $tgz) -and ((Get-FileSha256 $tgz) -ne $expectedSize)) {
        Remove-Item $tgz -Force
    }
}

if (-not (Test-Path $tgz)) {
    # Scoped package tarball URL is stable across versions:
    # https://registry.npmjs.org/@fontsource/<name>/-/<name>-<version>.tgz
    $url = "https://registry.npmjs.org/@fontsource/jetbrains-mono/-/jetbrains-mono-$Version.tgz"
    Write-Host "  downloading: $url"
    $wc = New-Object System.Net.WebClient
    $wc.Headers.Add("User-Agent", "pylume-fetch-fonts/1.0")
    try {
        $wc.DownloadFile($url, $tgz)
    } catch {
        Fail "download failed for @fontsource/jetbrains-mono $Version : $($_.Exception.Message)"
    } finally {
        $wc.Dispose()
    }
    if ($expectedSize) {
        $got = Get-FileSha256 $tgz
        if ($got -ne $expectedSize) {
            Remove-Item $tgz -Force
            Fail "tarball sha256 mismatch`n  expected: $expectedSize`n  got:      $got"
        }
        Write-Host "  tarball sha256 ok"
    }
} else {
    Write-Host "  cached: $(Split-Path -Leaf $tgz)"
}

# ---------- 4. extract ----------
Step "Extract into shell/public/fonts/"

if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) {
    Fail "tar.exe not found (needed to unpack the .tgz; ships with Windows 10 1803+)"
}

$work = Join-Path $CacheDir "unpack-$Version"
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Force -Path $work | Out-Null

# -C keeps extraction scoped to $work so a zip-slip style entry cannot land
# outside the cache dir. bsdtar on Windows returns 0 for a clean unpack.
$tarOut = & tar.exe -xzf $tgz -C $work 2>&1
if ($LASTEXITCODE -ne 0) {
    Fail "tar failed to unpack $tgz`n$tarOut"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

foreach ($key in $Files.Keys) {
    $entry = $Files[$key]
    $src = Join-Path $work ($entry.pkg -replace "/", "\")
    if (-not (Test-Path $src)) {
        Fail "entry missing in tarball: $($entry.pkg) (package layout changed?)"
    }
    # Windows Defender can hold a freshly written file open for a moment;
    # retry the copy so a transient IOException does not fail the run.
    $dest = Join-Path $OutDir $entry.out
    $attempt = 0
    while ($true) {
        try {
            Copy-Item -Path $src -Destination $dest -Force
            break
        } catch [System.IO.IOException] {
            $attempt++
            if ($attempt -ge 15) { throw }
            Start-Sleep -Milliseconds 250
        }
    }
    $got = Get-FileSha256 $dest
    if ($got -ne $fonts[$key]) {
        Fail "sha256 mismatch after extract: $($entry.out)`n  expected: $($fonts[$key])`n  got:      $got"
    }
    $kb = [math]::Round((Get-Item $dest).Length / 1KB, 1)
    Write-Host ("  ok: {0} ({1} KB)" -f $entry.out, $kb)
}

Remove-Item $work -Recurse -Force

# ---------- 5. summary ----------
$total = (Get-ChildItem -Path $OutDir -File | Measure-Object -Property Length -Sum).Sum
$count = (Get-ChildItem -Path $OutDir -File | Measure-Object).Count
Write-Host ""
Write-Host ("shell/public/fonts ready: {0} files, {1} KB (@fontsource/jetbrains-mono {2}; upstream JetBrains Mono version noted in ci/versions.toml)" -f $count, [math]::Round($total / 1KB, 1), $Version)
Write-Host "next: style.css @font-face must reference these files as /fonts/<name>.woff2"
