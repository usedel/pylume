// 仓库规模取数（improvement_and_roadmap_report.md §9 承诺的反过期机制）
//
// 为什么需要这个脚本：报告里的每个数字都是快照，取数口径一旦出错就会**静默传播**
// （v1.1 曾用 `Get-Content $f` 取行数，在 ANSI=gb2312 的机器上被 GBK 解码吞掉 4.5%~13% 的行，
//  得出"UI 六批顺带把 main.ts 从 2,839 降到 2,503"的假结论——实际同期是 +58）。
// 把口径写进代码而不是写进文档，才不会在下一次取数时重犯。
//
// 用法：
//   node tools/stats/repo-stats.mjs              # 打印 + 落盘 bench/reports/stats-<date>.md
//   node tools/stats/repo-stats.mjs --no-write   # 只打印
//
// 口径（唯一实现，别处不要另写）：
//   · 行数 = 按 LF 切分段数（含空行）；文件以 LF 结尾时等于 LF 字节数，否则 +1。
//     **不要用 PowerShell 的 `Get-Content $f`（无 -Encoding）** —— 见文件头警告。
//   · 范围：src 下排除 `__tests__` / `*.test.ts` / `e2e`；与报告 §1.1 各行一一对应。
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const NO_WRITE = process.argv.includes("--no-write");

/** 按 LF 切分计行（含空行）。CR=0 的仓库里 \r?\n 与 \n 等价，但保留 \r? 更通用。 */
function lineCount(abs) {
  const parts = readFileSync(abs, "utf8").split(/\r?\n/);
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts.length;
}

/** 递归收集目录下匹配后缀的文件（跳过排除目录） */
function walk(dir, exts, skipDirs = new Set()) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!skipDirs.has(e.name)) out.push(...walk(p, exts, skipDirs)); continue; }
    if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

const sum = (files) => files.reduce((n, f) => n + lineCount(f), 0);
const bytes = (files) => files.reduce((n, f) => n + statSync(f).size, 0);
const mb = (n) => (n / 1024 / 1024).toFixed(1) + " MB";

// —— 各层规模（对应报告 §1.1 表）——
const srcTs = walk(join(ROOT, "shell", "src"), [".ts"], new Set(["__tests__"]))
  .filter((f) => !f.endsWith(".test.ts"));
const topTs = srcTs.filter((f) => dirname(f) === join(ROOT, "shell", "src"));
const srcCss = walk(join(ROOT, "shell", "src"), [".css"]);
const styleCss = join(ROOT, "shell", "src", "style.css");
const rustShell = walk(join(ROOT, "shell", "src-tauri", "src"), [".rs"]);
const rustIntel = walk(join(ROOT, "intel"), [".rs"], new Set(["target"])).filter((f) => f.includes(`${"src"}`) || !f.includes("target"));
const pyProbe = walk(join(ROOT, "probe"), [".py"], new Set(["__pycache__", ".venv", "tests"]));
const testTs = walk(join(ROOT, "shell", "src"), [".test.ts"]);
const e2eSpecs = walk(join(ROOT, "shell", "e2e"), [".spec.ts"]);
const e2eReal = walk(join(ROOT, "shell", "e2e-real"), [".cjs"]).filter((f) => !f.includes(`${"lib"}`));
const docs = readdirSync(join(ROOT, "docs")).filter((f) => f.endsWith(".md"));
const adrs = readdirSync(join(ROOT, "docs", "adr")).filter((f) => f.endsWith(".md") && f !== "README.md");

// —— 计数类 ——
function countIn(files, re) {
  let n = 0;
  for (const f of files) n += (readFileSync(f, "utf8").match(re) || []).length;
  return n;
}
const tauriCommands = countIn(rustShell, /#\[tauri::command\]/g);
const rustTests = countIn(rustShell, /#\[test\]/g);
const intelTests = countIn(rustIntel, /#\[test\]/g);
const probeTests = (() => { try { return countIn(walk(join(ROOT, "probe"), [".py"], new Set(["__pycache__", ".venv"])), /^def test_/gm); } catch { return 0; } })();
const e2eLines = sum(e2eSpecs);

// —— 巨型文件（报告 §1.2 的口径：按行数降序）——
const giants = [
  ...srcTs.map((f) => ({ f: relative(ROOT, f).replace(/\\/g, "/"), n: lineCount(f) })),
  ...rustShell.map((f) => ({ f: relative(ROOT, f).replace(/\\/g, "/"), n: lineCount(f) })),
].sort((a, b) => b.n - a.n).slice(0, 10);

const head = (() => { try { return execSync("git rev-parse --short HEAD", { cwd: ROOT, encoding: "utf8" }).trim(); } catch { return "?"; } })();
const at = new Date().toISOString();

const rows = [
  ["前端源码 shell/src/**/*.ts（排除测试）", `${srcTs.length} 文件`, `${sum(srcTs)} 行`, `${mb(bytes(srcTs))}`],
  ["　其中顶层 src/*.ts", `${topTs.length} 文件`, `${sum(topTs)} 行`, ""],
  ["前端样式 shell/src/**/*.css", `${srcCss.length} 文件`, `${sum(srcCss)} 行`, `${mb(bytes(srcCss))}`],
  ["　其中 style.css（设计系统本体）", "1 文件", `${lineCount(styleCss)} 行`, `${mb(bytes([styleCss]))}`],
  ["Rust 外壳 shell/src-tauri/src/*.rs", `${rustShell.length} 文件`, `${sum(rustShell)} 行`, `${mb(bytes(rustShell))}`],
  ["Rust 运行时智能 intel/**/*.rs", `${rustIntel.length} 文件`, `${sum(rustIntel)} 行`, `${mb(bytes(rustIntel))}`],
  ["Python 探针 probe/**/*.py（排除 tests）", `${pyProbe.length} 文件`, `${sum(pyProbe)} 行`, `${mb(bytes(pyProbe))}`],
];
const totalLines = sum(srcTs) + sum(srcCss) + sum(rustShell) + sum(rustIntel) + sum(pyProbe);

const counts = [
  ["Tauri 命令 #[tauri::command]", tauriCommands, "src-tauri/src"],
  ["Rust 单测 #[test]（外壳）", rustTests, "src-tauri/src"],
  ["Rust 单测 #[test]（intel）", intelTests, "intel"],
  ["probe pytest（def test_）", probeTests, "probe"],
  ["前端单测文件 *.test.ts", testTs.length, "shell/src"],
  ["E2E spec（mock 层）", e2eSpecs.length, `shell/e2e（${e2eLines} 行）`],
  ["真机脚本 *.cjs", e2eReal.length, "shell/e2e-real（不含 lib/）"],
  ["文档 docs/*.md", docs.length, ""],
  ["ADR docs/adr/*.md（不含 README）", adrs.length, ""],
];

const out = [];
out.push(`# 仓库规模取数 ${at}`, "");
out.push(`- HEAD：\`${head}\` · 工作区：${execSync("git status --porcelain", { cwd: ROOT, encoding: "utf8" }).trim() ? "有未提交改动" : "clean"}`);
out.push(`- 取数：\`node tools/stats/repo-stats.mjs\`（口径见脚本头，**勿用 \`Get-Content $f\` 取行数**）`);
out.push("");
out.push("## 规模", "", "| 层 | 文件数 | 行数 | 体积 |", "|---|---|---|---|");
for (const r of rows) out.push(`| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} |`);
out.push(`| **合计（不含测试/e2e/文档）** | — | **${totalLines}** | — |`, "");
out.push("## 计数", "", "| 项 | 数量 | 范围 |", "|---|---|---|");
for (const c of counts) out.push(`| ${c[0]} | ${c[1]} | ${c[2]} |`);
out.push("", "## 最大的 10 个源文件", "", "| 文件 | 行数 |", "|---|---|");
for (const g of giants) out.push(`| \`${g.f}\` | ${g.n} |`);

console.log(out.join("\n"));
if (!NO_WRITE) {
  const dir = join(ROOT, "bench", "reports");
  mkdirSync(dir, { recursive: true });
  const stamp = at.replace(/[:]/g, "").slice(0, 15);
  const p = join(dir, `stats-${stamp}.md`);
  writeFileSync(p, out.join("\r\n"), "utf8");
  console.log(`\n[stats] 报告：${p}`);
}
