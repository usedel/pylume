/**
 * 端点工具窗真机（Real App）CDP 复现/验收脚本 — EP-REAL-1..3
 * （对应 docs/pycharm_framework_support_report.md §8.3 F1/F2：用户实测报告
 *   「打开 D:\aipro\cb_watcher\backend，端点侧栏点击各端点均报『打开文件失败』」）
 *
 * 与 e2e/ux/02-frameworks.spec.ts（浏览器 mock）分层：mock 桥的 fs read_file 对相对路径
 * 会 join 仓库根兜底，**复现不了**真实 Rust read_file 只认绝对路径的契约缺口——
 * 本脚本驱动真实 Tauri 应用 + 真实工作区，验证端点行点击 → openFile → read_file 全链路。
 *
 * 用法：
 *   cd shell
 *   node e2e-real/endpoints-real.cjs
 *
 * 环境变量：
 *   OC_WORKSPACE    目标工作区（默认 D:\aipro\cb_watcher\backend；需依赖声明含 fastapi/flask
 *                   且源码有 app 声明，端点侧栏才有内容）
 *   OC_CDP_PORT / OC_CDP_TIMEOUT / OC_KEEP_APP   同 debug-real.cjs
 *
 * 判定（EP-REAL-3）：
 *   点击端点行后，活动标签应为「声明文件 basename」；
 *   失败且出现「打开文件失败」toast = 复现（修复前态）。
 */
'use strict';

const { runWithRealApp, record, dismissBlockingModals } = require('./lib/real-env.cjs');

const WORKSPACE = process.env.OC_WORKSPACE || 'D:\\aipro\\cb_watcher\\backend';

async function activeTabName(page) {
  return page.evaluate(() => document.querySelector('#tabbar .tab.active .name')?.textContent ?? null);
}

/** 等待「打开文件失败」toast；出现返回 toast 文本，超时返回 null */
async function waitOpenFailToast(page, timeoutMs) {
  try {
    const el = page.locator('#toast-stack .toast', { hasText: '打开文件失败' }).first();
    await el.waitFor({ timeout: timeoutMs });
    return (await el.textContent()) || '(空 toast)';
  } catch {
    return null;
  }
}

async function runChecks(page) {
  await dismissBlockingModals(page);

  // EP-REAL-1 工作区自动恢复
  try {
    await page.locator('#tree .tree-item').first().waitFor({ timeout: 60000 });
    record('EP-REAL-1', '工作区自动恢复（文件树可见）', true);
  } catch (e) {
    record('EP-REAL-1', '工作区自动恢复（文件树可见）', false, String(e).split('\n')[0]);
    return;
  }

  // EP-REAL-2 端点侧栏扫描出结果
  await page.locator('#tab-endpoints').click();
  try {
    await page.locator('#ep-results .todo-item').first().waitFor({ timeout: 30000 });
  } catch (e) {
    const summary = await page.evaluate(() => document.getElementById('ep-summary')?.textContent ?? '(no #ep-summary)');
    record('EP-REAL-2', '端点侧栏扫描出结果（#ep-results 有条目）', false,
      String(e).split('\n')[0] + ` | summary=[${summary}]（确认工作区依赖声明含 fastapi/flask 且源码有 app 声明）`);
    return;
  }
  const rows = await page.locator('#ep-results .todo-item').count();
  const firstRoute = (await page.locator('#ep-results .ep-route').first().textContent()) || '';
  const firstLoc = (await page.locator('#ep-results .todo-loc').first().textContent()) || '';
  // loc 形如 "basename:line"（endpointView 用 basename(m.file) 渲染，不含盘符冒号歧义）
  const expectBase = firstLoc.replace(/:\d+\s*$/, '');
  record('EP-REAL-2', `端点扫描出结果（${rows} 项；首项 ${firstRoute} @ ${firstLoc}）`, true);

  // EP-REAL-3 点击端点行 → 应打开声明文件（活动标签 = basename）
  const first = page.locator('#ep-results .todo-item').first();
  await first.click();
  const failToast = await waitOpenFailToast(page, 8000);
  const tab = await activeTabName(page);
  const opened = tab !== null && tab === expectBase;
  if (opened) {
    record('EP-REAL-3', `点击端点行打开声明文件（活动标签=${tab}，期望=${expectBase}）`, true);
  } else {
    const extra = failToast ? `>>> 复现：出现「打开文件失败」toast [${failToast.trim().slice(0, 120)}]` : `未出现失败 toast`;
    record('EP-REAL-3', `点击端点行打开声明文件（活动标签=${tab}，期望=${expectBase}）`, false, extra);
  }

  // EP-REAL-4 抽查第二个端点（若有）：同一契约不应只对首项成立
  if (rows >= 2) {
    const loc2 = (await page.locator('#ep-results .todo-loc').nth(1).textContent()) || '';
    const base2 = loc2.replace(/:\d+\s*$/, '');
    await page.locator('#ep-results .todo-item').nth(1).click();
    const failToast2 = await waitOpenFailToast(page, 8000);
    const tab2 = await activeTabName(page);
    const opened2 = tab2 !== null && tab2 === base2;
    record('EP-REAL-4', `第二端点同契约（活动标签=${tab2}，期望=${base2}）`, opened2,
      failToast2 ? `>>> 复现：[${failToast2.trim().slice(0, 120)}]` : '');
  }
}

runWithRealApp(
  {
    tmpPrefix: 'oc-endpoints-real-',
    logName: '.tauri-dev.log',
    summaryTitle: '真机 CDP 验收结果',
    requirePaths: [
      { path: WORKSPACE, message: '工作区不存在', hint: '用 OC_WORKSPACE 指定' },
    ],
    setupFixtures({ dataRoot }) {
      const { writeFileSync } = require('fs');
      const path = require('path');
      // 隔离数据根：recent-workspaces 指向真实目标工作区；不预置解释器（端点扫描纯文件操作，
      // 与解释器无关——顺带覆盖「未配解释器」的默认路径）
      writeFileSync(
        path.join(dataRoot, 'config', 'recent-workspaces.json'),
        JSON.stringify([WORKSPACE]),
        'utf8',
      );
      console.log(`[环境] 工作区: ${WORKSPACE}`);
    },
  },
  async (s) => {
    await runChecks(s.page);
  },
);
