<#
.SYNOPSIS
  真机 CDP 验收「一键全量跑批」+ 汇总报告（improvement_and_roadmap_report.md §2 P0-1 子项 2/3 的本机入口）。

.DESCRIPTION
  9 个真机脚本逐个串行跑（串行是必须的：它们共用 vite 5173 与 CDP 9223，并发必撞），
  每个脚本通过 OC_JSON_OUT 落一份 JSON 汇总（schema 见 lib/real-env.cjs），最后合并成一份 Markdown 报告。

  这是 nightly.yml 的**本机同款实现**——nightly 跑的是同一份脚本清单，因此本机报告与
  CI nightly 产物 schema 一致，可直接跨次对比。

  失败语义与 nightly 一致：**只汇总、不阻断**（除非 -Strict）。

.EXAMPLE
  powershell -File shell/e2e-real/run-real-all.ps1
.EXAMPLE
  powershell -File shell/e2e-real/run-real-all.ps1 -Only db-real -CdpTimeoutSec 1800
#>
param(
  [string]$Only = "",
  [string]$Skip = "probe-real-lag,probe-mw-lag,probe-watch-multiwin",
  [int]$CdpTimeoutSec = 1500,
  [switch]$Strict,
  [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"
$RealDir = $PSScriptRoot
$ShellDir = (Resolve-Path (Join-Path $RealDir "..")).Path

# —— 套件清单（nightly.yml 的 $scripts 与此保持一致）——
$All = @(
  "db-real", "debug-real", "endpoints-real", "multi-window-real",
  "new-project-fastapi-real", "probe-real-lag", "probe-mw-lag",
  "probe-watch-multiwin", "ui-real"
)

if ($Only) {
  $want = @($Only.Split(",") | ForEach-Object { $_.Trim().Replace(".cjs", "") } | Where-Object { $_ })
  $Scripts = @($All | Where-Object { $want -contains $_ })
} else {
  $skipList = @()
  if ($Skip) { $skipList = @($Skip.Split(",") | ForEach-Object { $_.Trim().Replace(".cjs", "") } | Where-Object { $_ }) }
  $Scripts = @($All | Where-Object { $skipList -notcontains $_ })
}

if ($Scripts.Count -eq 0) { Write-Host "没有选中任何套件（-Only / -Skip 拼写是否有误？）" -ForegroundColor Red; exit 2 }

if (-not $OutDir) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $OutDir = Join-Path $ShellDir "real-reports\$stamp"
}
New-Item -ItemType Directory -Force $OutDir | Out-Null

Write-Host "=========================================================="
Write-Host " 真机全量验收  共 $($Scripts.Count) 个套件"
Write-Host " 清单：$($Scripts -join ', ')"
Write-Host " 报告：$OutDir"
Write-Host " CDP 超时：${CdpTimeoutSec}s   严格模式：$Strict"
Write-Host "=========================================================="

# 预检：端口被占用直接停（否则每个脚本都会各自 exit 2，白等一轮编译）
foreach ($port in @(5173, 9223)) {
  $busy = Test-NetConnection -ComputerName 127.0.0.1 -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue
  if ($busy) {
    Write-Host "端口 $port 已被占用。请先停掉 tauri dev / 上一次真机会话（真机脚本共用这两个端口，必须串行）。" -ForegroundColor Red
    exit 2
  }
}

$env:OC_CDP_TIMEOUT = "$CdpTimeoutSec"
$fail = 0
$missing = @()

foreach ($s in $Scripts) {
  $cjs = Join-Path $RealDir "$s.cjs"
  if (-not (Test-Path $cjs)) { $missing += $s; continue }
  Write-Host ""
  Write-Host "########## $s ##########"
  $env:OC_JSON_OUT = Join-Path $OutDir "$s.json"
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  Push-Location $ShellDir
  try {
    & node $cjs
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  $sw.Stop()
  $el = [int]$sw.Elapsed.TotalSeconds
  if ($code -ne 0) { $fail++; Write-Host ">>> $s 退出码 $code（${el}s）" -ForegroundColor Yellow }
  else { Write-Host ">>> $s 通过（${el}s）" -ForegroundColor DarkGreen }
  Remove-Item Env:\OC_JSON_OUT -ErrorAction SilentlyContinue
}

# —— 合并汇总 ——
$rows = @("| 套件 | 通过 | 失败 | 总数 | 用时 | 结论 |", "|---|---|---|---|---|---|")
$totalCases = 0
$totalFailed = 0
foreach ($s in $Scripts) {
  $j = Join-Path $OutDir "$s.json"
  if (-not (Test-Path $j)) {
    $verdict = if ($missing -contains $s) { "跳过（脚本不存在）" } else { "无报告（未启动？）" }
    $rows += "| $s | — | — | — | — | $verdict |"
    continue
  }
  $data = Get-Content $j -Raw -Encoding UTF8 | ConvertFrom-Json
  $totalCases += $data.total
  $totalFailed += $data.failed
  $verdict = if ($data.ok) { "PASS" } elseif ($data.error) { "ENV（$($data.error)）" } else { "FAIL" }
  $dur = if ($data.durationMs) { "$([int]($data.durationMs / 1000))s" } else { "—" }
  $rows += "| $s | $($data.total - $data.failed) | $($data.failed) | $($data.total) | $dur | $verdict |"
}
$rows += "| **合计** | **$($totalCases - $totalFailed)** | **$totalFailed** | **$totalCases** | — | — |"

$head = (git -C $ShellDir rev-parse --short HEAD 2>$null)
$report = @(
  "# 真机验收汇总 $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')",
  "",
  "- HEAD：``$head``",
  "- 跑批：``shell/e2e-real/run-real-all.ps1``（套件清单与 ``.github/workflows/nightly.yml`` 一致）",
  "- 判定：失败 $fail 个套件；用例 $totalCases 项 / 失败 $totalFailed 项",
  "",
  ($rows -join "`r`n"),
  "",
  "> 逐项明细见同目录各 ``<suite>.json`` 的 ``cases`` 数组（含每项 detail）。",
  "> 端口 5173 / 9223 为真机脚本共用，**必须串行**；`ENV` 表示预检未通过（如解释器路径未设 OC_REAL_PYTHON）。"
)
$reportPath = Join-Path $OutDir "SUMMARY.md"
$report | Set-Content $reportPath -Encoding UTF8

Write-Host ""
Write-Host "=========================================================="
Write-Host " 汇总：$($Scripts.Count) 套件 / $totalCases 项 / 失败 $totalFailed 项 / 套件失败 $fail"
Write-Host " 报告：$reportPath"
Write-Host "=========================================================="

if ($Strict -and $fail -gt 0) { exit 1 }
exit 0
