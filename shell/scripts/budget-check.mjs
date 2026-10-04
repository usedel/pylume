// 体积 / 规模预算门禁（P1-3）
//
// 为什么存在：`style.css` 是 UI 视觉六批唯一逆势增长的文件且此前无任何门槛；
// 巨型文件（main.ts / env_cmds.rs …）也没有"不许再涨"的硬约束。
// 阈值全部显式写在 ci/budgets.toml —— 脚本**不会自动抬阈值**，
// 抬高预算必须是一个显式的、附理由的 PR（单人项目最容易失守的就是这种隐形退让）。
//
// 用法：
//   node shell/scripts/budget-check.mjs              # 断言：超限非零退出（CI / 门禁用）
//   node shell/scripts/budget-check.mjs --report     # 只打印报告，不改退出码（本地观察用）
//   node shell/scripts/budget-check.mjs --no-write   # 不落盘报告文件
//
// 产物：bench/reports/budget-<date>.md（人读格式，与 collect-metrics.ps1 同惯例）
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const argv = new Set(process.argv.slice(2));
const REPORT_ONLY = argv.has("--report");
const NO_WRITE = argv.has("--no-write");

/**
 * 极简 TOML 子集解析：只支持 `[section]` + `key = value`（数值 / 布尔 / 行内注释）。
 * 刻意不引依赖 —— 门禁脚本要在 CI 与本机都能裸 node 跑起来。
 */
function parseToml(text) {
  const root = {};
  let section = root;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    const sec = line.match(/^\[([\w.]+)\]$/);
    if (sec) { root[sec[1]] = section = {}; continue; }
    const kv = line.match(/^([\w]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const [, k, rawV] = kv;
    const v = rawV.trim();
    if (v === "true" || v === "false") section[k] = v === "true";
    else if (/^-?\d+$/.test(v)) section[k] = Number(v);
    else section[k] = v.replace(/^["']|["']$/g, "");
  }
  return root;
}

const cfg = parseToml(readFileSync(join(ROOT, "ci", "budgets.toml"), "utf8"));
const budget = cfg.budget ?? {};
const policy = cfg.policy ?? {};

/** 行数：按换行切分并去掉末尾空段，等价于编辑器显示行数。
 *  （勿用 PowerShell 的 Measure-Object -Line —— 它不计空行，会低估约 15%） */
function lineCount(relPath) {
  const abs = join(ROOT, relPath);
  if (!existsSync(abs)) return null;
  const parts = readFileSync(abs, "utf8").split(/\r?\n/);
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts.length;
}

function countTauriCommands() {
  const dir = join(ROOT, "shell", "src-tauri", "src");
  if (!existsSync(dir)) return null;
  let n = 0;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".rs"))) {
    const text = readFileSync(join(dir, f), "utf8");
    n += (text.match(/#\[tauri::command\]/g) || []).length;
  }
  return n;
}

/** dist 产物（JS + CSS，未压缩原始体积）。dist 不存在返回 null（跳过，不判失败）。 */
function bundleKb() {
  const assets = join(ROOT, "shell", "dist", "assets");
  if (!existsSync(assets)) return null;
  let bytes = 0;
  for (const f of readdirSync(assets)) {
    if (!/\.(js|css)$/.test(f)) continue;
    bytes += statSync(join(assets, f)).size;
  }
  return Math.round(bytes / 1024);
}

const checks = [];
function addLine(relPath, limitKey) {
  const actual = lineCount(relPath);
  const limit = budget[limitKey];
  if (actual == null) { checks.push({ kind: "行数", name: relPath, actual: null, limit, note: "文件不存在，跳过" }); return; }
  checks.push({ kind: "行数", name: relPath, actual, limit, over: actual > limit });
}
function addValue(kind, name, actual, limit, warnOnly) {
  if (actual == null) { checks.push({ kind, name, actual: null, limit, note: "未构建/不可测，跳过" }); return; }
  const over = actual > limit;
  checks.push({ kind, name, actual, limit, over, warnOnly: warnOnly || undefined });
}

addLine("shell/src/style.css", "style_css_max_lines");
addLine("shell/src/main.ts", "main_ts_max_lines");
addLine("shell/src/git.ts", "git_ts_max_lines");
addLine("shell/src/lsp/client.ts", "lsp_client_ts_max_lines");
addLine("shell/src-tauri/src/env_cmds.rs", "env_cmds_rs_max_lines");
addLine("shell/src-tauri/src/fs_cmds.rs", "fs_cmds_rs_max_lines");
addLine("shell/src-tauri/src/git_cmds.rs", "git_cmds_rs_max_lines");
addValue("命令数", "#[tauri::command]", countTauriCommands(), budget.max_tauri_commands, policy.commands_warn_only);
addValue("产物体积(KB)", "shell/dist/assets (JS+CSS)", bundleKb(), budget.max_bundle_kb, false);

// —— 编码卫生：含中文的 .ps1 必须带 UTF-8 BOM ——
//
// 本机 PowerShell 5.1 的 ANSI 代码页是 gb2312。对**无 BOM** 的 .ps1，PS 按 GBK 解码，
// 中文字符被破坏成乱码并引发**语法错误**（实测：`Write-Host "通过（${el}s）"` 变成
// `"閫氳繃锛?{el}s锛?` → `Missing file specification after redirection operator`，脚本直接跑不起来）。
// 仓库既有约定：`bench/collect-metrics.ps1` 是唯一含中文的 .ps1，它就带 BOM。
// 纯 ASCII 的 .ps1 无 BOM 没问题，故只在「有非 ASCII 字节且缺 BOM」时判失败。
const ps1Hygiene = (() => {
  const bad = [];
  const walkPs1 = (dir, depth = 0) => {
    if (depth > 6 || !existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "target", ".git", ".venv", "__pycache__", "dist"].includes(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { walkPs1(p, depth + 1); continue; }
      if (!e.name.endsWith(".ps1")) continue;
      const buf = readFileSync(p);
      const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
      const hasNonAscii = buf.some((b) => b > 127);
      if (hasNonAscii && !hasBom) bad.push(relative(ROOT, p).replace(/\\/g, "/"));
    }
  };
  walkPs1(ROOT);
  return bad;
})();

const breaches = checks.filter((c) => c.over && !c.warnOnly);
const warns = checks.filter((c) => c.over && c.warnOnly);
const head = (() => { try { return execSync("git rev-parse --short HEAD", { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return "?"; } })();

const hygieneOk = ps1Hygiene.length === 0;

const lines = [];
lines.push(`# 预算门禁报告 ${new Date().toISOString()}`);
lines.push("");
lines.push(`- HEAD：\`${head}\``);
lines.push(`- 阈值来源：\`ci/budgets.toml\`（抬高预算须显式 PR + 理由）`);
lines.push(`- 判定：**${breaches.length || !hygieneOk ? "FAIL" : "PASS"}**（超限 ${breaches.length} 项${warns.length ? `，告警 ${warns.length} 项` : ""}${!hygieneOk ? `，编码卫生 ${ps1Hygiene.length} 项违规` : ""}）`);
lines.push("");
lines.push("| 项 | 类别 | 实测 | 上限 | 余量 | 判定 |");
lines.push("|---|---|---|---|---|---|");
for (const c of checks) {
  if (c.actual == null) { lines.push(`| ${c.name} | ${c.kind} | — | ${c.limit ?? "—"} | — | 跳过（${c.note}） |`); continue; }
  const slack = c.limit - c.actual;
  const verdict = !c.over ? "PASS" : c.warnOnly ? "**WARN**" : "**FAIL**";
  lines.push(`| ${c.name} | ${c.kind} | ${c.actual} | ${c.limit} | ${slack >= 0 ? `+${slack}` : slack} | ${verdict} |`);
}
lines.push("");
if (breaches.length) {
  lines.push("## 超限项");
  lines.push("");
  for (const c of breaches) lines.push(`- **${c.name}**：${c.actual} > ${c.limit}（超 ${c.actual - c.limit}）。要么拆分，要么在 \`ci/budgets.toml\` 里显式抬阈值并写清理由。`);
  lines.push("");
}
if (warns.length) {
  lines.push("## 告警项（不阻断）");
  lines.push("");
  for (const c of warns) lines.push(`- **${c.name}**：${c.actual} > ${c.limit}（超 ${c.actual - c.limit}）——已越信号线，应讨论架构对策而非继续涨。`);
  lines.push("");
}
lines.push("> 口径：行数按换行切分计数（含空行）；产物体积为 dist/assets 下 JS+CSS 的未压缩原始体积。");
lines.push("");
lines.push(`## 编码卫生：含中文的 .ps1 必须带 UTF-8 BOM —— ${hygieneOk ? "PASS" : "**FAIL**"}`);
lines.push("");
if (hygieneOk) {
  lines.push("全部 .ps1 合规（有非 ASCII 字节的文件均带 BOM）。");
} else {
  lines.push("以下 .ps1 含非 ASCII 字节但**缺 UTF-8 BOM**，PowerShell 5.1 会按 gb2312 解码导致语法错误：");
  const fixHint = "修复：给文件加 UTF-8 BOM，或改写为纯 ASCII。命令：node -e \"const f=process.argv[1],fs=require('fs'),t=fs.readFileSync(f,'utf8');if(t.charCodeAt(0)!==0xFEFF)fs.writeFileSync(f,'\\uFEFF'+t,'utf8')\" <path>";
  for (const p of ps1Hygiene) lines.push(`- \`${p}\` —— ${fixHint}`);
}
lines.push("");
lines.push("> 本机 PowerShell 5.1 的 ANSI 代码页是 gb2312；`bench/collect-metrics.ps1` 是仓库里唯一含中文的 .ps1，它就带 BOM——沿用该约定。");

const report = lines.join("\r\n");
console.log(`\n[budget] HEAD=${head}`);
for (const c of checks) {
  if (c.actual == null) { console.log(`  跳过  ${c.name}（${c.note}）`); continue; }
  const tag = !c.over ? "PASS" : c.warnOnly ? "WARN" : "FAIL";
  console.log(`  ${tag.padEnd(4)}  ${c.name.padEnd(38)} ${String(c.actual).padStart(6)} / ${c.limit}`);
}
console.log(`  ${hygieneOk ? "PASS" : "FAIL"}  ${".ps1 编码卫生（中文需 BOM）".padEnd(38)} ${ps1Hygiene.length === 0 ? "无违规" : ps1Hygiene.length + " 个违规"}`);

if (!NO_WRITE) {
  const dir = join(ROOT, "bench", "reports");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:]/g, "").slice(0, 15);
  const p = join(dir, `budget-${stamp}.md`);
  writeFileSync(p, report, "utf8");
  console.log(`\n[budget] 报告：${p}`);
}

if (REPORT_ONLY) { console.log('[budget] --report 模式，不改退出码'); process.exit(0); }
if (breaches.length) {
  console.error(`\n[budget] 超限 ${breaches.length} 项，FAIL`);
  process.exit(1);
}
if (!hygieneOk) {
  console.error(`\n[budget] 编码卫生 FAIL：${ps1Hygiene.length} 个含中文的 .ps1 缺 UTF-8 BOM：`);
  for (const p of ps1Hygiene) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`\n[budget] 全部达标${warns.length ? `（另有 ${warns.length} 项告警）` : ""}`);
