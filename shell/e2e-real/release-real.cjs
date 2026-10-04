/**
 * Release 模式真机验收 —— 对应 docs/debug_acceptance_record.md §五 第 8 项「真安装包验收」。
 *
 * 验的是**安装后的程序**（默认从注册表 HKCU\...\Uninstall\Pylume\InstallLocation 读路径），
 * 而不是构建产物——这才是"安装后能不能真正干活"的实际口径。
 *
 * 覆盖的断言：
 *   1. 安装后的 exe 能启动并加载主界面（release 不走 vite dev，故不占 5173）
 *   2. 隔离数据根下工作区自动恢复
 *   3. 打开 .py → 静态语义引擎就绪（release 下 tool_paths.rs 工具链路径解析可用）
 *   4. **debugpy 随包可用**：点调试出现「加载 debugpy」提示且会话建立
 *   5. 运行脚本 → python 真实执行、输出进终端面板
 *   6. 深/浅双主题截图存档
 *   7. 停止后 python 进程树无残留
 *
 * 与 debug-real.cjs 的关键差异：release 前端无 `__OC_DEBUG_TEST__` 钩子（vite dev 才注入），
 * 且真机窗口的 gutter 像素点击有抖动，故本脚本**不设断点**——第 4 项只断言
 * "debugpy 被定位并加载、会话建立"，断点命中由 debug-real.cjs 的 dev 链路负责。
 *
 * 用法：cd shell && node e2e-real/release-real.cjs
 * 环境变量：OC_RELEASE_EXE（覆盖 exe 路径，默认安装目录）/ OC_CDP_PORT(9223)
 *          / OC_CDP_TIMEOUT(180) / OC_KEEP_APP=1 / OC_REAL_PYTHON（解释器）
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');
const {
  record,
  sleep,
  printSummary,
  writeJsonSummary,
  gitHead,
  presetInterpreter,
  presetRecentWorkspaces,
  countPythonProcs,
  dismissBlockingModals,
  projectHash,
  waitCdpReady,
  portInUse,
  results,
} = require('./lib/real-env.cjs');

const REPO = path.resolve(__dirname, '..', '..');
// 默认验「安装后的程序」；可用 OC_RELEASE_EXE 覆盖为构建产物路径。
// 安装位置从注册表 HKCU\...\Uninstall\Pylume\InstallLocation 读（NSIS currentUser 模式
// 默认装到 %LOCALAPPDATA%\Pylume，但允许 /D= 覆盖，故不能写死）。
function resolveExe() {
  const override = process.env.OC_RELEASE_EXE;
  if (override) return override;
  const candidates = [];
  try {
    const out = require('child_process').execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Pylume" /v InstallLocation',
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const m = out.match(/InstallLocation\s+REG_SZ\s+"([^"]+)"/);
    if (m) candidates.push(path.join(m[1], 'pylume-shell.exe'));
  } catch { /* 未安装 */ }
  candidates.push(
    path.join(REPO, 'shell', 'src-tauri', 'target', 'release', 'pylume-shell.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Pylume', 'pylume-shell.exe'),
    'C:\\Program Files\\Pylume\\pylume-shell.exe',
  );
  const hit = candidates.find((p) => fs.existsSync(p));
  return hit || candidates[0];
}
const EXE = resolveExe();
const CDP_PORT = Number(process.env.OC_CDP_PORT || 9223);
const CDP_TIMEOUT_MS = Number(process.env.OC_CDP_TIMEOUT || 180) * 1000;
const OUT_DIR = path.join(REPO, 'scripts', '_tmp', 'release-real-shots');
const REAL_PYTHON = process.env.OC_REAL_PYTHON || 'D:\\py\\python.exe';

const SCRIPT_PY = [
  'def compute(x):',
  '    y = x + 1',
  '    return y',
  '',
  'def main():',
  '    a = compute(10)',
  '    b = a * 2',
  '    print("RESULT", a, b)',
  '    return b',
  '',
  'if __name__ == "__main__":',
  '    main()',
  '',
].join('\r\n');

function precheckFail(msg) {
  console.error(`\n[预检失败] ${msg}`);
  writeJsonSummary({ suite: 'release-real', ok: false, error: msg, head: gitHead() });
  process.exit(2);
}

async function main() {
  // ---------- 预检 ----------
  for (const [p, why] of [
    [EXE, 'release exe 不存在（先跑 build-release.ps1 或 cargo build --release）'],
    [REAL_PYTHON, '解释器不存在（用 OC_REAL_PYTHON 指定）'],
  ]) {
    if (!fs.existsSync(p)) precheckFail(`${p} —— ${why}`);
  }
  if (await portInUse(CDP_PORT)) precheckFail(`CDP 端口 ${CDP_PORT} 被占用`);
  if (await portInUse(5173)) {
    console.warn('[提示] 5173 被占用（release 模式不走 vite dev，应无影响；若启动异常请先释放）');
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-release-real-'));
  const workspace = path.join(tmp, 'workspace');
  const dataRoot = path.join(tmp, 'data-root');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(dataRoot, 'config'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'script.py'), SCRIPT_PY, 'utf8'); // Node 写：无 BOM
  presetInterpreter(dataRoot, workspace, REAL_PYTHON);
  presetRecentWorkspaces(dataRoot, [workspace]);
  console.log(`[环境] exe: ${EXE}`);
  console.log(`[环境] 工作区: ${workspace}`);
  console.log(`[环境] 数据根: ${dataRoot}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const logPath = path.join(__dirname, '.release-real.log');
  const out = fs.openSync(logPath, 'a');

  // ---------- 启动 release exe（不经 npm/vite） ----------
  console.log('[启动] release exe + CDP …');
  const child = spawn(EXE, [], {
    cwd: path.dirname(EXE),
    env: {
      ...process.env,
      PYLUME_DATA_ROOT: dataRoot,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    },
    stdio: ['ignore', out, out],
  });

  let browser = null;
  const cleanup = () => {
    try { if (browser) browser.close(); } catch { /* 忽略 */ }
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* 已退出 */ }
  };
  process.on('exit', cleanup);

  try {
    await waitCdpReady(CDP_PORT, CDP_TIMEOUT_MS);
    const { chromium } = require(path.join(REPO, 'shell', 'node_modules', 'playwright-core'));
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    const ctx = browser.contexts()[0];
    const allPages = ctx.pages();
    console.log(`[诊断] contexts=${browser.contexts().length} pages=${allPages.length}`);
    for (const p of allPages) {
      console.log(`[诊断]   page url=${p.url()} title=${JSON.stringify((await p.title().catch(() => '')) || '')}`);
    }
    const page = allPages.find((p) => p.url().includes('localhost')) || allPages[0];
    if (!page) precheckFail('未找到主窗口 page');
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    // release 前端可能需要几秒解包/初始化，等主界面锚点出现而不是立即判定
    await page.locator('#run-group, .menubar').first()
      .waitFor({ state: 'attached', timeout: 30000 }).catch(() => {});
    await sleep(1500);

    // 1 release exe 启动 + 主界面
    const brand = await page.locator('#run-group, .menubar').first().isVisible().catch(() => false);
    const bodyInfo = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      hasRunGroup: !!document.getElementById('run-group'),
      bodyLen: (document.body && document.body.innerHTML.length) || 0,
      head: (document.body && document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    })).catch((e) => ({ err: String(e).split('\n')[0] }));
    record('REL-1', 'release exe 启动并加载主界面（不经 vite dev）', brand,
      `exe mtime=${fs.statSync(EXE).mtime.toISOString().slice(0, 16)} 菜单栏可见=${brand} ${JSON.stringify(bodyInfo)}`);

    await dismissBlockingModals(page);

    // 2 工作区恢复
    let treeOk = true;
    try {
      await page.locator('#tree .tree-item .name', { hasText: 'script.py' })
        .first().waitFor({ timeout: 60000 });
    } catch { treeOk = false; }
    record('REL-2', '隔离数据根下工作区自动恢复（文件树可见）', treeOk);

    // 3 打开 py → 静态语义引擎就绪（验证 release 下工具链路径解析可用：tool_paths.rs 定位 pyrefly/uv）
    // 判定口径：#status-engine 显示具体引擎名（pyrefly / basedpyright），即引擎进程已起来；
    // 不依赖"starting"文案（各版本文案不同，易误判）。
    let lspOk = false;
    let lspDetail = '';
    try {
      await page.locator('#tree .tree-item .name', { hasText: 'script.py' }).first().dblclick();
      await page.locator('.monaco-editor').first().waitFor({ timeout: 30000 });
      for (let i = 0; i < 60; i++) {
        const engine = ((await page.locator('#status-engine').textContent().catch(() => '')) || '').trim();
        const lsp = ((await page.locator('#status-lsp').textContent().catch(() => '')) || '').trim();
        const interp = ((await page.locator('#status-interpreter').textContent().catch(() => '')) || '').trim();
        lspDetail = `engine="${engine}" lsp="${lsp}" 解释器="${interp}"`;
        if (/pyrefly|basedpyright|ruff|pyright/i.test(engine)) { lspOk = true; break; }
        await sleep(1000);
      }
    } catch (e) { lspDetail = String(e).split('\n')[0]; }
    record('REL-3', '打开 .py → 静态语义引擎就绪（release 下工具链路径解析可用）', lspOk, lspDetail);

    // 4 debugpy 随包可用 —— 正面断言：点调试后 debugpy 子进程真的被拉起（python.exe 数量增加），
    // 且状态条/提示里不出现"找不到 debugpy"。release 无 __OC_DEBUG_TEST__ 钩子、gutter 点击有抖动，
    // 故不断言断点命中（那属于 debug-real.cjs 的 dev 链路）。
    await page.locator('#tab-debug').click();
    await sleep(1200);
    const pyBeforeDbg = countPythonProcs();
    let dbgText = '';
    let dbgPhase = 'no-hint';
    try {
      // 必须真正点启动按钮：切到调试面板不会拉起 debugpy（这是我第一版的 bug）
      await page.locator('#btn-debug').click();
      const hint = page.locator('#debug-starting-hint');
      await hint.waitFor({ state: 'visible', timeout: 20000 });
      dbgText = ((await hint.textContent()) || '').replace(/\s+/g, ' ').trim();
      dbgPhase = 'starting-hint';
      for (let i = 0; i < 30; i++) {
        if (!(await hint.isVisible().catch(() => false))) { dbgPhase = 'session-established'; break; }
        await sleep(1000);
      }
    } catch {
      // 无 starting 提示也可能已直接就绪；用状态条兜底取文案
      dbgText = ((await page.locator('#debug-status, .debug-status').first()
        .textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      dbgPhase = dbgText ? 'status-only' : 'no-hint';
    }
    await sleep(2000);
    // 判据说明（第一版用"python 进程数 +1"是错的）：
    //   无断点时 debuggee 跑完即退出，等我采样时进程已恢复，进程数恒为 1→1。
    //   正面证据是「调试器启动中…（首次启动需加载 debugpy，请稍候）」这条提示——
    //   它只在前端已定位到随包 debugpy 并决定加载时才出现，随后 hint 消失即会话建立。
    const spawned = dbgPhase === 'session-established';
    const notFound = /找不到|not found|缺失|不存在|无法定位/i.test(dbgText);
    record('REL-4', 'debugpy 随包可用：点调试出现「加载 debugpy」提示且会话建立（release 下随包定位成功）',
      spawned && !notFound,
      `阶段=${dbgPhase} 文案="${dbgText.slice(0, 100)}" python 进程 ${pyBeforeDbg} -> ${countPythonProcs()}`);
    // 收尾：若调试会话仍在跑，停掉，避免影响后续用例与进程清理断言
    await page.locator('#debug-stop').click().catch(() => {});
    await sleep(3000);

    // 5 运行脚本 → python 真实执行
    const pyBefore = countPythonProcs();
    let runOk = false, runDetail = '';
    try {
      await page.locator('#btn-run-script').click();
      for (let i = 0; i < 40; i++) {
        await sleep(1000);
        const term = await page.locator('#terminal, .terminal, #view-terminal')
          .first().textContent().catch(() => '');
        if (/RESULT\s+11\s+22/.test(term || '')) { runOk = true; runDetail = '输出含 RESULT 11 22'; break; }
        runDetail = (term || '').replace(/\s+/g, ' ').trim().slice(-160);
      }
    } catch (e) { runDetail = String(e).split('\n')[0]; }
    record('REL-5', '运行脚本 → python 真实执行，输出 RESULT 11 22 进终端面板', runOk, runDetail);

    // 6 截图存档
    let shotOk = false, shotDetail = '';
    try {
      for (const theme of ['dark', 'light']) {
        await page.evaluate((th) => { document.documentElement.dataset.theme = th; }, theme);
        await sleep(600);
        const f = path.join(OUT_DIR, `release-${theme}.png`);
        await page.screenshot({ path: f });
        if (fs.existsSync(f)) shotOk = true;
      }
      shotDetail = `${OUT_DIR}/release-dark.png / release-light.png`;
      await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    } catch (e) { shotDetail = String(e).split('\n')[0]; }
    record('REL-6', '深/浅双主题截图存档（release 形态）', shotOk, shotDetail);

    // 7 停止 + 进程树清理
    await page.locator('#btn-stop').click().catch(() => {});
    await sleep(5000);
    const pyAfter = countPythonProcs();
    const noResidue = pyBefore >= 0 && pyAfter >= 0 ? pyAfter <= pyBefore : true;
    record('REL-7', '停止后 python 进程树无残留', noResidue, `python 进程 ${pyBefore} -> ${pyAfter}`);
  } catch (e) {
    record('REL-99', 'release 模式验收中断', false, String(e).split('\n').slice(0, 3).join(' | '));
  } finally {
    const failed = printSummary('Release 模式真机验收（安装包技术实质替代）', process.env.OC_KEEP_APP === '1');
    writeJsonSummary({
      suite: 'release-real',
      head: gitHead(),
      exe: EXE,
      workspace,
      dataRoot,
      cdpPort: CDP_PORT,
    });
    cleanup();
    process.exitCode = failed > 0 ? 1 : 0;
  }
}

void main();
