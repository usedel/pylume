// 真机探针：复现「多窗口 + basedpyright 输入卡顿」。
// 隔离数据根预置 lsp_engine；开双窗口后在窗口 A 的 Monaco 输入 `.` 触发补全，
// 度量 suggest-widget 出现延迟（补全延迟）——对比 basedpyright vs pyrefly。
// 用法：node e2e-real/probe-mw-lag.cjs [basedpyright|pyrefly]
'use strict';

const { chromium } = require('@playwright/test');
const { spawn, execSync } = require('child_process');
const { mkdtempSync, mkdirSync, writeFileSync, openSync } = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ENGINE = process.argv[2] || 'basedpyright';
const CDP_PORT = Number(process.env.OC_CDP_PORT || 9226);
const CDP_TIMEOUT_MS = Number(process.env.OC_CDP_TIMEOUT || 600) * 1000;
const DEV_URL_HOST = 'localhost:5173';

// 末尾多个 Thing 实例；每轮在「不同行」输入 `x{i}.` 触发补全——
// 位置不同则 Monaco 无法走 word-suggest 缓存，强制每次真实 LSP completion。
const TEST_PY = [
  'import os',
  '',
  '',
  'class Thing:',
  '    def alpha(self):',
  '        return 1',
  '',
  '    def beta(self):',
  '        return 2',
  '',
  '',
  'x0 = Thing()',
  'x1 = Thing()',
  'x2 = Thing()',
  'x3 = Thing()',
  'x4 = Thing()',
  'x5 = Thing()',
  'x6 = Thing()',
  'x7 = Thing()',
].join('\n');

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
    try {
      const r = await httpGet(`http://127.0.0.1:${port}/json/version`);
      if (r.status === 200) return;
    } catch { /* 未就绪 */ }
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

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'oc-probe-lag-'));
  const wsA = path.join(tmp, 'wsA');
  const wsB = path.join(tmp, 'wsB');
  const dataRoot = path.join(tmp, 'data-root');
  mkdirSync(wsA, { recursive: true });
  mkdirSync(wsB, { recursive: true });
  mkdirSync(path.join(dataRoot, 'config'), { recursive: true });
  writeFileSync(path.join(wsA, 'test.py'), TEST_PY, 'utf8');
  writeFileSync(path.join(wsB, 'b.py'), '# project B\nprint("B")\n', 'utf8');
  writeFileSync(path.join(dataRoot, 'config', 'settings.json'), JSON.stringify({ lsp_engine: ENGINE }), 'utf8');
  writeFileSync(path.join(dataRoot, 'config', 'recent-workspaces.json'), JSON.stringify([wsA]), 'utf8');
  console.log(`[环境] engine=${ENGINE} A=${wsA} B=${wsB} dataRoot=${dataRoot}`);

  const logPath = path.join(__dirname, '.probe-mw-lag.log');
  const logFd = openSync(logPath, 'w');
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

  let browser = null;
  try {
    await waitCdpReady(CDP_PORT, CDP_TIMEOUT_MS);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    let pages = allPages(browser);
    const main = pages.find((p) => p.url().includes(DEV_URL_HOST)) || pages[0];
    await dismissBlockingModals(main);

    // 1. 主窗口恢复项目 A + 静态引擎就绪
    await main.locator('#tree .tree-item .name', { hasText: 'test.py' }).first().waitFor({ timeout: 90000 });
    console.log('[1] 项目 A 已恢复');
    await main.waitForFunction(
      () => (document.querySelector('#status-lsp')?.textContent || '').includes('就绪'),
      undefined,
      { timeout: 120000 },
    );
    console.log(`[2] 静态引擎就绪（engine=${ENGINE}）`);

    // 2. 打开第二窗口（SKIP_B=1 时跳过，用于单窗口对照）
    if (process.env.SKIP_B !== '1') {
      await main.evaluate((p) => window.__TAURI_INTERNALS__.invoke('open_workspace_window', { path: p }), wsB);
      let winB = null;
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        const now = allPages(browser);
        const np = now.find((p) => p !== main && p.url().includes(DEV_URL_HOST));
        if (np) { winB = np; break; }
        await sleep(500);
      }
      console.log('[3] 第二窗口出现 =', !!winB);
      if (winB) {
        await winB.locator('#tree .tree-item .name', { hasText: 'b.py' }).first().waitFor({ timeout: 90000 }).catch(() => {});
        await sleep(3000); // 等 B 的 LSP 也起来，制造双引擎并存
      }
    } else {
      console.log('[3] SKIP_B=1，单窗口对照');
    }

    // 3. 窗口 A 打开 test.py，聚焦 Monaco，光标到末尾
    await main.locator('#tree .tree-item .name', { hasText: 'test.py' }).first().dblclick();
    await main.locator('.monaco-editor').first().waitFor({ timeout: 30000 });
    await main.locator('.monaco-editor').first().click();
    await main.keyboard.press('Control+End');
    await sleep(1500);

    // 4. 度量补全延迟：每轮在末尾新行输入 `x{i}.`（不同位置 → 真实 LSP 请求）
    const latencies = [];
    for (let i = 0; i < 8; i++) {
      await main.keyboard.press('Control+End');
      await main.keyboard.press('Enter');
      const t0 = Date.now();
      await main.keyboard.type(`x${i}.`, { delay: 0 });
      let ok = false;
      try {
        await main.waitForSelector('.suggest-widget', { state: 'visible', timeout: 20000 });
        ok = true;
      } catch { ok = false; }
      const ms = Date.now() - t0;
      latencies.push(ok ? ms : -1);
      await main.keyboard.press('Escape');
      await sleep(300);
      console.log(`  [x${i}. ${i + 1}] ${ok ? ms + 'ms' : 'TIMEOUT(>20s)'}`);
    }

    const valid = latencies.filter((x) => x >= 0);
    const cold = valid[0];
    const warm = valid.slice(1);
    const warmAvg = warm.length ? (warm.reduce((a, b) => a + b, 0) / warm.length).toFixed(1) : '-';
    console.log('\n===== 结果 =====');
    console.log(`engine=${ENGINE}`);
    console.log(`cold_suggest_ms=${cold}`);
    console.log(`warm_suggest_ms=[${warm.join(',')}] avg=${warmAvg}`);
    console.log('================');
  } catch (e) {
    console.error('[运行中断]', e.message || e);
  } finally {
    if (browser) await browser.close().catch(() => {});
    console.log('[清理] taskkill...');
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* 已退出 */ }
  }
})();