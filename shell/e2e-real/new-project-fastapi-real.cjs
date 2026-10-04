/**
 * 新建 FastAPI 项目真机（Real App）CDP 验收脚本 — NP-REAL-1..4
 * （对应 docs/pycharm_framework_support_report.md §8.3.1 F9；用户实测报告
 *   「创建 fastapi 服务项目，依赖安装报 invalid type: null, expected a string」——
 *   前端 pip_install 传 interpreter: null，而 Rust 签名是 interpreter: String，
 *   Tauri 反序列化直接报类型错。浏览器 e2e 的 mock 对 pip_install 静态返回 0、
 *   不校验参数类型，**复现不了**——跨层参数类型契约必须真机验收。）
 *
 * 与 e2e/ux/03-new-project-fastapi.spec.ts（浏览器 mock）分层：
 *   mock 面验证 UI 流程与落盘形状；本脚本驱动真实 Tauri 应用 + 真实 uv，
 *   验证 create_project（Rust）→ pip_install（Rust，参数反序列化 + 真实 uv add）全链路。
 *
 * 用法：
 *   cd shell
 *   node e2e-real/new-project-fastapi-real.cjs
 *
 * 环境变量：
 *   OC_PARENT        项目父目录（默认 %TEMP%\oc-np-real-<n>，脚本自建自清）
 *   OC_CDP_PORT / OC_CDP_TIMEOUT / OC_KEEP_APP   同 endpoints-real.cjs
 *   OC_SKIP_INSTALL  =1 时跳过依赖安装检查（离线环境；只验创建与模板落盘）
 *
 * 判定：
 *   NP-REAL-1  欢迎页 → 新建项目面板 → 类型下拉存在且默认 script
 *   NP-REAL-2  选 fastapi 创建 → 工作区切换 + main.py 打开 + 模板/依赖落盘
 *   NP-REAL-3  依赖安装无「invalid type / interpreter」错误（修复前态 = 复现）
 *   NP-REAL-4  uv add 实际完成（pyproject 依赖已装或 uv.lock 生成；best-effort 口径）
 */
'use strict';

const { chromium } = require('@playwright/test');
const { spawn, execSync } = require('child_process');
const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, openSync, rmSync } = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const CDP_PORT = Number(process.env.OC_CDP_PORT || 9224);
const CDP_TIMEOUT_MS = Number(process.env.OC_CDP_TIMEOUT || 600) * 1000;
const KEEP_APP = process.env.OC_KEEP_APP === '1';
const SKIP_INSTALL = process.env.OC_SKIP_INSTALL === '1';
const DEV_URL_HOST = 'localhost:5173';
const PROJ_NAME = 'demo-api-real';

const results = [];
function record(id, desc, ok, detail) {
  results.push({ id, desc, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${desc}${detail ? '\n      -> ' + detail : ''}`);
}

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

async function dismissBlockingModals(page) {
  // 首启「落位提示」等一次性弹窗（fresh 数据根会触发）。只点 primary（确认类）按钮——
  // 不能按序全点：storage-onboarding 的「自定义位置…」会拉起原生目录选择框阻塞整个 UI。
  // 新建项目面板本身是 modal，但其 modal-actions 无 primary class（创建/取消都是 .btn），
  // 不在误伤面内。
  for (let i = 0; i < 6; i++) {
    const np = page.locator('#new-project-modal:not(.hidden)');
    if (await np.count()) { /* 新建面板开着：留给用例自己操作 */ return; }
    const btns = page.locator('.modal-card:visible .modal-actions .btn--primary');
    const n = await btns.count().catch(() => 0);
    if (n === 0) return;
    for (let j = 0; j < n; j++) await btns.nth(j).click({ force: true, timeout: 2000 }).catch(() => {});
    await sleep(400);
  }
}

/** 收集输出面板全部文本（安装错误会以 stderr 行呈现；invalid args 错误走 catch 的 stderr 行） */
async function outputText(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('#output .out-line')).map((e) => e.textContent || '').join('\n'));
}

async function runChecks(page, projRoot) {
  await dismissBlockingModals(page);

  // NP-REAL-1 欢迎页（空数据根 → 无最近工作区）→ 新建项目面板 → 类型下拉
  // 真机时序坑：#ew-new-project 的 click 监听器在 main.ts init 尾部（wireNewProject）才挂，
  // 而 DOM 元素静态渲染即"可见"——CDP 连上就点会落空（mock e2e 因 invoke 全同步 init 极快，
  // 掩盖此差异）。用「点击 → 验证面板打开 → 重试」循环替代裸 click。
  const typeSel = page.locator('#new-project-type');
  let panelOpened = false;
  let lastErr = '';
  for (let i = 0; i < 20 && !panelOpened; i++) {
    await dismissBlockingModals(page); // 首启落位弹窗可能在等待期间弹出
    try {
      await page.locator('#ew-new-project').click({ timeout: 3000 });
      await typeSel.waitFor({ state: 'visible', timeout: 2500 });
      panelOpened = true;
    } catch (e) {
      lastErr = String(e).split('\n')[0];
    }
  }
  if (!panelOpened) {
    record('NP-REAL-1', '新建项目面板可打开（点击重试循环）', false, lastErr);
    return;
  }
  const defVal = await typeSel.inputValue();
  const hasFastapiOpt = await typeSel.locator('option[value="fastapi"]').count();
  if (defVal === 'script' && hasFastapiOpt > 0) {
    record('NP-REAL-1', '新建项目面板：类型下拉存在，默认 script，含 fastapi 选项', true);
  } else {
    record('NP-REAL-1', '新建项目面板：类型下拉存在，默认 script，含 fastapi 选项', false,
      `默认值=${defVal}，fastapi 选项=${hasFastapiOpt}`);
    return;
  }

  // NP-REAL-2 填表（环境=venv 默认）→ 创建 → 工作区切换 + 模板/依赖落盘
  await page.locator('#new-project-name').fill(PROJ_NAME);
  await page.locator('#new-project-location').fill(path.dirname(projRoot));
  await typeSel.selectOption('fastapi');
  // 预览行含依赖说明（q2 裁决文案）
  const preview = await page.locator('#new-project-preview').textContent();
  if (!preview || !preview.includes('fastapi / uvicorn 依赖')) {
    record('NP-REAL-2', '预览行含 fastapi / uvicorn 依赖说明', false, `实际：${preview}`);
    return;
  }
  await page.locator('#new-project-create').click();

  // 工作区切换（#tree-header-text 显示项目名）+ main.py 打开
  try {
    await page.locator('#tree-header-text').filter({ hasText: PROJ_NAME }).waitFor({ timeout: 30000 });
    await page.locator('#tabbar .tab.active .name', { hasText: 'main.py' }).waitFor({ timeout: 20000 });
  } catch (e) {
    record('NP-REAL-2', '创建后工作区切换 + main.py 打开', false, String(e).split('\n')[0]);
    return;
  }
  const mainPy = readFileSync(path.join(projRoot, 'main.py'), 'utf8');
  const pyproject = readFileSync(path.join(projRoot, 'pyproject.toml'), 'utf8');
  const tplOk = mainPy.includes('app = FastAPI(') && mainPy.includes('@app.get("');
  const depOk = pyproject.includes('"fastapi"') && pyproject.includes('"uvicorn"');
  if (tplOk && depOk) {
    record('NP-REAL-2', `创建落盘：FastAPI 模板 + pyproject 依赖（${projRoot}）`, true);
  } else {
    record('NP-REAL-2', `创建落盘：FastAPI 模板 + pyproject 依赖`, false,
      `模板=${tplOk} 依赖=${depOk} | pyproject=${tail(pyproject, 200)}`);
    return;
  }

  // NP-REAL-3 依赖安装不报「invalid args / invalid type」错误（修复前态 = 用户报错复现）
  // 等安装阶段收尾（面板关闭 + busy 复位；uv add 真实跑，最长给 180s）
  await page.locator('#new-project-modal').waitFor({ state: 'hidden', timeout: 20000 }).catch(() => {});
  let installErr = null;
  for (let i = 0; i < 60; i++) {
    const text = await outputText(page);
    if (/invalid (args|type)|expected a string|invalid type: null/.test(text)) { installErr = text.match(/.*(invalid (args|type)|expected a string|invalid type: null)[^\n]*/)?.[0] || 'matched'; break; }
    if (/uv add fastapi uvicorn/.test(text) && /依赖安装失败/.test(text)) { installErr = '依赖安装失败（非类型错误，见输出）'; break; }
    await sleep(3000);
  }
  if (installErr) {
    record('NP-REAL-3', '依赖安装无类型错误（interpreter: null 契约）', false, `>>> 复现：${installErr}`);
  } else {
    record('NP-REAL-3', '依赖安装无类型错误（interpreter: null 契约）', true);
  }

  // NP-REAL-4 uv add 实际完成（best-effort 口径：uv.lock 生成 或 venv 内已装 fastapi）
  if (SKIP_INSTALL) {
    record('NP-REAL-4', 'uv add 实际完成（OC_SKIP_INSTALL=1 跳过）', true, 'skipped');
    return;
  }
  const lockExists = existsSync(path.join(projRoot, 'uv.lock'));
  let venvHasFastapi = false;
  try {
    const siteDir = path.join(projRoot, '.venv', 'Lib', 'site-packages');
    venvHasFastapi = existsSync(siteDir) && readFileSync(path.join(siteDir, '..', '..'), 'utf8') !== undefined
      && require('fs').readdirSync(siteDir).some((n) => n.toLowerCase().startsWith('fastapi'));
  } catch { /* venv 未建或结构不同 */ }
  if (lockExists || venvHasFastapi) {
    record('NP-REAL-4', `uv add 实际完成（uv.lock=${lockExists} venv含fastapi=${venvHasFastapi}）`, true);
  } else {
    // 失败但非类型错误：best-effort 口径下不算 FAIL，标注 FAIL 便于观察（网络原因安装失败值得看见）
    const text = await outputText(page);
    const lastErr = (text.match(/[^\n]*依赖安装失败[^\n]*/) || ['(未捕获失败行)'])[0];
    record('NP-REAL-4', 'uv add 实际完成（uv.lock / venv 内 fastapi）', false, `${lastErr} | 若为网络原因属 best-effort 边界，人工判定`);
  }
}

(async () => {
  if (await portInUse(5173)) {
    console.error(`[预检失败] 5173 已被占用（可能已有 vite / tauri dev 在跑），请先停掉再运行本脚本。`);
    process.exit(2);
  }
  if (await portInUse(CDP_PORT)) {
    console.error(`[预检失败] CDP 端口 ${CDP_PORT} 已被占用（可能残留上一次会话）。`);
    process.exit(2);
  }

  // 项目父目录：默认临时目录（自建自清）；OC_PARENT 可指定（如 D:\logs）——不复用真实用户目录
  const parentDir = process.env.OC_PARENT || path.join(os.tmpdir(), `oc-np-real-${Date.now()}`);
  mkdirSync(parentDir, { recursive: true });
  const projRoot = path.join(parentDir, PROJ_NAME);
  if (existsSync(projRoot)) {
    console.error(`[预检失败] 项目目录已存在: ${projRoot}（重名会触发「目标已存在」错误）`);
    process.exit(2);
  }

  // 隔离数据根：recent-workspaces 为空 → 启动停欢迎页（#ew-actions 可见）
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'oc-np-real-data-'));
  const dataRoot = path.join(tmp, 'data-root');
  mkdirSync(path.join(dataRoot, 'config'), { recursive: true });
  writeFileSync(path.join(dataRoot, 'config', 'recent-workspaces.json'), '[]', 'utf8');
  console.log(`[环境] 项目目录: ${projRoot}\n[环境] 数据根: ${dataRoot}\n[环境] CDP: http://127.0.0.1:${CDP_PORT}${SKIP_INSTALL ? '（跳过安装检查）' : ''}`);

  const logPath = path.join(__dirname, '.tauri-dev-np.log');
  const logFd = openSync(logPath, 'w');
  console.log(`[启动] npm run tauri dev（日志: ${logPath}）…`);
  const child = spawn('cmd.exe', ['/c', 'npm', 'run', 'tauri', 'dev'], {
    cwd: path.join(__dirname, '..'),
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      PYLUME_DATA_ROOT: dataRoot,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    },
  });

  let exitCode = 0;
  let browser = null;
  try {
    const waited = await waitCdpReady(CDP_PORT, CDP_TIMEOUT_MS);
    console.log(`[就绪] CDP 已监听（等待 ${Math.round(waited / 1000)}s），连接…`);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);

    const ctx = browser.contexts()[0];
    const page = ctx.pages().find((p) => p.url().includes(DEV_URL_HOST)) || ctx.pages()[0];
    if (!page) throw new Error('CDP 已连接但未找到应用页面（devUrl=' + DEV_URL_HOST + '）');
    console.log(`[连接] 页面: ${page.url()}`);

    await runChecks(page, projRoot);
  } catch (e) {
    console.error(`\n[运行中断] ${e.message || e}`);
    try {
      const log = readFileSync(logPath, 'utf8');
      console.error('—— tauri dev 日志尾部 ——\n' + tail(log, 2000));
    } catch { /* 日志可能尚未生成 */ }
    exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (!KEEP_APP) {
      console.log('\n[清理] taskkill 进程树…');
      try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* 已退出 */ }
      // 项目目录留存于 %TEMP% 由系统清理；不删以便排查（KEEP_APP 同理）
      console.log(`[留存] 项目目录未删（排查用）: ${projRoot}`);
    } else {
      console.log(`\n[保留] 应用未杀（OC_KEEP_APP=1），pid=${child.pid}；项目目录: ${projRoot}`);
    }
  }

  console.log('\n========== 真机 CDP 验收结果 ==========');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id}  ${r.desc}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`--------------------------------------`);
  console.log(`共 ${results.length} 项，失败 ${failed} 项${KEEP_APP ? '（应用保留运行中）' : ''}`);
  process.exit(exitCode || (failed > 0 ? 1 : 0));
})();
