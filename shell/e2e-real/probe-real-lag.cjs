// 真实项目探针：复现「basedpyright 在真实大项目里输入 `module.` 补全秒级卡顿」。
// 用用户现场：hermes-agent/cli.py（13783 行）+ `time.`。
// 用法：node e2e-real/probe-real-lag.cjs [basedpyright|pyrefly]
'use strict';

const { chromium } = require('@playwright/test');
const { spawn, execSync } = require('child_process');
const { mkdtempSync, mkdirSync, writeFileSync, openSync } = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ENGINE = process.argv[2] || 'basedpyright';
const CDP_PORT = Number(process.env.OC_CDP_PORT || 9227);
const CDP_TIMEOUT_MS = Number(process.env.OC_CDP_TIMEOUT || 300) * 1000;
const DEV_URL_HOST = 'localhost:5173';

const PROJECT = 'D:\\hema\\hermes-fika\\hermes-agent';
const FILE = 'cli.py';
const TRIGGER = 'time'; // 输入 `time.` 触发标准库成员补全

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const portInUse = (port) => httpGet(`http://127.0.0.1:${port}/json/version`).then(() => true, () => false);
async function waitCdpReady(port, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    try { const r = await httpGet(`http://127.0.0.1:${port}/json/version`); if (r.status === 200) return; } catch { /* 未就绪 */ }
    if (Date.now() - t0 > timeoutMs) throw new Error('CDP 未就绪');
    await sleep(1500);
  }
}
function allPages(browser) {
  const out = [];
  for (const ctx of browser.contexts()) for (const p of ctx.pages()) out.push(p);
  return out;
}
async function dismissBlockingModals(page) {
  for (let i = 0; i < 8; i++) {
    const btns = page.locator('.modal-card:visible .modal-actions button');
    const n = await btns.count().catch(() => 0);
    if (n === 0) return;
    for (let j = 0; j < n; j++) await btns.nth(j).click({ force: true, timeout: 2000 }).catch(() => {});
    await sleep(400);
  }
}

(async () => {
  if (await portInUse(5173)) { console.error('[预检] 5173 已占用'); process.exit(2); }
  if (await portInUse(CDP_PORT)) { console.error(`[预检] CDP ${CDP_PORT} 已占用`); process.exit(2); }

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'oc-probe-real-'));
  const dataRoot = path.join(tmp, 'data-root');
  mkdirSync(path.join(dataRoot, 'config'), { recursive: true });
  writeFileSync(path.join(dataRoot, 'config', 'settings.json'), JSON.stringify({ lsp_engine: ENGINE }), 'utf8');
  writeFileSync(path.join(dataRoot, 'config', 'recent-workspaces.json'), JSON.stringify([PROJECT]), 'utf8');
  console.log(`[环境] engine=${ENGINE}, project=${PROJECT}, file=${FILE}, trigger=${TRIGGER}.`);

  const logPath = path.join(__dirname, '.probe-real-lag.log');
  const logFd = openSync(logPath, 'w');
  const child = spawn('cmd.exe', ['/c', 'npm', 'run', 'tauri', 'dev'], {
    cwd: path.join(__dirname, '..'),
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, PYLUME_DATA_ROOT: dataRoot, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
  });

  let browser = null;
  const t0 = Date.now();
  try {
    await waitCdpReady(CDP_PORT, CDP_TIMEOUT_MS);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    const main = allPages(browser).find((p) => p.url().includes(DEV_URL_HOST)) || allPages(browser)[0];
    await dismissBlockingModals(main);

    // 恢复项目 + 引擎就绪（巨项目索引，容忍长超时）
    await main.locator('#tree .tree-item .name', { hasText: FILE }).first().waitFor({ timeout: 120000 });
    console.log(`[1] 文件树可见 ${FILE}（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
    await main.waitForFunction(
      () => (document.querySelector('#status-lsp')?.textContent || '').includes('就绪'),
      undefined,
      { timeout: 300000 },
    );
    console.log(`[2] 引擎就绪（${((Date.now() - t0) / 1000).toFixed(1)}s，engine=${ENGINE}）`);

    // 打开巨型文件
    await main.locator('#tree .tree-item .name', { hasText: FILE }).first().dblclick();
    await main.locator('.monaco-editor').first().waitFor({ timeout: 60000 });
    await main.locator('.monaco-editor').first().click();
    console.log(`[3] ${FILE} 已打开（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
    await sleep(3000); // 给引擎分析当前文件一点时间

    // 度量：连续 5 次「Ctrl+End → 新行输入 time. → suggest 出现」
    const latencies = [];
    for (let i = 0; i < 5; i++) {
      await main.keyboard.press('Control+End');
      await main.keyboard.press('Enter');
      const t = Date.now();
      await main.keyboard.type(`${TRIGGER}.`, { delay: 0 });
      let ok = false;
      try {
        await main.waitForSelector('.suggest-widget', { state: 'visible', timeout: 30000 });
        ok = true;
      } catch { ok = false; }
      const ms = Date.now() - t;
      latencies.push(ok ? ms : -1);
      let labels = '';
      if (ok) {
        labels = await main.evaluate(() => Array.from(
          document.querySelectorAll('.suggest-widget .monaco-list-row .label-name, .suggest-widget .monaco-list-row .monaco-highlighted-label, .suggest-widget .monaco-list-row'),
        ).slice(0, 8).map((n) => (n.textContent || '').trim()).filter(Boolean).join(' | '));
      }
      await main.keyboard.press('Escape');
      await sleep(500);
      console.log(`  [${TRIGGER}. ${i + 1}] ${ok ? ms + 'ms' : 'TIMEOUT(>30s)'} :: ${labels.slice(0, 200)}`);
    }

    const valid = latencies.filter((x) => x >= 0);
    console.log('\n===== 结果 =====');
    console.log(`engine=${ENGINE}`);
    console.log(`cold=${valid[0]}ms, warm=[${valid.slice(1).join(',')}]`);
    if (valid.length > 1) console.log(`warm_avg=${(valid.slice(1).reduce((a, b) => a + b, 0) / (valid.length - 1)).toFixed(1)}ms`);
    console.log('================');
  } catch (e) {
    console.error('[运行中断]', e.message || e);
  } finally {
    if (browser) await browser.close().catch(() => {});
    console.log('[清理] taskkill...');
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* 已退出 */ }
  }
})();