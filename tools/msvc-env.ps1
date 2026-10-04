# MSVC 生成环境装配（供 build-release.ps1 dot-source 使用）
#
# 用法（在调用方脚本里）：
#   . (Join-Path $Root "tools\msvc-env.ps1")
#   Import-MsvcEnv
#
# 背景（bench/reports/release-build-blocker.md）：
#   Tauri CLI 用自己的 MSVC 探测覆盖 rustc 的探测结果。本机曾装有 VS2015 RTM，
#   其 VC\lib 既无 ucrt.lib 也无 __imp_* 导入符号，于是 release 链接 bundled SQLite
#   的 sqlite3.o 时报 LNK2019 unresolved external symbol __imp_memchr / __imp_strchr /
#   __imp_strrchr。三个符号都来自 UCRT —— UCRT 自 VS2015 后期起随 Windows SDK 分发，
#   不在 MSVC 自己的 lib 目录里。
#
# 因此这里做三件事（缺一不可）：
#   1. 用 vswhere 定位「带 VC 工具集」的 VS 2022 / BuildTools，把它的 link.exe
#      所在目录前置到 PATH —— rustc 与 tauri CLI 都是从 PATH 找 link.exe 的；
#   2. 把 Windows SDK 的 ucrt\x64 与 um\x64 导入库复制到**无空格**暂存目录再喂给 LIB：
#      link.exe 从 LIB 找 ucrt.lib，而含空格的 /LIBPATH 经 rustc 转发后引号会被剥掉、
#      路径在空格处截断（表现为 LNK1181 找不到 "Files.obj"）；
#   3. 顺带设 INCLUDE，避免 cl.exe / cc-rs 找不到 SDK 头文件。
#
# 只改当前进程环境，不写系统注册表、不改用户 PATH。

function Import-MsvcEnv {
    param(
        # SDK 导入库暂存目录；必须无空格，若含空格则自动回退到 C 盘根目录
        [string]$StageDir = (Join-Path $env:LOCALAPPDATA "Pylume\msvc-lib")
    )

    $ErrorActionPreference = "Continue"

    # ---------- 1. 定位 VS / BuildTools（必须含 VC 工具集） ----------
    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path $vswhere)) {
        throw "vswhere.exe not found at $vswhere - install Visual Studio 2022 Build Tools (with Desktop development with C++ / MSVC v143)"
    }
    $vs = @(& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath) |
        Where-Object { $_ -and $_.Trim() } | Select-Object -First 1
    if (-not $vs) {
        throw "no Visual Studio instance with VC tools found - install VS 2022 Build Tools with workload Microsoft.VisualStudio.Workload.VCTools"
    }
    $vs = $vs.Trim()

    $msvcRoot = Join-Path $vs "VC\Tools\MSVC"
    if (-not (Test-Path $msvcRoot)) { throw "MSVC toolset dir not found: $msvcRoot" }
    $toolset = Get-ChildItem $msvcRoot -Directory |
        Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1

    $bin = Join-Path $toolset.FullName "bin\Hostx64\x64"
    $msvcLib = Join-Path $toolset.FullName "lib\x64"
    $msvcInclude = Join-Path $toolset.FullName "include"
    if (-not (Test-Path (Join-Path $bin "link.exe"))) { throw "link.exe not found: $bin" }

    # ---------- 2. 定位 Windows SDK（要有 ucrt\x64\ucrt.lib） ----------
    $kitsRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10"
    $libRoot = Join-Path $kitsRoot "Lib"
    $sdkVer = Get-ChildItem $libRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { Test-Path (Join-Path $_.FullName "ucrt\x64\ucrt.lib") } |
        Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
    if (-not $sdkVer) { throw "no Windows SDK with ucrt\x64\ucrt.lib under $libRoot" }
    $sdkLib = $sdkVer.FullName
    $sdkInclude = Join-Path $kitsRoot "Include\$($sdkVer.Name)"

    # ---------- 3. 暂存 SDK 导入库到无空格目录 ----------
    if ($StageDir -match "\s") { $StageDir = "C:\pylume-msvc-lib" }
    $stageX64 = Join-Path $StageDir "x64"
    New-Item -ItemType Directory -Force -Path $stageX64 | Out-Null
    foreach ($sub in @("ucrt", "um")) {
        $src = Join-Path $sdkLib "$sub\x64"
        if (-not (Test-Path $src)) { continue }
        & robocopy $src $stageX64 "*.lib" /XO /NJH /NJS /NFL /NDL /NP | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "robocopy failed: $src -> $stageX64 (exit $LASTEXITCODE)" }
    }
    if (-not (Test-Path (Join-Path $stageX64 "ucrt.lib"))) {
        throw "ucrt.lib missing after staging: $stageX64"
    }

    # ---------- 4. 写入当前进程环境 ----------
    $env:PATH = "$bin;$env:PATH"
    $env:LIB = "$stageX64;$msvcLib"
    $env:INCLUDE = "$msvcInclude;$sdkInclude\ucrt;$sdkInclude\um;$sdkInclude\shared;$sdkInclude\winrt;$env:INCLUDE"

    Write-Host ("  VS      : {0}" -f $vs)
    Write-Host ("  toolset : {0}" -f $toolset.Name)
    Write-Host ("  link.exe: {0}" -f (Join-Path $bin "link.exe"))
    Write-Host ("  SDK     : {0}" -f $sdkVer.Name)
    Write-Host ("  LIB     : {0}" -f $env:LIB)
}
