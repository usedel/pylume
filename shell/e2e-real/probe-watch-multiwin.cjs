/**
 * 探针：MC-REAL-WATCH-2（B 窗口文件监听）根因二分。
 * 订阅 A/B 两窗口的原始 fs-changed / dep-fs-changed 事件 + 抓取「文件监听启动失败」console 告警：
 *   - B 无事件 + 无启动失败告警 → 后端 watcher 未启动或 emit_to wid 不符；
 *   - B 有事件但树不刷 → 前端 handleFsChanged 增量刷新问题；
 *   - B 有启动失败告警 → watch() 在 B 的临时目录上失败。
 *
 * 用法：cd shell && node e2e-real/probe-watch-multiwin.cjs
 */
'use strict';

const path = require('path');
const { writeFileSync } = require('fs');
const {
  runWithRealApp,
  record,
  sleep,
  dismissBlockingModals,
  allPages,
} = require('./lib/real-env.cjs');

let WS_A = '';
let WS_B = '';

/** 在页面内订阅原始事件（Rust → 前端），落 window.__fsProbeLog */
async function installFsProbe(page, tag) {
  const reg = await page
    .evaluate(async (t) => {
      window.__fsProbeLog = [];
      window.__fsProbeTag = t;
      const internals = window.__TAURI_INTERNALS__;
      const cb = (ev) => {
        try {
          window.__fsProbeLog.push({ event: ev.event, payload: ev.payload, t: Date.now() });
          if (window.__fsProbeLog.length > 200) window.__fsProbeLog.shift();
        } catch { /* 忽略 */ }
      };
      const id = internals.transformCallback(cb, false);
      const out = {};
      for (const name of ['fs-changed', 'dep-fs-changed']) {
        try {
          await internals.invoke('plugin:event|listen', { event: name, target: { kind: 'Any' }, handler: id });
          out[name] = 'ok';
        } catch (e) {
          out[name] = 'failed:' + e;
        }
      }
      return out;
    })
    .catch((e) => 'probe-install-failed:' + e);
  console.log(`[探针] ${tag} 事件监听注册: ${JSON.stringify(reg)}`);
}

async function probeResult(page, tag) {
  const log = await page.evaluate(() => window.__fsProbeLog || null).catch(() => 'evaluate-failed');
  console.log(`[探针] ${tag} 收到事件 ${Array.isArray(log) ? log.length : log} 条:`);
  if (Array.isArray(log)) {
    for (const item of log.slice(0, 10)) {
      console.log(`   - ${item.event}: ${JSON.stringify(item.payload).slice(0, 200)}`);
    }
  }
  return log;
}

runWithRealApp(
  {
    cdpPort: Number(process.env.OC_CDP_PORT || 9226),
    tmpPrefix: 'oc-probe-watch-',
    logName: '.tauri-dev-probe.log',
    summaryTitle: '探针结果（不影响验收口径）',
    setupFixtures({ tmp, dataRoot }) {
      const { mkdirSync } = require('fs');
      const wsA = path.join(tmp, 'wsA');
      const wsB = path.join(tmp, 'wsB');
      mkdirSync(wsA, { recursive: true });
      mkdirSync(wsB, { recursive: true });
      writeFileSync(path.join(wsA, 'a_project.py'), '# A\n', 'utf8');
      writeFileSync(path.join(wsB, 'b_project.py'), '# B\n', 'utf8');
      writeFileSync(
        path.join(dataRoot, 'config', 'recent-workspaces.json'),
        JSON.stringify([wsA]),
        'utf8',
      );
      WS_A = wsA;
      WS_B = wsB;
      console.log(`[环境] A=${wsA}\n[环境] B=${wsB}`);
    },
  },
  async (s) => {
    const { browser } = s;
    let pages = allPages(browser);
    const main = pages.find((p) => p.url().includes('localhost:5173')) || pages[0];
    await dismissBlockingModals(main);
    await main.locator('#tree .tree-item .name', { hasText: 'a_project.py' }).first().waitFor({ timeout: 60000 });
    record('P-1', 'A 恢复项目 A', true);

    // 打开 B
    await main.evaluate((p) => window.__TAURI_INTERNALS__.invoke('open_workspace_window', { path: p }), WS_B);
    let winB = null;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const now = allPages(browser);
      winB = now.find((p) => p !== main && p.url().includes('localhost:5173'));
      if (winB) break;
      await sleep(500);
    }
    if (!winB) {
      record('P-2', 'B 窗口出现', false);
      return;
    }
    await dismissBlockingModals(winB);
    await winB.locator('#tree .tree-item .name', { hasText: 'b_project.py' }).first().waitFor({ timeout: 60000 });
    record('P-2', 'B 窗口出现且树渲染', true);

    // 抓 B console 里的「文件监听启动失败」
    const bWarns = [];
    winB.on('console', (m) => {
      if (m.text().includes('文件监听')) bWarns.push(m.text());
    });

    // 注入事件探针（A/B 都装，等 B 稳定 2s 后再装，避免打断 open 流程）
    await sleep(2000);
    await installFsProbe(main, 'A');
    await installFsProbe(winB, 'B');

    // —— 复刻 multi-window-real 的前置条件，逐段 bisect ——
    // 前置 1：B 打开 b_project.py（Monaco + LSP 就绪）
    await winB.locator('#tree .tree-item .name', { hasText: 'b_project.py' }).first().dblclick();
    await winB.locator('.monaco-editor').first().waitFor({ timeout: 30000 });
    try {
      await winB.waitForFunction(
        () => (document.querySelector('#status-lsp')?.textContent || '').includes('就绪'),
        undefined,
        { timeout: 60000 },
      );
      record('P-2b', 'B 打开文件且 LSP 就绪', true);
    } catch (e) {
      record('P-2b', 'B 打开文件且 LSP 就绪', false, String(e).split('\n')[0]);
    }
    // 前置 2：A 也打开文件并等 LSP（对齐 multi-window 的 MC-REAL-LSP-1）
    await main.locator('#tree .tree-item .name', { hasText: 'a_project.py' }).first().dblclick();
    await main.locator('.monaco-editor').first().waitFor({ timeout: 30000 });
    await sleep(2000);

    // 写 A → 应触发
    writeFileSync(path.join(WS_A, 'probe_a.py'), '# probe A\n', 'utf8');
    await sleep(4000);
    await probeResult(main, 'A（写 A 后）');
    await probeResult(winB, 'B（写 A 后）');

    // 写 B → 观察点
    writeFileSync(path.join(WS_B, 'probe_b.py'), '# probe B\n', 'utf8');
    await sleep(4000);
    const bLog = await probeResult(winB, 'B（写 B 后）');
    await probeResult(winB, 'B（终态）');

    // B 的树终态
    const tree = await winB.evaluate(() =>
      Array.from(document.querySelectorAll('#tree .tree-item .name')).map((n) => n.textContent || ''),
    );
    console.log(`[探针] B 树终态: [${tree.join(',')}]`);
    console.log(`[探针] B console「文件监听」相关: ${bWarns.length ? bWarns.join(' | ') : '（无）'}`);

    // 二分结论
    const bGotB = Array.isArray(bLog) && bLog.some((i) => JSON.stringify(i.payload || {}).includes('probe_b'));
    const bGotA = Array.isArray(bLog) && bLog.some((i) => JSON.stringify(i.payload || {}).includes('probe_a'));
    record('P-3', 'B 收到「写 B」事件（后端 watcher 对 B 正常）', bGotB,
      bGotB ? '' : `B 事件日志: ${JSON.stringify(bLog).slice(0, 300)}`);
    record('P-4', 'B 不串收「写 A」事件', Array.isArray(bLog) && !bGotA, '');
  },
);
