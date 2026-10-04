# Pylume bench 指标采集脚本（S1-T07；A-4 补项：长跑内存增长红线）
# 用法：powershell -File bench/collect-metrics.ps1 [-Runs 3] [-SoakMinutes 10]
# 产出：冷启动时间 + 内存（主进程 + WebView2 子进程）+ 可选长跑内存采样，
#       写入 bench/reports/metrics-<date>.md；任一红线破则非零退出（供 CI 门禁复用）。
#
# A-4 红线口径（调研报告 §6-A-4）：
#   · 冷启动 < 1500 ms、合计内存 ≤ 600 MB（既有）；
#   · 长跑内存增长： soak 期（默认 10 分钟）内「暖机后首次采样 → 末次采样」的
#     合计内存增量 ≤ 150 MB（无界增长红旗；输出洪峰场景的内存有界性由
#     e2e/perf/01-output-guard.spec.ts（环形缓冲 5000 行 + 背压队列）与
#     e2e/perf/03-large-file.spec.ts（2MB 文件打开耗时）分别钉住，本脚本不重复驱动 UI）。

param(
    [int]$Runs = 3,
    [string]$Exe = "$PSScriptRoot\..\shell\src-tauri\target\release\pylume-shell.exe",
    [int]$SoakMinutes = 0
)

$ErrorActionPreference = "Stop"
$exe = (Resolve-Path $Exe).Path
if (-not (Test-Path $exe)) { Write-Error "找不到 $exe（先跑 cargo build --release）"; exit 1 }

# 进程树合计内存（MB）：主进程 + WebView2 后代（与启动段的树遍历同一口径）
function Get-TreeMemoryMB([System.Diagnostics.Process]$Proc) {
    $allWv = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'"
    $ids = @($Proc.Id)
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($p in $allWv) {
            if ($ids -contains $p.ParentProcessId -and -not ($ids -contains $p.ProcessId)) {
                $ids += $p.ProcessId
                $changed = $true
            }
        }
    }
    $wvProcs = $allWv | Where-Object { $ids -contains $_.ProcessId }
    $wvMb = 0
    if ($wvProcs) { $wvMb = [math]::Round(($wvProcs | Measure-Object WorkingSetSize -Sum).Sum / 1MB, 0) }
    $Proc.Refresh()
    $mainMb = [math]::Round($Proc.WorkingSet64 / 1MB, 0)
    return $mainMb + $wvMb
}

$results = @()
for ($i = 1; $i -le $Runs; $i++) {
    # 清理旧实例
    Get-Process pylume-shell -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Milliseconds 500

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $proc = Start-Process $exe -PassThru
    # 轮询等待主窗口出现（比固定 sleep 准确）
    while (-not $proc.MainWindowHandle -or $proc.MainWindowHandle -eq 0) {
        Start-Sleep -Milliseconds 50
        $proc.Refresh()
        if ($sw.ElapsedMilliseconds -gt 30000) { break }
    }
    $sw.Stop()
    $startupMs = $sw.ElapsedMilliseconds

    # 等待 WebView2 子进程稳定
    Start-Sleep -Seconds 4
    $proc.Refresh()
    $mainMb = [math]::Round($proc.WorkingSet64 / 1MB, 0)

    # WebView2 子进程树（主进程的直接子进程 + 其后代）
    $allWv = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'"
    $wvIds = @($proc.Id)
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($p in $allWv) {
            if ($wvIds -contains $p.ParentProcessId -and -not ($wvIds -contains $p.ProcessId)) {
                $wvIds += $p.ProcessId
                $changed = $true
            }
        }
    }
    $wvProcs = $allWv | Where-Object { $wvIds -contains $_.ProcessId }
    $wvMb = [math]::Round(($wvProcs | Measure-Object WorkingSetSize -Sum).Sum / 1MB, 0)

    $totalMb = $mainMb + $wvMb
    $results += [PSCustomObject]@{
        Run = $i; StartupMs = $startupMs; MainMB = $mainMb; WebViewMB = $wvMb; TotalMB = $totalMb
    }
    Write-Host ("run {0}: startup={1}ms main={2}MB webview={3}MB total={4}MB" -f $i, $startupMs, $mainMb, $wvMb, $totalMb)

    Get-Process pylume-shell -ErrorAction SilentlyContinue | Stop-Process -Force
}

# 汇总
$avgStartup = [math]::Round(($results | Measure-Object StartupMs -Average).Average, 0)
$avgTotal = [math]::Round(($results | Measure-Object TotalMB -Average).Average, 0)
$avgMain = [math]::Round(($results | Measure-Object MainMB -Average).Average, 0)
$avgWv = [math]::Round(($results | Measure-Object WebViewMB -Average).Average, 0)

# ---------- A-4 补项：长跑内存增长（soak） ----------
$soakGrowthMb = $null
$soakSamples = @()
if ($SoakMinutes -gt 0) {
    Write-Host ""
    Write-Host ("=== 长跑内存采样（{0} 分钟，暖机 60s，每 30s 一采）===" -f $SoakMinutes)
    Get-Process pylume-shell -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Milliseconds 500
    $soakProc = Start-Process $exe -PassThru
    Start-Sleep -Seconds 60   # 暖机：等 Monaco / 引擎等子进程全部就位后再取基线
    $firstMb = Get-TreeMemoryMB $soakProc
    $soakSamples += [PSCustomObject]@{ At = "warmup"; TotalMB = $firstMb }
    Write-Host ("warmup: {0} MB" -f $firstMb)
    $deadline = (Get-Date).AddMinutes($SoakMinutes)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 30
        $mb = Get-TreeMemoryMB $soakProc
        $soakSamples += [PSCustomObject]@{ At = (Get-Date -Format "HH:mm:ss"); TotalMB = $mb }
        Write-Host ("{0}: {1} MB" -f $soakSamples[-1].At, $mb)
    }
    $lastMb = $soakSamples[-1].TotalMB
    $soakGrowthMb = $lastMb - $firstMb
    Get-Process pylume-shell -ErrorAction SilentlyContinue | Stop-Process -Force
    Write-Host ("长跑内存增量: {0} MB（红线 <= 150 MB）" -f $soakGrowthMb)
}

Write-Host ""
Write-Host ("=== 汇总（{0} 次平均）===" -f $Runs)
Write-Host ("冷启动: {0} ms（红线 < 1500 ms）" -f $avgStartup)
Write-Host ("内存: 主 {0} + WebView2 {1} = {2} MB（红线 <= 600 MB）" -f $avgMain, $avgWv, $avgTotal)

# 报告落盘
$reportDir = Join-Path $PSScriptRoot "reports"
New-Item -ItemType Directory -Force $reportDir | Out-Null
$date = Get-Date -Format "yyyyMMdd-HHmmss"

$rows = foreach ($r in $results) {
    ('| {0} | {1} | {2} | {3} | {4} |' -f $r.Run, $r.StartupMs, $r.MainMB, $r.WebViewMB, $r.TotalMB)
}
$startupVerdict = if ($avgStartup -lt 1500) { "PASS" } else { "FAIL" }
$memVerdict = if ($avgTotal -le 600) { "PASS" } else { "FAIL" }
# A-4：长跑增长红线（仅 -SoakMinutes > 0 时参与判定）
$soakVerdict = if ($null -eq $soakGrowthMb) { "SKIP" } elseif ($soakGrowthMb -le 150) { "PASS" } else { "FAIL" }

$reportLines = @(
    "# bench 指标报告 $date",
    "",
    ('| 次数 | 冷启动 (ms) | 主进程 (MB) | WebView2 (MB) | 合计 (MB) |'),
    ('|---|---|---|---|---|')
)
$reportLines += $rows
$reportLines += @(
    ('| **平均** | **{0}** | **{1}** | **{2}** | **{3}** |' -f $avgStartup, $avgMain, $avgWv, $avgTotal),
    ""
)
if ($null -ne $soakGrowthMb) {
    $reportLines += @(
        "## 长跑内存采样（$SoakMinutes 分钟）",
        "",
        ('| 时间 | 合计 (MB) |'),
        ('|---|---|')
    )
    foreach ($s in $soakSamples) { $reportLines += ('| {0} | {1} |' -f $s.At, $s.TotalMB) }
    $reportLines += @(
        "",
        ("- 长跑内存增量：{0} MB（红线 <= 150 MB）——判定 {1}" -f $soakGrowthMb, $soakVerdict),
        ""
    )
}
$reportLines += @(
    ("- 红线：冷启动 1500 ms 以内；内存 600 MB 以内（技术方案 v3 §1.1）；长跑增长 150 MB 以内（A-4）"),
    ("- 判定：冷启动 {0}；内存 {1}；长跑 {2}" -f $startupVerdict, $memVerdict, $soakVerdict)
)
$report = $reportLines -join "`r`n"
$reportPath = Join-Path $reportDir "metrics-$date.md"
Set-Content -Path $reportPath -Value $report -Encoding UTF8
Write-Host "报告已写入: $reportPath"

# 红线纳入断言（tech-debt #7，供 CI 门禁复用）：任一红线破则非零退出
if ($startupVerdict -eq "FAIL" -or $memVerdict -eq "FAIL" -or $soakVerdict -eq "FAIL") {
    Write-Host "bench 红线未达标：冷启动 $startupVerdict / 内存 $memVerdict / 长跑 $soakVerdict" -ForegroundColor Red
    exit 1
}
Write-Host "bench 红线达标：冷启动 PASS / 内存 PASS / 长跑 $soakVerdict" -ForegroundColor Green
