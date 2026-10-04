# debugpy vendor fetch script (docs/python_debug_dev_plan.md v1.1 section 3.4).
# Downloads the 5 cp310-cp314 win_amd64 wheels of debugpy, pinned by version +
# sha256 from ci/versions.toml [debugger], extracts and merges them into
# vendor/debugpy/, then strips build artifacts.
#
# Idempotent: skips when vendor/debugpy/.debugpy-vendor-marker matches the
# locked version. Called by build-release.ps1 / build-release.bat before
# `tauri build`; can also be run manually:
#   powershell -ExecutionPolicy Bypass -File .\tools\fetch-debugpy.ps1
#   powershell -File .\tools\fetch-debugpy.ps1 -Force   # ignore cache, refetch
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads BOM-less
# scripts as ANSI(GBK); UTF-8 CJK comment tails can swallow line breaks and
# silently merge code lines into comments (verified on this repo).

param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot   # parent of tools/ = repo root

# PyPI requires TLS 1.2+. Windows PowerShell 5.1 may negotiate older protocols
# depending on machine registry (observed: "The underlying connection was
# closed: An unexpected error occurred on a send.") -- pin TLS 1.2 explicitly.
# No-op on pwsh 7. Keep this block ASCII-only (see file header note).
[Net.ServicePointManager]::SecurityProtocol = `
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Step([string]$msg) {
    Write-Host ""
    Write-Host ("==> " + $msg) -ForegroundColor Cyan
}

function Fail([string]$msg) {
    Write-Host ("ERROR: " + $msg) -ForegroundColor Red
    exit 1
}

# ---------- 1. read ci/versions.toml [debugger] ----------
Step "Read ci/versions.toml [debugger]"

$versionsToml = Join-Path $Root "ci\versions.toml"
if (-not (Test-Path $versionsToml)) {
    Fail "ci/versions.toml not found"
}

# Minimal TOML section parser (key = "value" pairs in [debugger] only).
# -Encoding UTF8 is mandatory: PS 5.1 defaults to ANSI(GBK), whose decoder can
# merge CJK comment tails with the following line breaks (verified pitfall).
$debugger = @{}
$inSection = $false
foreach ($line in Get-Content $versionsToml -Encoding UTF8) {
    $t = $line.Trim()
    if ($t -match '^\[(.+)\]$') { $inSection = ($Matches[1] -eq "debugger"); continue }
    if (-not $inSection) { continue }
    if ($t -match '^([A-Za-z0-9_]+)\s*=\s*"([^"]*)"') {
        $debugger[$Matches[1]] = $Matches[2]
    }
}

$Version = $debugger["debugpy"]
if (-not $Version) { Fail "[debugger] debugpy version missing in ci/versions.toml" }

# tag -> sha256; tag is the wheel's python tag (cp310..cp314)
$Wheels = [ordered]@{
    cp310 = $debugger["debugpy_cp310_win_amd64"]
    cp311 = $debugger["debugpy_cp311_win_amd64"]
    cp312 = $debugger["debugpy_cp312_win_amd64"]
    cp313 = $debugger["debugpy_cp313_win_amd64"]
    cp314 = $debugger["debugpy_cp314_win_amd64"]
}
foreach ($tag in $Wheels.Keys) {
    if (-not $Wheels[$tag]) { Fail "[debugger] debugpy_$($tag)_win_amd64 sha256 missing in ci/versions.toml" }
}

$VendorDir = Join-Path $Root "vendor\debugpy"
$Marker = Join-Path $VendorDir ".debugpy-vendor-marker"

# ---------- 2. idempotency check ----------
if (-not $Force -and (Test-Path $Marker)) {
    $cached = (Get-Content $Marker -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($cached -eq $Version) {
        Write-Host "vendor/debugpy already at locked version $Version, skip (use -Force to refetch)"
        exit 0
    }
}

# ---------- 3. download 5 wheels (sha256-verified one by one) ----------
Step "Download debugpy $Version wheels (cp310-cp314 win_amd64)"

$CacheDir = Join-Path $Root "vendor\.wheels"
New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

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

# Resolve wheel download URLs from the PyPI JSON API once.
$indexUrl = "https://pypi.org/pypi/debugpy/$Version/json"
$wc = New-Object System.Net.WebClient
$wc.Headers.Add("User-Agent", "pylume-fetch-debugpy/1.0")
try {
    $meta = $wc.DownloadString($indexUrl) | ConvertFrom-Json
} catch {
    Fail "failed to fetch PyPI index for debugpy $Version : $($_.Exception.Message)"
}

foreach ($tag in $Wheels.Keys) {
    $fname = "debugpy-$Version-$tag-$tag-win_amd64.whl"
    $dest = Join-Path $CacheDir $fname
    $want = $Wheels[$tag]

    if ((Test-Path $dest) -and ((Get-FileSha256 $dest) -eq $want)) {
        Write-Host "  cached: $fname"
        continue
    }

    $file = $meta.urls | Where-Object { $_.filename -eq $fname } | Select-Object -First 1
    if (-not $file) { Fail "wheel not found on PyPI: $fname" }

    Write-Host "  downloading: $fname"
    try {
        $wc.DownloadFile($file.url, $dest)
    } catch {
        Fail "download failed for $fname : $($_.Exception.Message)"
    }

    $got = Get-FileSha256 $dest
    if ($got -ne $want) {
        Remove-Item $dest -Force
        Fail "sha256 mismatch for $fname`n  expected: $want`n  got:      $got"
    }
    Write-Host "  sha256 ok: $fname"
}

# ---------- 4. extract & merge into vendor/debugpy/ ----------
Step "Extract & merge into vendor/debugpy/"

if (Test-Path $VendorDir) {
    Remove-Item $VendorDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $VendorDir | Out-Null

Add-Type -AssemblyName System.IO.Compression.FileSystem

# Extract a zip overwriting existing entries (.NET Framework's 2-arg
# ExtractToDirectory throws on the first existing file; .py files are
# identical across the 5 wheels so plain overwrite is the desired semantics).
function Expand-ZipOverwrite([string]$zipPath, [string]$destDir) {
    $zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
    try {
        foreach ($entry in $zip.Entries) {
            if ($entry.FullName.EndsWith("/") -or $entry.FullName.EndsWith("\")) { continue }
            $target = Join-Path $destDir $entry.FullName
            $targetDir = Split-Path -Parent $target
            if (-not (Test-Path $targetDir)) {
                New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
            }
            Copy-EntryToFile $entry $target
        }
    } finally { $zip.Dispose() }
}

# Extract a single zip entry to $target, retrying on IOException. Upstream
# ExtractToFile fails hard when the freshly-written target is momentarily locked
# by another process (most often Windows Defender real-time protection on
# Windows) -- this copy-with-retry makes the 5-wheel merge idempotent and robust.
function Copy-EntryToFile($entry, $target) {
    $maxAttempts = 15
    $attempt = 0
    while ($true) {
        try {
            $src = $entry.Open()
            try {
                $buf = New-Object byte[] 65536
                $dst = [System.IO.File]::Open($target, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
                try {
                    while (($read = $src.Read($buf, 0, $buf.Length)) -gt 0) {
                        $dst.Write($buf, 0, $read)
                    }
                } finally { $dst.Dispose() }
            } finally { $src.Dispose() }
            return
        } catch [System.IO.IOException] {
            $attempt++
            if ($attempt -ge $maxAttempts) { throw }
            Start-Sleep -Milliseconds 250
        }
    }
}

foreach ($tag in $Wheels.Keys) {
    $fname = "debugpy-$Version-$tag-$tag-win_amd64.whl"
    $whl = Join-Path $CacheDir $fname
    Write-Host "  merging: $fname"
    # .py files are identical across wheels (overwrite is harmless); .pyd
    # accelerators coexist per python tag (debugpy's official multi-version
    # distribution mechanism).
    Expand-ZipOverwrite $whl $VendorDir
}

# ---------- 5. strip build artifacts ----------
Step "Strip build artifacts (*.c / *.pdb / *.pxd / *.pyx / *.template.pyx / *.hpp / *.cpp / *.bat / __pycache__)"

# Shipped in wheels only by upstream release habit; never loaded at runtime
# (plan section 3.4 option B, ~20.6 MB saved in practice). __pycache__ dirs are
# not in wheels but can appear if the vendored copy was ever executed locally
# (e.g. a spike run) -- strip them so packaging stays clean and reproducible.
$patterns = @("*.c", "*.pdb", "*.pxd", "*.pyx", "*.template.pyx", "*.hpp", "*.cpp", "*.bat")
$removed = 0
foreach ($pat in $patterns) {
    $hits = Get-ChildItem -Path $VendorDir -Recurse -File -Filter $pat -ErrorAction SilentlyContinue
    foreach ($f in $hits) {
        Remove-Item -Path $f.FullName -Force
        $removed++
    }
}
$pycacheDirs = @(Get-ChildItem -Path $VendorDir -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue)
foreach ($d in $pycacheDirs) {
    Remove-Item -Path $d.FullName -Recurse -Force
}
Write-Host ("  removed {0} build artifact file(s) / {1} __pycache__ dir(s)" -f $removed, $pycacheDirs.Count)

# ---------- 6. verify entry point & write marker ----------
Step "Verify & write marker"

$mainPy = Join-Path $VendorDir "debugpy\__main__.py"
if (-not (Test-Path $mainPy)) {
    Fail "vendor/debugpy/debugpy/__main__.py missing (wheel layout changed?)"
}
$pydCount = (Get-ChildItem -Path (Join-Path $VendorDir "debugpy") -Recurse -File -Filter "*.pyd" -ErrorAction SilentlyContinue | Measure-Object).Count
Write-Host ("  __main__.py ok, {0} .pyd accelerator(s) present" -f $pydCount)

Set-Content -Path $Marker -Value $Version -Encoding ASCII
$total = (Get-ChildItem -Path $VendorDir -Recurse -File | Measure-Object).Count
$size = [math]::Round(((Get-ChildItem -Path $VendorDir -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB), 2)
Write-Host "vendor/debugpy ready: $total files, $size MB (debugpy $Version)"
