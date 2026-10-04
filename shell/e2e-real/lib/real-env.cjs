/**
 * e2e-real 公共基建：隔离环境 fixture、tauri dev 启动、CDP 连接、进程树清理与验收汇总。
 *
 * 各 *_real.cjs 脚本只保留自己的预检 / fixture / 断言逻辑，生命周期托管给
 * runWithRealApp()：
 *
 *   const { runWithRealApp, record, presetInterpreter } = require('./lib/real-env.cjs');
 *   runWithRealApp(
 *     {
 *       tmpPrefix: 'oc-xxx-real-',
 *       requirePaths: [{ path: REAL_PYTHON, message: '解释器不存在', hint: '用 OC_REAL_PYTHON 指定' }],
 *       setupFixtures({ workspace, dataRoot }) { ...; return 任意透传值; },
 *     },
 *     async (s) => { await runChecks(s.page); },   // s: { browser, page, pages(), tmp, workspace, dataRoot, ... }
 *   );
 *
 * 环境变量（所有脚本共用）：
 *   OC_CDP_PORT     WebView2 CDP 端口（默认 9223；可用 options.cdpPort 覆盖默认值）
 *   OC_CDP_TIMEOUT  等待 CDP 就绪秒数（默认 600，首次 cargo build 较慢可调大）
 *   OC_KEEP_APP=1   结束后不杀应用（保留现场人工检查；临时目录同样保留）
 *   OC_JSON_OUT=<路径>  把验收汇总写成 JSON（nightly / run-real-all 断言用）
 *
 * 为什么要 JSON 汇总（P0-1 子项 3）：原先只有人读的控制台表格，CI 无法断言、
 * 也无法跨次对比历史。落盘后 nightly 可直接 gate「项数 / 失败数 / 时长」，
 * 且同一文件既是本次结论也是下次对比基线。
 *
 * 实现要点（沿既有真机验收经验）：
 *   - 隔离数据根 PYLUME_DATA_ROOT + 预置 config/recent-workspaces.json
 *     （Node 写入天然无 BOM，规避 PS Set-Content 带 BOM 被 serde 静默拒读的坑）；
 *   - WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port> 打开 CDP；
 *   - Playwright connectOverCDP 驱动真实窗口；
 *   - 结束 taskkill /T /F 清进程树（cargo/vite/应用一并回收）。
 */
'use strict';

const { chromium } = require('@playwright/test');
const { spawn, execSync } = require('child_process');
const { mkdtempSync, mkdirSync, writeFileSync, existsSync, openSync, realpathSync } = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DEV_URL_HOST = 'localhost:5173';

// —— 验收结果汇总 ——

const results = [];

function record(id, desc, ok, detail) {
  results.push({ id, desc, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${desc}${detail ? '\n      -> ' + detail : ''}`);
}

/** 打印验收结果汇总，返回失败项数 */
function printSummary(title, keepApp) {
  console.log(`\n========== ${title} ==========`);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id}  ${r.desc}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log('--------------------------------------');
  console.log(`共 ${results.length} 项，失败 ${failed} 项${keepApp ? '（应用保留运行中）' : ''}`);
  return failed;
}

/**
 * 落盘 JSON 汇总（P0-1 子项 3）。路径取 OC_JSON_OUT 环境变量，未设则不写。
 * 写出后打印一行路径，便于 CI 从日志定位产物。
 */
function writeJsonSummary(meta) {
  const out = process.env.OC_JSON_OUT;
  if (!out) return null;
  const failed = results.filter((r) => !r.ok).length;
  const error = meta.error || null;
  const payload = {
    schema: 'pylume-e2e-real-summary/1',
    suite: meta.suite || 'unknown',
    at: new Date().toISOString(),
    // 有用例失败或预检/运行中断（error）都算不通过；「0 项 + 无 error」视为空跑，判 false 以免被误当通过
    ok: failed === 0 && !error && results.length > 0,
    total: results.length,
    failed,
    error,
    durationMs: meta.durationMs ?? null,
    headCommit: meta.headCommit || null,
    cdpPort: meta.cdpPort ?? null,
    cases: results.map((r) => ({ id: r.id, desc: r.desc, ok: r.ok, detail: r.detail || null })),
  };
  try {
    mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    writeFileSync(path.resolve(out), JSON.stringify(payload, null, 2), 'utf8');
    console.log(`\n[汇总] JSON: ${path.resolve(out)}（${payload.total} 项 / 失败 ${payload.failed}）`);
  } catch (e) {
    console.error(`[汇总] JSON 写入失败（不计入失败）: ${e.message}`);
  }
  return payload;
}

// —— 通用小工具 ——

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(new Error('timeout')); });
  });
}

function portInUse(port) {
  return httpGet(`http://127.0.0.1:${port}/json/version`).then(() => true, () => false);
}

async function waitCdpReady(port, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await httpGet(`http://127.0.0.1:${port}/json/version`);
      if (r.status === 200) return Date.now() - t0;
    } catch { /* 未就绪继续等 */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`CDP ${port} 在 ${timeoutMs / 1000}s 内未就绪（tauri dev 可能编译失败，见日志尾部）`);
    await sleep(1500);
  }
}

function tail(text, n) { return text.length <= n ? text : '...' + text.slice(-n); }

/** 当前 git HEAD 短哈希，写进 JSON 汇总便于把失败结果对应到具体提交（取不到即 null） */
function gitHead() {
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: path.join(__dirname, '..', '..', '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch { return null; }
}

function countPythonProcs() {
  try {
    const out = execSync('tasklist /FO CSV /NH', { encoding: 'utf8' });
    return out.split(/\r?\n/).filter((l) => /^"python(\w)?\.exe"/i.test(l.trim())).length;
  } catch { return -1; }
}

// —— 工作区 fixture ——

/**
 * 工作区哈希：对齐 src-tauri/file_ops.rs::project_hash（= probe store.py::project_hash）：
 * sha1( lowercase( strip_verbatim( realpath(root).replace('/','\\') ) ) )[:12]。
 * realpath 变体与书写变体各写一份同内容配置，规避 canonicalize 差异。
 */
function projectHash(root) {
  const norm = (p) => {
    let s = String(p).replace(/\//g, '\\');
    while (s.startsWith('\\\\?\\')) s = s.slice(4);
    return s.toLowerCase();
  };
  const variants = new Set([norm(root)]);
  try { variants.add(norm(realpathSync(root))); } catch { /* 目录未建时忽略 */ }
  return [...variants].map((v) => crypto.createHash('sha1').update(v, 'utf8').digest('hex').slice(0, 12));
}

/** 预置工作区解释器（<data_root>/workspaces/<hash>.json，对齐 env_cmds::write_config 形态） */
function presetInterpreter(dataRoot, workspace, interpreter) {
  const dir = path.join(dataRoot, 'workspaces');
  mkdirSync(dir, { recursive: true });
  const payload = JSON.stringify({ interpreter });
  for (const h of projectHash(workspace)) writeFileSync(path.join(dir, `${h}.json`), payload, 'utf8');
}

/** 预置 recent-workspaces.json（隔离数据根下启动自动恢复指定工作区） */
function presetRecentWorkspaces(dataRoot, workspaces) {
  writeFileSync(
    path.join(dataRoot, 'config', 'recent-workspaces.json'),
    JSON.stringify(workspaces),
    'utf8',
  );
}

// —— 页面辅助 ——

async function dismissBlockingModals(page, maxRounds = 6) {
  // 首启「落位提示」等一次性弹窗（fresh 数据根会触发）：点掉所有可见 modal 按钮放行。
  // 任意选择（默认位置 / 自定义取消）都不影响验收。
  for (let i = 0; i < maxRounds; i++) {
    const btns = page.locator('.modal-card:visible .modal-actions button');
    const n = await btns.count().catch(() => 0);
    if (n === 0) return;
    for (let j = 0; j < n; j++) await btns.nth(j).click({ force: true, timeout: 2000 }).catch(() => {});
    await sleep(400);
  }
}

/** 收集页面的未捕获异常 + console error/warning，供失败时诊断 */
function attachDiagnostics(page) {
  const logs = [];
  page.on('pageerror', (e) => logs.push(`[pageerror] ${String(e)}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`);
  });
  return logs;
}

/** 遍历所有 context 的所有 page（多窗口可能落在不同 WebView2 context） */
function allPages(browser) {
  const out = [];
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) out.push(p);
  }
  return out;
}

// —— 生命周期 ——

/**
 * 完整托管一次真机 CDP 验收：预检 → 隔离 fixture → 启动 tauri dev → 连接 CDP →
 * 执行 checks → 诊断输出 → 清理 → 汇总 → process.exit。
 *
 * options:
 *   cdpPort        CDP 端口（缺省读 OC_CDP_PORT，再缺省 9223）
 *   cdpTimeoutSec  等待 CDP 就绪秒数（缺省读 OC_CDP_TIMEOUT，再缺省 600）
 *   tmpPrefix      临时目录前缀（默认 'oc-real-'）
 *   logName        tauri dev 日志文件名（落在 e2e-real/ 下，默认 '.tauri-dev.log'）
 *   summaryTitle   结果汇总标题（默认 '真机 CDP 验收结果'）
 *   checkDevPort   是否预检 5173 占用（默认 true）
 *   requirePaths   [{ path, message, hint }] 存在性预检，缺失即退出码 2
 *   setupFixtures({ tmp, workspace, dataRoot })  自定义 fixture；返回值透传到 session.fixtures
 * checks(session)  断言主体；session.page 为主窗口页面，session.browser 可做多窗口
 *
 * 结束时若设了 OC_JSON_OUT，会落盘一份 JSON 汇总（见 writeJsonSummary）；
 * 预检失败也会落盘（ok:false + error），使 CI 能区分「环境没起来」与「断言失败」。
 */
async function runWithRealApp(options, checks) {
  const o = {
    cdpPort: options.cdpPort ?? Number(process.env.OC_CDP_PORT || 9223),
    cdpTimeoutMs: (options.cdpTimeoutSec ?? Number(process.env.OC_CDP_TIMEOUT || 600)) * 1000,
    keepApp: process.env.OC_KEEP_APP === '1',
    tmpPrefix: options.tmpPrefix || 'oc-real-',
    logName: options.logName || '.tauri-dev.log',
    summaryTitle: options.summaryTitle || '真机 CDP 验收结果',
  };
  const t0 = Date.now();
  const suiteMeta = {
    suite: options.suite || path.basename(process.argv[1] || 'unknown', '.cjs'),
    cdpPort: o.cdpPort,
    headCommit: gitHead(),
  };
  /** 预检失败：也落 JSON，让 nightly 能识别「环境未就绪」而非断言回归 */
  function precheckFail(msg) {
    console.error(`[预检失败] ${msg}`);
    writeJsonSummary({ ...suiteMeta, durationMs: Date.now() - t0, error: msg });
    process.exit(2);
  }

  // —— 预检（fail fast，退出码 2） ——
  if (options.checkDevPort !== false && await portInUse(5173)) {
    precheckFail('5173 已被占用（可能已有 vite / tauri dev 在跑），请先停掉再运行本脚本。');
  }
  if (await portInUse(o.cdpPort)) {
    precheckFail(`CDP 端口 ${o.cdpPort} 已被占用（可能残留上一次会话）。`);
  }
  for (const r of options.requirePaths || []) {
    if (!existsSync(r.path)) {
      precheckFail(`${r.message || '路径不存在'}: ${r.path}${r.hint ? `（${r.hint}）` : ''}`);
    }
  }

  // —— 隔离环境 fixture（Node 写文件天然无 BOM） ——
  const tmp = mkdtempSync(path.join(os.tmpdir(), o.tmpPrefix));
  const workspace = path.join(tmp, 'workspace');
  const dataRoot = path.join(tmp, 'data-root');
  mkdirSync(path.join(dataRoot, 'config'), { recursive: true });
  const fixtures = options.setupFixtures ? await options.setupFixtures({ tmp, workspace, dataRoot }) : null;
  console.log(`[环境] 数据根: ${dataRoot}\n[环境] CDP: http://127.0.0.1:${o.cdpPort}`);

  // —— 启动 tauri dev（日志落盘，失败时打尾部） ——
  const logPath = path.join(__dirname, '..', o.logName);
  const logFd = openSync(logPath, 'w');
  console.log(`[启动] npm run tauri dev（日志: ${logPath}）…`);
  const child = spawn('cmd.exe', ['/c', 'npm', 'run', 'tauri', 'dev'], {
    cwd: path.join(__dirname, '..', '..'),
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      PYLUME_DATA_ROOT: dataRoot,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${o.cdpPort}`,
    },
  });

  let exitCode = 0;
  let browser = null;
  let runError = null;
  try {
    const waited = await waitCdpReady(o.cdpPort, o.cdpTimeoutMs);
    console.log(`[就绪] CDP 已监听（等待 ${Math.round(waited / 1000)}s），连接…`);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${o.cdpPort}`);

    const pages = allPages(browser);
    const main = pages.find((p) => p.url().includes(DEV_URL_HOST)) || pages[0];
    if (!main) throw new Error('CDP 已连接但未找到应用页面（devUrl=' + DEV_URL_HOST + '）');
    console.log(`[连接] 页面: ${main.url()}`);

    const pageErrors = [];
    const consoleWarns = [];
    main.on('pageerror', (e) => pageErrors.push(String(e)));
    main.on('console', (m) => {
      if (m.type() === 'warning' || m.type() === 'error') consoleWarns.push(`[${m.type()}] ${m.text()}`);
    });

    const session = {
      browser, child, page: main, pages: () => allPages(browser),
      tmp, workspace, dataRoot, logPath, keepApp: o.keepApp, fixtures,
    };
    await checks(session);

    if (pageErrors.length) {
      console.log(`\n[提示] 页面未捕获异常 ${pageErrors.length} 条（不计入失败，仅供排查）:`);
      for (const e of pageErrors.slice(0, 5)) console.log('  - ' + e.split('\n')[0]);
    }
    if (consoleWarns.length) {
      console.log(`\n[提示] console warning/error ${consoleWarns.length} 条（不计入失败，仅供排查）:`);
      for (const e of consoleWarns.slice(0, 30)) console.log('  - ' + e.split('\n')[0]);
    }
  } catch (e) {
    console.error(`\n[运行中断] ${e.message || e}`);
    runError = String(e.message || e);
    try {
      const fs = require('fs');
      const log = fs.readFileSync(logPath, 'utf8');
      console.error('—— tauri dev 日志尾部 ——\n' + tail(log, 2000));
    } catch { /* 日志可能尚未生成 */ }
    exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (!o.keepApp) {
      console.log('\n[清理] taskkill 进程树…');
      try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* 已退出 */ }
    } else {
      console.log(`\n[保留] 应用未杀（OC_KEEP_APP=1），pid=${child.pid}；临时目录: ${tmp}`);
    }
  }

  const failed = printSummary(o.summaryTitle, o.keepApp);
  writeJsonSummary({ ...suiteMeta, durationMs: Date.now() - t0, error: runError });
  process.exit(exitCode || (failed > 0 ? 1 : 0));
}

module.exports = {
  DEV_URL_HOST,
  results,
  record,
  printSummary,
  writeJsonSummary,
  sleep,
  httpGet,
  portInUse,
  waitCdpReady,
  tail,
  gitHead,
  countPythonProcs,
  projectHash,
  presetInterpreter,
  presetRecentWorkspaces,
  dismissBlockingModals,
  attachDiagnostics,
  allPages,
  runWithRealApp,
};
