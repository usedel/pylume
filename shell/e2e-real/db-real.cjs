/**
 * SQLite 数据库工具 · 真机 CDP 验收（v1.4 编辑器 Tab 化形态，对应 doc §17.7 待办 ① ②）。
 * 运行：node e2e-real/db-real.cjs   （在 shell/ 下；预检 5173/9223 空闲）
 * 环境变量：OC_CDP_PORT / OC_CDP_TIMEOUT / OC_KEEP_APP=1（保留现场）
 *
 * 与 mock 层 e2e 的区别：真实 rusqlite 进程内库 + 真实 Tauri 命令 + 真实 WebView2 布局。
 * ＋ 添加与导出 CSV 走原生文件对话框，用 SendKeys 尽力自动化（失败会在 detail 里注明）。
 *
 * ⚠ v1.4 重写说明（2026-10-03）：§17 把数据面从侧栏搬进编辑器区 Tab，本脚本随之重写。
 * 旧 v1.0 侧栏态的 `#db-result-grid` / `#db-sql-host` / `#db-conn-select` / `#db-next` /
 * `#db-export` / `#db-writable` / `#db-result-status` 等 id 已被重设计整体移除——旧脚本在
 * v1.4 下**跑不过**（这也是 §17.7「真机待办」此前未被发现的副作用：脚本没跟上重设计）。
 * 用例编号从 S10.3-x 改为 T14-x，覆盖 §17.7 的五项新链路：
 * 双击开表 Tab / 排序三态 / 筛选 / 导出 / 多 Tab 独立 + 双主题截图存档。
 */
'use strict';

const { spawn, spawnSync, execSync } = require('child_process');
const { mkdtempSync, mkdirSync, writeFileSync, existsSync, openSync, readFileSync } = require('fs');
const os = require('os');
const path = require('path');

const env = require('./lib/real-env.cjs');
const { chromium } = require('@playwright/test');

const PYTHON = process.env.OC_REAL_PYTHON || 'D:\\py\\python.exe';
const CDP_PORT = Number(process.env.OC_CDP_PORT || 9223);
const CDP_TIMEOUT = Number(process.env.OC_CDP_TIMEOUT || 600) * 1000;
const OUT_DIR = path.join(__dirname, '..', '..', 'scripts', '_tmp');

const { record, sleep, portInUse, waitCdpReady, dismissBlockingModals, printSummary } = env;

// ———————————————— conn_id 复现（Rust DefaultHasher = SipHash-1-3, keys 0,0） ————————————————

const U64 = (1n << 64n) - 1n;
function rotl64(x, b) { return ((x << b) | (x >> (64n - b))) & U64; }
function sipround(v) {
  v[0] = (v[0] + v[1]) & U64; v[1] = rotl64(v[1], 13n); v[1] ^= v[0]; v[0] = rotl64(v[0], 32n);
  v[2] = (v[2] + v[3]) & U64; v[3] = rotl64(v[3], 16n); v[3] ^= v[2];
  v[0] = (v[0] + v[3]) & U64; v[3] = rotl64(v[3], 21n); v[3] ^= v[0];
  v[2] = (v[2] + v[1]) & U64; v[1] = rotl64(v[1], 17n); v[1] ^= v[2]; v[2] = rotl64(v[2], 32n);
}
function siphash13(data) {
  let v0 = 0x736f6d6570736575n, v1 = 0x646f72616e646f6dn, v2 = 0x6c7967656e657261n, v3 = 0x7465646279746573n;
  const v = [v0, v1, v2, v3];
  const len = data.length;
  let i = 0;
  for (; i + 8 <= len; i += 8) {
    let m = 0n;
    for (let j = 7; j >= 0; j--) m = (m << 8n) | BigInt(data[i + j]);
    v[3] ^= m; sipround(v); v[0] ^= m;
  }
  let last = BigInt(len & 0xff) << 56n;
  for (let j = i; j < len; j++) last |= BigInt(data[j]) << BigInt(8 * (j - i));
  v[3] ^= last; sipround(v); v[0] ^= last;
  v[2] ^= 0xffn;
  for (let r = 0; r < 3; r++) sipround(v);
  return v[0] ^ v[1] ^ v[2] ^ v[3];
}
/** 对齐 db_cmds.rs::conn_id：canonicalize（Windows verbatim \\?\ 前缀）→ to_lowercase → hash */
function computeConnId(absPath) {
  const canon = '\\\\?\\' + absPath.replace(/\//g, '\\');
  const bytes = [...Buffer.from(canon.toLowerCase(), 'utf8'), 0xff];
  return 'db-' + siphash13(bytes).toString(16).padStart(16, '0');
}

// ———————————————— 页面辅助 ————————————————

const db = (page, id) => page.locator(`#${id}`);

async function appReady(page) {
  await page.locator('#tab-database').waitFor({ state: 'visible', timeout: 60_000 });
}

/** 等待自动连接完成：树里出现指定表节点且带行数（v1.4 侧栏无连接下拉） */
async function waitConnected(page, tableName, rowCountText) {
  try {
    await db(page, 'db-tree').waitFor({ state: 'visible', timeout: 15_000 });
    await page
      .locator(`#db-tree .db-tree-item[data-name="${tableName}"]`, { hasText: rowCountText })
      .waitFor({ state: 'visible', timeout: 30_000 });
  } catch (e) {
    const tree = (await db(page, 'db-tree').textContent().catch(() => '(树区不可读)')) || '';
    throw new Error(`${e.message.split('\n')[0]}\n[诊断] 树区="${tree.trim().slice(0, 400)}"`);
  }
}

/**
 * v1.4（§17 编辑器 Tab 化）：数据面全在编辑器区 Tab，SQL 编辑器随查询 Tab 创建。
 * 旧 v1.0 侧栏态的 `#db-sql-host` / `#db-result-grid` / `#db-next` 等 id 已被重设计移除。
 */
const DATA_PREFIX = 'db-data:';
const QUERY_PREFIX = 'db-query:';

/** v1.4 当前激活的数据/查询视图容器（两套共享 DOM，按 activeTab 切 hidden） */
function activeView(page) {
  return page.locator('#db-data-view:not(.hidden), #db-query-view:not(.hidden)');
}

function dataView(page) {
  return page.locator('#db-data-view');
}

function queryView(page) {
  return page.locator('#db-query-view');
}

/** 打开查询 Tab（点侧栏 header 的「新建查询」），返回是否成功 */
async function openQueryTab(page) {
  await db(page, 'db-new-query').click();
  await queryView(page).locator('.db-tab-grid').waitFor({ state: 'visible', timeout: 15_000 });
}

/** 查询 Tab 的 Monaco：点击聚焦 → 全选 → 输入（末尾 Esc 关掉建议弹层，防遮挡后续点击） */
async function setSql(page, text) {
  const host = queryView(page).locator('#db-query-editor-host');
  await host.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type(text, { delay: 4 });
  await page.keyboard.press('Escape');
}

/** 轮询等待元素属性变为期望值 */
async function waitForAttr(page, selector, attr, value, timeoutMs = 10_000) {
  const t0 = Date.now();
  for (;;) {
    const v = await page.locator(selector).getAttribute(attr).catch(() => null);
    if (v === value) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`${selector} 的 ${attr} ${timeoutMs}ms 内未变为 ${value}（当前 ${v}）`);
    await sleep(200);
  }
}

async function runCurrent(page) {
  await page.keyboard.press('Control+Enter');
}

async function statusText(page) {
  return (await activeView(page).locator('.db-tab-status').textContent()) || '';
}

/** 轮询等待状态条变为期望值（含/不含某子串） */
async function waitStatusHas(page, substr, timeoutMs = 30_000) {
  const t0 = Date.now();
  for (;;) {
    const s = await statusText(page);
    if (s.includes(substr)) return s;
    if (Date.now() - t0 > timeoutMs) throw new Error(`状态条 ${timeoutMs}ms 内未出现「${substr}」: ${s}`);
    await sleep(150);
  }
}

async function waitStatusNot(page, substr, timeoutMs = 20_000) {
  const t0 = Date.now();
  for (;;) {
    const s = await statusText(page);
    if (!s.includes(substr)) return s;
    if (Date.now() - t0 > timeoutMs) throw new Error(`状态条 ${timeoutMs}ms 内未离开「${substr}」: ${s}`);
    await sleep(150);
  }
}

/** 网格行数（v1.4 网格在 .db-tab-grid 内，行号列 .db-rowno） */
async function gridRowCount(page) {
  return activeView(page).locator('.db-tab-grid tbody tr').count();
}

async function rowNumbers(page) {
  return activeView(page).locator('.db-tab-grid tbody .db-rowno').allTextContents();
}

/** 原生对话框 SendKeys（尽力而为） */
function sendKeysToNativeDialog(text) {
  const ps = path.join(OUT_DIR, '_native_keys.ps1');
  writeFileSync(
    ps,
    [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Start-Sleep -Milliseconds 1200',
      '[System.Windows.Forms.SendKeys]::SendWait("^a")',
      'Start-Sleep -Milliseconds 250',
      `[System.Windows.Forms.SendKeys]::SendWait("${text}")`,
      'Start-Sleep -Milliseconds 250',
      '[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")',
      '',
    ].join('\r\n'),
    'utf8',
  );
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps], {
    timeout: 20_000,
    encoding: 'utf8',
  });
  return r.status === 0;
}

/** 应用启动（独立实现以支持第二轮重启复用同一数据根） */
function startApp(dataRoot, logPath) {
  const logFd = openSync(logPath, 'a');
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
  return child;
}

async function connectPage() {
  await waitCdpReady(CDP_PORT, CDP_TIMEOUT);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  // WebView2 先起 about:blank 再导航到 devUrl：轮询等真实应用页面就绪
  const t0 = Date.now();
  for (;;) {
    const pages = env.allPages(browser);
    const main = pages.find((p) => p.url().includes(env.DEV_URL_HOST));
    if (main) {
      try {
        await main.locator('#tab-database').waitFor({ state: 'attached', timeout: 5000 });
        return { browser, page: main };
      } catch { /* 页面尚在加载，继续等 */ }
    }
    if (Date.now() - t0 > 60_000) throw new Error('60s 内未等到应用页面（devUrl=' + env.DEV_URL_HOST + '）');
    await sleep(1000);
  }
}

async function openDbView(page) {
  for (let i = 0; i < 3; i++) {
    await db(page, 'tab-database').click().catch(() => {});
    try {
      await page.locator('#view-database').waitFor({ state: 'visible', timeout: 4000 });
      return;
    } catch { /* 可能被首启弹窗/加载吃掉点击，重试 */ }
  }
  throw new Error('切到数据库视图失败（#view-database 未出现）');
}

async function killTree(child) {
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* 已退出 */ }
}

/** taskkill 树杀不死 WebView2 子进程：按命令行特征清掉占 CDP 端口的孤儿实例 */
function killWebviewLeftovers(port) {
  try {
    execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='msedgewebview2.exe'\\" | Where-Object { $_.CommandLine -like '*remote-debugging-port=${port}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
      { stdio: 'ignore' },
    );
  } catch { /* 无残留 */ }
  try { execSync('taskkill /IM pylume-shell.exe /F 2>nul', { stdio: 'ignore' }); } catch { /* 无残留 */ }
}

// ———————————————— 主流程 ————————————————

(async () => {
  // 预检
  if (await portInUse(5173)) { console.error('[预检失败] 5173 被占用，先停 vite/tauri dev'); process.exit(2); }
  if (await portInUse(CDP_PORT)) { console.error(`[预检失败] CDP ${CDP_PORT} 被占用`); process.exit(2); }
  if (!existsSync(PYTHON)) { console.error(`[预检失败] Python 不存在: ${PYTHON}`); process.exit(2); }

  // fixture
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'oc-db-real-'));
  const workspace = path.join(tmp, 'workspace');
  const dataRoot = path.join(tmp, 'data-root');
  mkdirSync(path.join(dataRoot, 'config'), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const dbPath = path.join(tmp, 'charm.db');
  const pyScript = path.join(OUT_DIR, 'make_db_fixture.py');
  const py = spawnSync(PYTHON, ['-X', 'utf8', pyScript, dbPath], { encoding: 'utf8' });
  if (py.status !== 0 || !existsSync(dbPath)) {
    console.error('[预检失败] 造数失败: ' + (py.stderr || py.stdout));
    process.exit(2);
  }
  record('T14-0', '造数：3 表 1 视图 1 索引 + 万行主表 + 8 列宽表 + 3 行日志表', true, dbPath);

  // 预置连接列表（跳过原生 pick_file；id 必须与 Rust conn_id 一致，否则 db_open 会当成
  // 另一条连接追加，列表出现同名重复项，且重启后 writable/draft 断言取错条目）
  const presetConn = {
    id: computeConnId(dbPath),
    path: dbPath,
    name: 'charm.db',
    writable: false,
    sql: 'SELECT name FROM logs WHERE id = 1;',
    history: [],
  };
  writeFileSync(
    path.join(dataRoot, 'config', 'db_connections.json'),
    JSON.stringify([presetConn], null, 2),
    'utf8',
  );
  env.presetRecentWorkspaces(dataRoot, [workspace]);

  const logPath = path.join(__dirname, '..', '.tauri-dev-db.log');
  writeFileSync(logPath, '');
  console.log(`[环境] 数据根: ${dataRoot}\n[启动] npm run tauri dev（日志: ${logPath}）…`);
  let child = startApp(dataRoot, logPath);
  let browser = null;
  const exportCsvPath = path.join(tmp, 'export-out', 'users-export.csv');
  mkdirSync(path.dirname(exportCsvPath), { recursive: true });

  try {
    const conn1 = await connectPage();
    browser = conn1.browser;
    const page = conn1.page;
    console.log(`[连接] 页面: ${page.url()}`);
    await dismissBlockingModals(page);
    await appReady(page);

    // ── T14-1 侧栏资源管理器：3 表 1 视图 1 索引 + 行数 + 单击展开列（PK/NN） ──
    await openDbView(page);
    await waitConnected(page, 'users', '10000 行');
    const groups = await page.locator('#db-tree .db-tree-group').allTextContents();
    const okTree = groups.length === 3
      && groups[0].includes('表 (3)')
      && groups[1].includes('视图 (1)')
      && groups[2].includes('索引 (1)');
    record('T14-1', '＋预置连接自动打开：3 表 1 视图 1 索引、万行表行数正确', okTree, groups.join(' | '));

    const usersItem = page.locator('#db-tree .db-tree-item[data-name="users"]');
    await usersItem.click();
    const colBox = usersItem.locator('.db-tree-cols');
    const colVisible = await colBox.isVisible().catch(() => false);
    const col0 = (await colBox.locator('.db-tree-col').nth(0).textContent().catch(() => '')) || '';
    const col1 = (await colBox.locator('.db-tree-col').nth(1).textContent().catch(() => '')) || '';
    const idxHasCols = (await page
      .locator('#db-tree .db-tree-item[data-name="idx_users_name"] .db-tree-cols').count()) === 0;
    record('T14-2', '单击表节点展开列（名 + 类型 + PK/NN），索引节点无子项',
      colVisible && /id/.test(col0) && /INTEGER/.test(col0) && /PK/.test(col0) && /NN/.test(col1) && idxHasCols,
      `可见=${colVisible} col0="${col0.trim()}" col1="${col1.trim()}" 索引无列=${idxHasCols}`);

    // ── T14-3 双击表 → 编辑器区数据 Tab（v1.4 最常用路径） ──
    // 必须点 .db-tree-name 文本：T14-2 已展开列清单，item 盒变高，
    // dblclick 默认取盒中心会落在 .db-tree-cols 上导致命中漂移（实测会误开相邻的 wide）
    await usersItem.locator('.db-tree-name').dblclick();
    await db(page, 'db-tab-panel').waitFor({ state: 'visible', timeout: 15_000 });
    await dataView(page).locator('table.db-grid').waitFor({ state: 'visible', timeout: 15_000 });
    const dvTitle = (await db(page, 'db-data-title').textContent().catch(() => '')) || '';
    const tabPath = (await page.locator('.tab[data-path^="db-data:"]').first().getAttribute('data-path').catch(() => '')) || '';
    const head = await dataView(page).locator('.db-tab-grid thead th').allTextContents();
    const s3 = await waitStatusHas(page, '行');
    const rows3 = await gridRowCount(page);
    const editorHidden = await page.locator('#editor').isHidden().catch(() => true);
    record('T14-3', '双击表节点 → 编辑器区数据 Tab（宿主可见 / 与 #editor 互斥 / 标题=表名 / 全列渲染 / 200 行每页 / 状态条含只读）',
      dvTitle.trim() === 'users'
        && tabPath.startsWith(DATA_PREFIX)
        && head.length >= 2
        && head[1] === 'id'
        && rows3 === 200
        && /200\/10000 行/.test(s3)
        && /只读/.test(s3)
        && editorHidden,
      `标题="${dvTitle.trim()}" tab="${tabPath}" 列头=${head.join(',')} 行数=${rows3} 状态="${s3.trim()}" #editor隐藏=${editorHidden}`);

    // ── T14-4 列头点击排序三态（升 → 降 → 无），每次翻回第 1 页 ──
    const idTh = dataView(page).locator('.db-tab-grid thead th:has-text("id")').first();
    const sortSeq = [];
    for (const want of ['ascending', 'descending', null]) {
      await idTh.click();
      await sleep(700);
      const aria = await idTh.getAttribute('aria-sort').catch(() => null);
      sortSeq.push(aria);
      if (aria !== want) {
        // 容错：状态条可能已报未变化，仍以 aria 为准记录
      }
    }
    const firstRowAsc = (await rowNumbers(page))[0];
    // 再走一轮 升序，验证数据真的按 id 升序（首行 id 应为 1）
    await idTh.click();
    await sleep(700);
    const ascId = (await dataView(page).locator('.db-tab-grid tbody tr').first()
      .locator('td').nth(1).textContent()) || '';
    const ascAria = await idTh.getAttribute('aria-sort').catch(() => null);
    await idTh.click();
    await sleep(700);
    const descAria = await idTh.getAttribute('aria-sort').catch(() => null);
    const descId = (await dataView(page).locator('.db-tab-grid tbody tr').first()
      .locator('td').nth(1).textContent()) || '';
    const ascPage = (await db(page, 'db-data-page-label').textContent().catch(() => '')) || '';
    const okSort = sortSeq[0] === 'ascending' && sortSeq[1] === 'descending' && sortSeq[2] === null
      && ascAria === 'ascending' && descAria === 'descending'
      && ascId.trim() === '1' && Number(descId) > Number(ascId);
    record('T14-4', '列头排序三态（升→降→无，aria-sort 正确）且数据真按 id 升降序、每次翻回第 1 页',
      okSort, `三态序列=${JSON.stringify(sortSeq)} 升序首行 id=${(ascId || '').trim()} 降序首行 id=${(descId || '').trim()} 页码="${ascPage.trim()}" 首行号=${firstRowAsc}`);

    // 复位到无排序
    await idTh.click();
    await sleep(600);

    // ── T14-5 筛选条：回车应用（id > 9900 → 100 行），Esc 清除恢复全量 ──
    const filter = db(page, 'db-data-filter');
    await filter.fill('id > 9900');
    await filter.press('Enter');
    const s5 = await waitStatusHas(page, '行');
    const rows5 = await gridRowCount(page);
    const label5 = (await db(page, 'db-data-page-label').textContent().catch(() => '')) || '';
    await filter.press('Escape');
    await sleep(800);
    const rows5b = await gridRowCount(page);
    const s5b = await waitStatusHas(page, '200/10000');
    const filterCleared = (await db(page, 'db-data-filter').inputValue().catch(() => '')) === '';
    // 状态条口径：筛选后「当前页/筛选结果总行数」，故为 100/100 行（不是 100/10000）
    record('T14-5', '筛选回车应用（id > 9900 → 100 行 / 第 1/1 页），Esc 清除输入并恢复 200/10000',
      rows5 === 100 && /第 1\/1 页/.test(label5) && /100\/100 行/.test(s5) && rows5b === 200
        && filterCleared && /200\/10000 行/.test(s5b),
      `筛选后行数=${rows5} 页码="${label5.trim()}" 状态="${s5.trim()}" 清除后行数=${rows5b} 输入已清=${filterCleared} 状态="${s5b.trim()}"`);

    // ── T14-6 分页：下一页行号 201…400；改每页行数为 100 → 100 行 ──
    // 注意：等待条件要具体。泛匹配 '行' 会命中加载态文案里的其它文本，
    // 且每页行数改变后总行数不变（200→100 是"每页"变，总数仍 10000）。
    const pageBefore = (await rowNumbers(page))[0];
    await db(page, 'db-data-next').click();
    const s6a = await waitStatusHas(page, '200/10000');
    const rn6 = await rowNumbers(page);
    const okPage6 = rn6[0] === '201' && rn6[rn6.length - 1] === '400' && rn6.length === 200;
    await db(page, 'db-data-page-size').selectOption('100');
    const s6b = await waitStatusHas(page, '100/10000');
    const rows6 = await gridRowCount(page);
    const label6 = (await db(page, 'db-data-page-label').textContent().catch(() => '')) || '';
    record('T14-6', '数据 Tab 分页：下一页行号 201…400 连续；每页行数改 100 后行数与页数同步（100 行 / 100 页）',
      okPage6 && rows6 === 100 && /100\/10000 行/.test(s6b) && /第 1\/100 页/.test(label6),
      `原首行=${pageBefore} 翻页首=${rn6[0]} 末=${rn6[rn6.length - 1]} 共=${rn6.length} 翻页状态="${s6a.trim()}" 改100后行数=${rows6} 页码="${label6.trim()}" 状态="${s6b.trim()}"`);
    await db(page, 'db-data-page-size').selectOption('200');
    await waitStatusHas(page, '200/10000');
    await sleep(400);

    // ── T14-7 单元格详情：点单元格出详情面板（列名 + 行号 + 完整值）+ 复制值按钮 ──
    // ⚠ 实测发现：面板内唯一按钮是「复制值」，**没有关闭按钮**，showCellDetail()
    //   也不提供隐藏路径 → 详情面板一旦打开只能靠点其他单元格覆盖内容。
    //   已登记为缺陷 D-6（可用性），本条按现有行为断言，不假装有关闭能力。
    const cell = dataView(page).locator('.db-tab-grid tbody tr').nth(1).locator('td').nth(1);
    await cell.click();
    const detail = dataView(page).locator('.db-cell-detail');
    await detail.waitFor({ state: 'visible', timeout: 8000 });
    const dHead = (await detail.locator('.db-cell-detail-head').textContent().catch(() => '')) || '';
    const dBody = (await detail.locator('.db-cell-detail-body').textContent().catch(() => '')) || '';
    const copyBtn = detail.locator('button');
    const btnText = (await copyBtn.textContent().catch(() => '')) || '';
    const btnCount = await detail.locator('button').count();
    await copyBtn.click();
    await sleep(500);
    const copyToast = await page.locator('.toast.toast--success').first().textContent().catch(() => '');
    const stillOpen = await detail.isVisible().catch(() => false);
    record('T14-7', '点击单元格 → 详情面板显示（列名 + 行号 + 值）+ 复制值按钮出成功 toast',
      /id/.test(dHead) && /#2/.test(dHead) && dBody.trim() === '2'
        && btnCount === 1 && /复制/.test(btnText) && !!copyToast && stillOpen,
      `head="${dHead.trim().slice(0, 60)}" body="${dBody.trim().slice(0, 40)}" 按钮数=${btnCount} 按钮="${btnText.trim()}" toast="${(copyToast || '').trim().slice(0, 30)}" 面板仍在=${stillOpen}（无关闭按钮，见 D-6）`);

    // ── T14-8 右键复制整行（JSON / CSV），各出成功 toast ──
    const rcCell = dataView(page).locator('.db-tab-grid tbody tr').nth(0).locator('td').nth(1);
    await rcCell.click({ button: 'right' });
    await page.locator('#ctx-menu').waitFor({ state: 'visible', timeout: 8000 });
    await page.locator('#ctx-menu').getByText('复制整行为 JSON').click();
    const toastJson = await page.locator('.toast.toast--success').first()
      .textContent().catch(() => '');
    await rcCell.click({ button: 'right' });
    await page.locator('#ctx-menu').waitFor({ state: 'visible', timeout: 8000 });
    await page.locator('#ctx-menu').getByText('复制整行为 CSV').click();
    const toastCsv = await page.locator('.toast.toast--success').first()
      .textContent().catch(() => '');
    record('T14-8', '单元格右键菜单：复制整行为 JSON / 复制整行为 CSV 各出成功 toast',
      !!toastJson && !!toastCsv,
      `JSON toast="${(toastJson || '').trim().slice(0, 40)}" CSV toast="${(toastCsv || '').trim().slice(0, 40)}"`);

    // ── T14-9 导出 CSV（原生保存对话框 SendKeys 尽力自动化，最多重试 3 次） ──
    await dataView(page).locator('.db-tab-grid tbody tr').first().waitFor({ state: 'visible' });
    let csvOk = false;
    let detail9 = '';
    for (let attempt = 0; attempt < 3 && !csvOk; attempt++) {
      await db(page, 'db-data-export').click();
      const keysOk = sendKeysToNativeDialog(exportCsvPath);
      for (let i = 0; i < 20 && !existsSync(exportCsvPath); i++) await sleep(500);
      if (existsSync(exportCsvPath)) {
        const buf = readFileSync(exportCsvPath);
        const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
        const text = buf.toString('utf8').replace(/^\ufeff/, '');
        const lines = text.split(/\r\n/).filter((l) => l.length > 0);
        const headLine = lines[0] || '';
        // 导出的是当前筛选/排序后的结果集上限（EXPORT_MAX_ROWS），行数按内容实算
        csvOk = hasBom && headLine.startsWith('id,name') && lines.length >= 2;
        detail9 = `BOM=${hasBom} 表头="${headLine}" 数据行=${lines.length - 1}`;
        break;
      } else {
        detail9 = `第 ${attempt + 1} 次尝试未产出文件（SendKeys=${keysOk ? '已发送' : '失败'}）`;
        sendKeysToNativeDialog('{ESC}');
        await sleep(800);
      }
    }
    record('T14-9', '数据 Tab 导出 CSV：BOM + 表头含 id 列 + 数据行', csvOk, exportCsvPath + ' <- ' + detail9);

    // ── T14-10 多 Tab 独立：再开 1 个表 Tab + 1 个查询 Tab，切回首个数据 Tab 数据仍在 ──
    const tabCountBefore = await page.locator(`.tab[data-path^="${DATA_PREFIX}"], .tab[data-path^="${QUERY_PREFIX}"]`).count();
    await page.locator('#db-tree .db-tree-item[data-name="wide"] .db-tree-name').dblclick();
    await sleep(1200);
    await openQueryTab(page);
    const tabCountAfter = await page
      .locator(`.tab[data-path^="${DATA_PREFIX}"], .tab[data-path^="${QUERY_PREFIX}"]`).count();
    const firstDataTab = page.locator(`.tab[data-path^="${DATA_PREFIX}"]`).first();
    const firstPath = (await firstDataTab.getAttribute('data-path').catch(() => '')) || '';
    await firstDataTab.click();
    await sleep(800);
    const backTitle = (await db(page, 'db-data-title').textContent().catch(() => '')) || '';
    const backRows = await gridRowCount(page);
    const backStatus = await statusText(page);
    record('T14-10', '多 Tab 独立：表 Tab + 查询 Tab 并存，切回首个数据 Tab 标题与结果集保持（不重查）',
      tabCountAfter === tabCountBefore + 2 && backTitle.trim() === 'users' && backRows === 200
        && /200\/10000 行/.test(backStatus),
      `Tab 数 ${tabCountBefore}→${tabCountAfter} 切回标题="${backTitle.trim()}" 行数=${backRows} 状态="${backStatus.trim()}" 首Tab=${firstPath}`);

    // ── T14-11 查询 Tab：Ctrl+Enter 执行 + 耗时 + 行数 ──
    await openQueryTab(page);
    await setSql(page, "SELECT id, name FROM users WHERE name LIKE '%user_004%'");
    await runCurrent(page);
    await waitStatusNot(page, '执行中', 30_000);
    const s11 = await statusText(page);
    const m11 = s11.match(/(\d+)\s*ms/);
    const rows11 = await gridRowCount(page);
    record('T14-11', "查询 Tab：Ctrl+Enter 执行 LIKE 查询，结果非空且状态条显示耗时",
      rows11 > 0 && !!m11 && Number(m11[1]) >= 0 && /行/.test(s11),
      `行数=${rows11} 状态="${s11.trim()}"`);

    // ── T14-12 失败 SQL：状态条错误态 + toast，且不崩 Tab ──
    const rowsBefore12 = await gridRowCount(page);
    await setSql(page, 'SELECT * FROM 不存在的表');
    await runCurrent(page);
    await sleep(1200);
    const s12 = await statusText(page);
    const statusErr = await queryView(page).locator('.db-tab-status.is-error').count();
    const dataStatusErr = await dataView(page).locator('.db-tab-status.is-error').count();
    const toastErr = await page.locator('.toast.toast--error').first()
      .textContent().catch(() => '');
    const tabAlive = await page.locator(`.tab[data-path^="${QUERY_PREFIX}"]`).count();
    record('T14-12', '失败 SQL → 状态条错误态 + error toast，Tab 存活（未崩溃）',
      (statusErr + dataStatusErr) > 0 && !!toastErr && tabAlive > 0,
      `状态条="${s12.trim().slice(0, 80)}" is-error=${statusErr + dataStatusErr} toast="${(toastErr || '').trim().slice(0, 50)}" 查询Tab数=${tabAlive} 切换前行数=${rowsBefore12}`);

    // ── T14-13 只读拒写 → 开可写（二次确认）→ DELETE 生效 ──
    await setSql(page, 'DELETE FROM logs');
    await runCurrent(page);
    await sleep(1000);
    const blockedToast = await page.locator('.toast').first().textContent().catch(() => '');
    const s13a = await statusText(page);
    const blocked = /只读/.test(s13a) || /只读/.test(blockedToast || '');
    // 树内行内可写锁（v1.4：连接节点上的 .db-conn-lock，aria-pressed 表达状态）
    const lock = page.locator('#db-tree .db-conn-lock').first();
    const lockCount = await page.locator('#db-tree .db-conn-lock').count();
    await lock.click();
    await page.locator('#confirm-modal').waitFor({ state: 'visible', timeout: 8000 });
    await db(page, 'confirm-ok').click();
    await sleep(2000); // 重开连接是异步的
    const pressed = await lock.getAttribute('aria-pressed').catch(() => null);
    const s13b = await setSql(page, 'DELETE FROM logs').then(async () => {
      await runCurrent(page);
      const modal = page.locator('#confirm-modal');
      if (await modal.isVisible().catch(() => false)) await db(page, 'confirm-ok').click();
      return waitStatusHas(page, '影响', 30_000);
    });
    const okWrite = blocked && pressed === 'true' && /影响/.test(s13b) && s13b.includes('3');
    record('T14-13', '只读拒写（toast/状态条提示只读）；树内开可写（二次确认）后 DELETE 影响 3 行',
      okWrite,
      `拦截=${blocked} 锁控件数=${lockCount} aria-pressed=${pressed} "${s13b.trim()}"`);

    // ── T14-14 慢查询取消（目标 ≤3000ms 回可交互） ──
    await setSql(page,
      'WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM cnt WHERE x < 100000000) SELECT COUNT(*) FROM cnt');
    await runCurrent(page);
    await waitStatusHas(page, '执行中');
    const t0 = Date.now();
    const cancelBtn = db(page, 'db-query-cancel');
    await cancelBtn.click();
    await waitStatusNot(page, '执行中', 10_000);
    await waitStatusNot(page, '取消中', 10_000);
    const cancelMs = Date.now() - t0;
    const s14 = await statusText(page);
    record('T14-14', `慢查询取消：点击取消后 ${cancelMs}ms 回到可交互（目标 ≤3000ms）`, cancelMs <= 3000, s14.trim());

    // R9 双主题截图（v1.4 形态：编辑器区数据 Tab + 侧栏资源管理器）
    await page.locator(`.tab[data-path^="${DATA_PREFIX}"]`).first().click();
    await sleep(900);
    await page.setViewportSize({ width: 1366, height: 900 });
    await sleep(300);
    const shotDir = path.join(OUT_DIR, 'db-v14-shots');
    mkdirSync(shotDir, { recursive: true });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((th) => { document.documentElement.dataset.theme = th; }, theme);
      await sleep(600);
      const f = path.join(shotDir, `db-v14-${theme}.png`);
      await page.screenshot({ path: f });
      if (!existsSync(f)) throw new Error(`截图未产出: ${f}`);
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    record('T14-15', '深/浅双主题截图已存档（侧栏资源管理器 + 编辑器区数据 Tab）', true,
      `${shotDir}/db-v14-light.png / db-v14-dark.png`);

    // R8 退出清理 + 重启持久化
    await sleep(2500); // 等草稿 2s 防抖落盘
    await killTree(child);
    await sleep(1500);
    let leftover = '';
    try {
      const tl = execSync('tasklist /FO CSV /NH', { encoding: 'utf8' });
      leftover = tl.split(/\r?\n/).filter((l) => /pylume/i.test(l)).join('; ');
    } catch { leftover = '(tasklist 失败)'; }
    let lockFree = false;
    for (let i = 0; i < 20 && !lockFree; i++) {
      // 杀进程后 Windows 释放句柄有延迟，轮询重试
      try { closeSyncSafe(openSync(dbPath, 'r+')); lockFree = true; } catch { await sleep(500); }
    }
    record('T14-16a', '退出后无残留进程、SQLite 文件句柄已释放', !leftover && lockFree,
      `残留进程: ${leftover || '无'}；句柄: ${lockFree ? '已释放' : '10s 后仍被占用'}`);

    // 等 5173 释放，避免第二轮 vite 起在别的端口导致页面失联
    for (let i = 0; i < 40 && (await portInUse(5173)); i++) await sleep(500);
    killWebviewLeftovers(CDP_PORT); // 孤儿 WebView2 可能仍占 CDP 端口，会把第二轮连接引到死会话
    for (let i = 0; i < 20 && (await portInUse(CDP_PORT)); i++) await sleep(500);
    console.log('[重启] 第二轮启动（同一数据根）…');
    child = startApp(dataRoot, logPath);
    const conn2 = await connectPage();
    browser = conn2.browser;
    const page2 = conn2.page;
    await dismissBlockingModals(page2);
    await appReady(page2);
    await openDbView(page2);
    await waitConnected(page2, 'users', '10000 行');
    // v1.4：侧栏无连接下拉。连接节点是 .db-conn-node（带 data-id），表节点才是 .db-tree-item
    const connNode = await page2.locator('#db-tree .db-conn-node[data-id]').count();
    const lockNode = await page2.locator('#db-tree .db-conn-lock').count();
    const treeHasUsers = await page2.locator('#db-tree .db-tree-item[data-name="users"]').count();
    // 草稿持久化以落盘 JSON 为准（Monaco DOM 文本提取不稳定）
    const savedList = JSON.parse(readFileSync(path.join(dataRoot, 'config', 'db_connections.json'), 'utf8'));
    const savedConn = savedList.find((c) => c.id === presetConn.id);
    // 草稿是"最后一次编辑的查询内容"：本轮最后在查询 Tab 输了慢查询并取消，
    // 落盘的应是那条 SQL（而非 v1.0 脚本里的固定 LIMIT 20）
    const draftSaved = !!savedConn && /RECURSIVE/i.test(savedConn.sql || '');
    const writablePersisted = !!savedConn && savedConn.writable === true;
    const historySaved = Array.isArray(savedConn?.history) && savedConn.history.length > 0;
    record('T14-16b', '重开后：连接树节点（含可写锁）恢复、可写标志持久化、SQL 草稿与执行历史均在',
      savedList.length === 1 && connNode > 0 && lockNode > 0 && treeHasUsers > 0
        && draftSaved && writablePersisted && historySaved,
      `条目数=${savedList.length} 连接节点=${connNode} 锁=${lockNode} 表节点=${treeHasUsers} 落盘草稿="${(savedConn?.sql || '').slice(0, 46)}" writable=${savedConn?.writable} 历史条数=${savedConn?.history?.length}`);
  } catch (e) {
    console.error(`\n[运行中断] ${e.message || e}`);
    try {
      console.error('—— tauri dev 日志尾部 ——\n' + readFileSync(logPath, 'utf8').slice(-2000));
    } catch { /* 无日志 */ }
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (process.env.OC_KEEP_APP === '1') {
      console.log(`\n[保留] 应用未杀（OC_KEEP_APP=1），pid=${child.pid}；临时目录: ${tmp}`);
    } else {
      await killTree(child);
      try { execSync('taskkill /IM pylume-shell.exe /F 2>nul', { stdio: 'ignore' }); } catch { /* 已退出 */ }
    }
  }

  const failed = printSummary('SQLite 工具真机验收（v1.4 编辑器 Tab 化 · §17.7）', process.env.OC_KEEP_APP === '1');
  process.exit(failed > 0 ? 1 : 0);
})();

function closeSyncSafe(fd) {
  try { require('fs').closeSync(fd); } catch { /* ignore */ }
}
