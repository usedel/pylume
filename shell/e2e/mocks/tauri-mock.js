/**
 * Tauri API mock（E2E 专用，注入到浏览器页面——见 e2e/helpers.ts 的 equipPage）。
 *
 * !!! 本文件必须是【纯 JavaScript】：内容作为源码字符串经 page.addInitScript 注入，
 * !!! 浏览器直接执行，任何 TypeScript 语法（type/as）都会 SyntaxError。
 *
 * 浏览器模式下 @tauri-apps/api 的 invoke 依赖 window.__TAURI_INTERNALS__.invoke。
 * 依据 node_modules/@tauri-apps/api（v2）真实实现逐一对齐：
 *  - invoke（core.js）→ __TAURI_INTERNALS__.invoke(cmd, args)
 *  - listen（event.js）→ invoke("plugin:event|listen", { event, target, handler: transformCallback(handler) })
 *    transformCallback → __TAURI_INTERNALS__.transformCallback(cb, once) 返回 id；
 *    事件触发 = 直接调用注册表回调（payload 形如 { event, id, payload }）
 *  - unlisten（event.js v2.1+）→ __TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener + invoke
 *  - getCurrentWindow（window.js）→ 读 metadata.currentWindow.label 构造 Window；
 *    其余窗口方法全部走 invoke("plugin:window|*")
 *
 * 命令分三类：
 *  1. git_*：经 window.__E2E_BRIDGE__("git", cmd, args) 转发到 Playwright 侧真实临时 git 仓库
 *  2. 环境探测/工具链：返回「全部就绪」静态值，避免启动期弹引导窗
 *  3. 其余（设置/文件/事件/窗口）：安全默认值，保证应用完整渲染
 */
(function installTauriMock() {
  if (window.__TAURI_INTERNALS__) return; // HMR 重载防重复注入

  var callbacks = new Map();
  var eventHandlers = new Map(); // callbackId → event name
  var callbackSeq = 0;
  /** 诊断/测试侧可读：invoke 调用流水（最近 200 条） */
  var invokeLog = [];
  window.__TAURI_MOCK_INVOKE_LOG__ = invokeLog;

  var SETTINGS = {
    // 批 4：自定义主题名（须与 src/theme/tokens.ts 的 EDITOR_THEME_DARK 一致，
    // 由 __tests__/themeTokens.test.ts 的「e2e mock 默认主题」断言钉死）。
    theme: "pylume-dark",
    font_size: 14,
    font_family: "",
    font_ligatures: true,
    autosave: "off",
    tab_size: 4,
    insert_spaces: true,
    word_wrap: "off",
    minimap: true,
    lsp_engine: "pyrefly",
    runtime_intel_enabled: false,
    reduce_motion: false,
    keybindings: {},
  };

  var FS_CMDS = ["list_dir", "read_dir", "read_file", "read_file_base64", "write_file", "create_dir",
    "create_file", "create_py_package",
    "rename_path", "paste_path", "delete_file", "watch_start", "watch_stop", "create_project"];

  function bridge() {
    return window.__E2E_BRIDGE__;
  }

  /** 静态返回表（启动链路 + 低频命令的安全默认值） */
  var staticHandlers = {
    "plugin:event|listen": function () { return null; },
    "plugin:event|unlisten": function () { return null; },
    // 窗口操作（main.ts 自绘标题栏 + snap 拉伸）：成功即够用
    "plugin:window|is_maximized": function () { return false; },
    "plugin:window|toggle_maximize": function () { return null; },
    "plugin:window|minimize": function () { return null; },
    "plugin:window|close": function () { return null; },
    "plugin:window|start_dragging": function () { return null; },
    "plugin:window|start_resize_dragging": function () { return null; },
    // 设置：支持测试侧经 window.__E2E_SETTINGS_PRESET__（addInitScript 预置）按字段覆写。
    // 基线 SETTINGS 的 autosave 保持 "off"——存量 spec（dirty tab 保护 / 关闭确认等语义）依赖它；
    // autosave 验收 spec（e2e/autosave/）用 preset 显式开启 delay/blur。
    get_settings: function () {
      var merged = {}, k;
      for (k in SETTINGS) merged[k] = SETTINGS[k];
      var preset = window.__E2E_SETTINGS_PRESET__;
      if (preset) for (k in preset) merged[k] = preset[k];
      return merged;
    },
    save_settings: function () { return null; },
    // 工具链探测：全就绪 → 不弹安装引导（maybePromptToolchain 静默通过）
    detect_toolchain: function () {
      return {
        uv: { name: "uv", command: "uv", ok: true },
        engines: [
          { name: "pyrefly", command: "pyrefly", ok: true },
          { name: "basedpyright", command: "basedpyright", ok: true },
        ],
        ruff: { name: "ruff", command: "ruff", ok: true },
        current_engine: { name: "pyrefly", command: "pyrefly", ok: true },
        all_ok: true,
      };
    },
    // 首启/存储：空态
    storage_stats: function () { return null; },
    // 剪贴板 / 外部打开 / 资源管理器
    copy_to_clipboard: function () { return null; },
    open_external: function () { return null; },
    reveal_in_explorer: function () { return null; },
    // 运行配置 / LSP（E2E 不触达）
    sweep_run_configs: function () { return null; },
    allow_asset_dir: function () { return null; },
    add_recent_workspace: function () { return null; },
    clear_recent_workspaces: function () { return null; },
    remove_recent_workspace: function () { return null; },
    // 数组型命令：前端多处 for...of 直接迭代，null 会抛 "list is not iterable"
    get_breakpoints: function () { return []; },
    get_bookmarks: function () { return []; },
    run_config_list: function () { return []; },
    list_python_versions: function () { return []; },
    // F9：新建 FastAPI 项目的依赖安装（uv add）——mock 返回 exit 0（成功路径；
    // 输出无真实 uv 流，pip-stdout 事件不发也不影响：前端只回显 cmd 行 + busy 复位）
    pip_install: function () { return 0; },
    // PR-2 插件域（plugin_cmds.rs）：watch/reveal 静态即可；list/read/scaffold/get_plugins_dir 走 plugins bridge
    watch_plugins_dir: function () { return null; },
    unwatch_plugins_dir: function () { return null; },
    reveal_plugins_dir: function () { return null; },
    // 应用版本（loader 的 engines 兼容检查用，@tauri-apps/api/app::getVersion）
    "plugin:app|version": function () { return "0.1.0"; },
    // 剪贴板读（devtools paste 按钮 / facade readClipboard / C-5 与剪贴板对比）
    // 测试可经 window.__E2E_CLIPBOARD__ 预置文本（未预置 = 空串）
    "plugin:clipboard-manager|read_text": function () {
      return window.__E2E_CLIPBOARD__ !== undefined ? window.__E2E_CLIPBOARD__ : "";
    },
    // ruff lint / 保存时动作（FormatResult 形状：formatted=null = 失败不阻断保存；
    // mock 不接真实 ruff，仅让 format_python/optimize_imports 命令出现在 invoke 流水里
    // 供 A-S-3 断言「autosave 不跑 ruff、显式保存才跑」的调用时序）
    format_python: function () { return { formatted: null, message: "E2E mock：ruff 未接入" }; },
    optimize_imports: function () { return { formatted: null, message: "E2E mock：ruff 未接入" }; },
    // ruff lint / 终端 shell 探测（近期功能：mock 兜底防 null 被迭代 pageerror）
    // PR-L：测试可经 window.__E2E_RUFF_LINT__ 预置诊断数组（RuffDiagnostic 形状）；无预置返回空
    ruff_lint: function () {
      var preset = window.__E2E_RUFF_LINT__;
      return Array.isArray(preset) ? preset : [];
    },
    list_shells: function () { return ["pwsh", "powershell", "cmd"]; },
    // Python 求值桥（库特别支持 PR-1）：四态可切。
    // 测试经 window.__E2E_PY_EVAL__ = { mode, data, error } 预置：
    //   mode="ok"（默认）    → {"ok":true,"data":...}（data 未预置时回显 argsJson）
    //   mode="err"           → {"ok":false,"error":preset.error || "re.error: ..."}
    //   mode="timeout"       → reject "Timeout: ..."（libEval 分流为 timeout 态）
    //   mode="noInterpreter" → reject "NoInterpreter: ..."（分流为 noInterpreter 态）
    py_eval: function (args) {
      var preset = window.__E2E_PY_EVAL__ || {};
      var mode = preset.mode || "ok";
      if (mode === "noInterpreter") throw new Error("NoInterpreter: E2E mock 未找到可用解释器");
      if (mode === "timeout") throw new Error("Timeout: E2E mock 模拟求值超时（3s）");
      if (mode === "err") {
        return JSON.stringify({ ok: false, error: preset.error || "re.error: missing ), unterminated subpattern at position 0" });
      }
      var data = preset.data;
      if (data === undefined) {
        // 默认：与 RegexEvalData 形状对齐的空结果（无匹配）
        data = { match: null, matches: [], count: 0, truncated: false };
      }
      return JSON.stringify({ ok: true, data: data });
    },
    // P2：文件对话框（plugin-dialog）——测试经 window.__E2E_DIALOG_PRESET__ 预置返回值
    // （open/save 无预置时返回 null = 用户取消，避免用例挂起）
    "plugin:dialog|open": function () {
      return (window.__E2E_DIALOG_PRESET__ && window.__E2E_DIALOG_PRESET__.open) || null;
    },
    "plugin:dialog|save": function () {
      return (window.__E2E_DIALOG_PRESET__ && window.__E2E_DIALOG_PRESET__.save) || null;
    },
    // 调试环境探测：全就绪 → 不弹「缺失 debugpy」引导（runDebug 直接进 DAP 握手）
    debug_detect: function () {
      return { debugpyOk: true, debugpyDir: "C:\\mock\\vendor\\debugpy", depFound: false, depFiles: [] };
    },
    // 运行/调试配置：返回空配置（调用方用 .catch(()=>({})) 兜底，但非空解析值会绕过 .catch）
    get_run_config: function () {
      return { args: "", env: [], scriptPath: "", cwd: null };
    },
    // 断点持久化：工作区打开时回填为空（E2E 不依赖盘上断点）
    get_breakpoints: function () {
      return [];
    },
    // A-1 资源快照（面板 E2E）：固定样本（外壳 + 两个子进程）
    proc_stats: function () {
      return {
        shell: { pid: 4242, name: "Pylume（外壳）", rssMb: 182.3, cpu: 0 },
        children: [
          { pid: 5151, name: "pyrefly.exe", rssMb: 96.4, cpu: 1.2 },
          { pid: 5152, name: "python.exe", rssMb: 48.1, cpu: 0 },
        ],
        totalMb: 326.8,
      };
    },
  };

  /** 同上：已知返回数组的命令（未在静态表时兜底 []，防 for...of 崩 / .find 抛 TypeError）
   *  list_pythons 曾缺失 → maybePromptVenv 里 pythons.find 抛错炸掉 openWorkspace 后半段 */
  var ARRAY_CMDS = ["get_breakpoints", "get_bookmarks", "run_config_list", "list_python_versions", "list_pythons",
    "list_workspace_files", "dep_env_snapshot", "get_recent_files"];

  /** bridge 缺失时 git 命令的空返回（形状与 Rust 对齐，防前端渲染崩） */
  function gitFallback(cmd) {
    switch (cmd) {
      case "git_status": return { files: [], is_git: false, current_branch: null };
      case "git_log": return [];
      case "git_stash_list": return [];
      case "git_branches": return [];
      case "git_blame": return [];
      default: return "";
    }
  }

  // ============ B3 数据库工具窗桩（sqliteView.ts / db_cmds.rs）============
  // 浏览器 E2E 里没有真实 SQLite（rusqlite 是 Rust 侧进程内库），这里做形状级替身：
  //   - 命令返回严格对齐 db_cmds.rs 的 serde camelCase 形状，让前端渲染逻辑走真实分支；
  //   - 默认样本 = 1 个连接 + 2 张表 1 个视图 1 个索引 + 250 行结果（>200 才能测翻页）；
  //   - 测试经 window.__E2E_DB__ 预置覆写（见各 spec）：
  //       { connections, objects, result, ddl, pick, failQuery, failOpen, writable }
  //   - 写盘类命令把最后一次入参留在 window.__E2E_DB_SAVED__，供断言「草稿/历史是否落库」。

  /** 默认连接（只读） */
  var DB_CONN = {
    id: "db-0000000000000001",
    path: "C:\\e2e\\app.db",
    name: "app.db",
    writable: false,
    sql: "",
    history: [],
  };

  /** 默认对象树：表 2 / 视图 1 / 索引 1（含行数与列，覆盖树渲染的全部字段） */
  var DB_OBJECTS = [
    { name: "users", kind: "table", sql: 'CREATE TABLE "users" (id INTEGER PRIMARY KEY, name TEXT NOT NULL, note TEXT)',
      rowCount: 250, columns: [
        { name: "id", declType: "INTEGER", pk: true, notNull: false },
        { name: "name", declType: "TEXT", pk: false, notNull: true },
        { name: "note", declType: "TEXT", pk: false, notNull: false },
      ] },
    { name: "logs", kind: "table", sql: 'CREATE TABLE "logs" (ts TEXT, msg TEXT)',
      rowCount: 12, columns: [
        { name: "ts", declType: "TEXT", pk: false, notNull: false },
        { name: "msg", declType: "TEXT", pk: false, notNull: false },
      ] },
    { name: "active_users", kind: "view", sql: 'CREATE VIEW "active_users" AS SELECT * FROM users WHERE id > 0',
      rowCount: 250, columns: [{ name: "id", declType: "INTEGER", pk: false, notNull: false }] },
    { name: "idx_users_name", kind: "index", sql: 'CREATE INDEX "idx_users_name" ON users(name)',
      rowCount: null, columns: null },
  ];

  /** 默认结果：250 行（含 NULL 与空串，覆盖特殊单元格渲染） */
  var DB_ROWS = [];
  for (var dri = 1; dri <= 250; dri++) {
    DB_ROWS.push([String(dri), dri % 7 === 0 ? null : "user" + dri, dri % 5 === 0 ? "" : "note " + dri]);
  }

  function dbPreset() {
    return window.__E2E_DB__ || {};
  }

  function dbBasename(p) {
    var s = String(p || "");
    var i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return i >= 0 ? s.slice(i + 1) : s;
  }

  // 内存连接列表：复刻 Rust 侧 db_connections.json 的读写语义——
  // 首次 load 按预置初始化，之后 db_open（合并写入）/ db_connections_save（整表覆盖）都落在同一份上。
  var dbSaved = null;
  var dbAuto = null;

  function dbList() {
    if (dbSaved) return dbSaved;
    if (!dbAuto) dbAuto = (dbPreset().connections || [DB_CONN]).slice();
    return dbAuto;
  }

  function dbStore(list) {
    if (dbSaved) dbSaved = list;
    else dbAuto = list;
  }

  function dbHandle(cmd, args) {
    var p = dbPreset();
    if (cmd === "db_connections_load") return dbList();
    if (cmd === "db_connections_save") {
      window.__E2E_DB_SAVED__ = args && args.list;
      dbSaved = (args && args.list) || [];
      return null;
    }
    if (cmd === "db_open") {
      if (p.failOpen) throw new Error("DbInvalidPath:" + (p.failOpen === true ? "ext:txt" : String(p.failOpen)));
      var list = dbList();
      var known = null;
      for (var k = 0; k < list.length; k++) if (list[k].path === args.path) known = list[k];
      var entry = {
        id: known ? known.id : "db-" + (1000000000000000 + list.length),
        path: args.path,
        name: dbBasename(args.path),
        writable: !!args.writable,
        sql: (known && known.sql) || "",
        history: (known && known.history) || [],
      };
      var out = list.slice();
      var idx = -1;
      for (var k2 = 0; k2 < out.length; k2++) if (out[k2].id === entry.id) idx = k2;
      if (idx >= 0) out[idx] = entry;
      else out.push(entry);
      dbStore(out);
      return entry;
    }
    if (cmd === "db_close") return null;
    if (cmd === "db_list_objects") {
      if (p.failList) throw new Error("DbSqlError:" + String(p.failList));
      return p.objects || DB_OBJECTS;
    }
    if (cmd === "db_query") {
      // 记录查询流水：断言「执行当前语句 / 执行全部」到底发了哪几条 SQL（只记 cmd 名不够）
      (window.__E2E_DB_QUERIES__ = window.__E2E_DB_QUERIES__ || []).push(String(args.sql || ""));
      if (p.failQuery) throw new Error("DbSqlError:" + (p.failQuery === true ? 'near "SELEC": syntax error' : String(p.failQuery)));
      if (p.result) return p.result;
      var sql = String(args.sql || "");
      // 写语句：回空结果集 + affected（对齐 Rust 的写路径）
      if (/^\s*(insert|update|delete|replace|create|drop|alter|pragma|vacuum|begin|commit|rollback)\b/i.test(sql)) {
        return { columns: [], rows: [], total: 0, offset: 0, truncated: false, elapsedMs: 1, affected: 1 };
      }
      var off = Number(args.offset) || 0;
      var lim = Number(args.limit) || 200;
      return {
        columns: ["id", "name", "note"],
        rows: DB_ROWS.slice(off, off + lim),
        total: DB_ROWS.length,
        offset: off,
        truncated: false,
        elapsedMs: 3,
        affected: null,
      };
    }
    if (cmd === "db_rows") {
      // 表数据 Tab（v1.4 Tab 化）：记录结构化参数供断言；排序/筛选做形状级模拟
      (window.__E2E_DB_ROWS__ = window.__E2E_DB_ROWS__ || []).push({
        name: args.name,
        sort: args.sort ?? null,
        dir: args.dir ?? null,
        filter: args.filter ?? null,
        limit: args.limit,
        offset: args.offset,
      });
      if (p.failQuery) throw new Error("DbSqlError:" + (p.failQuery === true ? 'near "SELEC": syntax error' : String(p.failQuery)));
      var roff = Number(args.offset) || 0;
      var rlim = Number(args.limit) || 200;
      var rows = DB_ROWS.slice();
      if (args.sort === "id") {
        rows.sort(function (a, b) {
          var d = Number(a[0]) - Number(b[0]);
          return (args.dir === "desc" ? -1 : 1) * d;
        });
      }
      if (args.filter) {
        var mgt = /id\s*>\s*(\d+)/.exec(args.filter);
        var meq = /name\s*=\s*'([^']*)'/.exec(args.filter);
        if (mgt) rows = rows.filter(function (r) { return Number(r[0]) > Number(mgt[1]); });
        else if (meq) rows = rows.filter(function (r) { return r[1] === meq[1]; });
      }
      return {
        columns: ["id", "name", "note"],
        rows: rows.slice(roff, roff + rlim),
        total: rows.length,
        offset: roff,
        truncated: false,
        elapsedMs: 3,
        affected: null,
      };
    }
    if (cmd === "db_cancel") return null;
    if (cmd === "db_ddl") {
      if (p.ddl) return p.ddl;
      return 'CREATE TABLE "users" (\n  id INTEGER PRIMARY KEY,\n  name TEXT NOT NULL\n)';
    }
    return undefined;
  }

  // ============ LSP mock（代码补全 / 跳转定义 / Hover）============
  // 静态引擎（pyrefly/basedpyright）在浏览器 E2E 里没有真实进程，这里做协议级替身：
  //   - lsp_send_request → 按 method 分发到下方语义函数，结果经 "lsp-message" 事件回灌 client 的 pending；
  //   - lsp_send_notification → 维护文档镜像（didOpen/didChange/didSave 全量同步）。
  // 语义有意精简，只覆盖「已知符号跳转 / 函数 docstring hover / 变量类型成员补全」三类，
  // 与真实 pyrefly 对齐到足以驱动 UI 断言（避免本文件膨胀成完整 Python 索引器）。

  function emitEvent(event, payload) {
    eventHandlers.forEach(function (eventName, id) {
      if (eventName !== event) return;
      var entry = callbacks.get(id);
      if (entry) {
        entry.cb({ event: event, id: 1, payload: payload });
        if (entry.once) {
          callbacks.delete(id);
          eventHandlers.delete(id);
        }
      }
    });
  }

  // ============ 调试 DAP mock（E2E 专用，无真实 debugpy）============
  // 模拟 stdio adapter 架构的 DAP 时序：debug_start → initialize → attach →
  // debugpyWaitingForServer → debug_attach_debuggee → initialized → setBreakpoints
  // → configurationDone → stopped(at breakpoint)。步进/继续按断点行与帧深推演；
  // 不触达真实进程，仅驱动前端状态机与渲染，用于功能与体验验收。
  var DBG = {
    active: false, path: null, wsRoot: null, bps: {}, attachId: 0,
    currentLine: 0, threadId: 1, frameDepth: 1, failNext: false,
  };
  function dbgBasename(p) { var m = /([^\\/]+)$/.exec(p || ""); return m ? m[1] : (p || "script.py"); }
  function dapRespond(reqId, body) {
    emitEvent("dap-message", { type: "response", request_seq: reqId, success: true, command: "dap", body: body || {} });
  }
  function dapEvent(event, body) {
    emitEvent("dap-message", { type: "event", event: event, body: body || {} });
  }
  function dbgNextBpAfter(line) {
    var lines = (DBG.bps[DBG.path] || []).map(function (b) { return b.line; }).sort(function (a, b) { return a - b; });
    for (var i = 0; i < lines.length; i++) if (lines[i] > line) return lines[i];
    return null;
  }
  function dbgTerminate() {
    dapEvent("continued", { threadId: DBG.threadId });
    dapEvent("terminated", {});
    setTimeout(function () { emitEvent("debug-exited", { reason: "exited" }); }, 30);
  }
  function dbgStopped() {
    setTimeout(function () { dapEvent("stopped", { threadId: DBG.threadId, reason: "breakpoint", hitBreakpointIds: [] }); }, 30);
  }
  // 测试侧控制面：失败注入 / 状态读取（window.__OC_DEBUG__）
  window.__OC_DEBUG__ = {
    reset: function () {
      DBG.active = false; DBG.path = null; DBG.wsRoot = null; DBG.bps = {};
      DBG.attachId = 0; DBG.currentLine = 0; DBG.threadId = 1; DBG.frameDepth = 1; DBG.failNext = false;
    },
    setFailNext: function (v) { DBG.failNext = !!v; },
    state: function () { return { active: DBG.active, path: DBG.path, currentLine: DBG.currentLine, frameDepth: DBG.frameDepth, bps: JSON.parse(JSON.stringify(DBG.bps)) }; },
  };

  function handleDebugCommand(cmd, args) {
    args = args || {};
    if (cmd === "debug_start") {
      if (DBG.failNext) { DBG.failNext = false; throw new Error("debugpy 资源缺失或解释器不可用（E2E 模拟）"); }
      DBG.active = true;
      DBG.path = args.path || null;
      DBG.wsRoot = args.workspaceRoot || null;
      DBG.currentLine = 0; DBG.frameDepth = 1; DBG.attachId = 0;
      emitEvent("debug-started", { port: 0, pid: 5678 });
      return null;
    }
    if (cmd === "debug_attach_debuggee") {
      setTimeout(function () { dapEvent("initialized", {}); }, 30);
      return null;
    }
    if (cmd === "debug_stop") {
      DBG.active = false;
      setTimeout(function () { emitEvent("debug-exited", { reason: "user" }); }, 0);
      return null;
    }
    if (cmd === "dap_send_request") {
      var id = args.id, method = args.method, params = args.params || {};
      if (method === "initialize") {
        dapRespond(id, { supportsConfigurationDoneRequest: true, supportsEvaluateForHovers: true, supportsTerminateRequest: true });
        return null;
      }
      if (method === "attach") {
        DBG.attachId = id;
        setTimeout(function () { dapEvent("debugpyWaitingForServer", { host: "127.0.0.1", port: 0 }); }, 30);
        return null;
      }
      if (method === "setBreakpoints") {
        var sp = (params.source && params.source.path) || DBG.path;
        var reqBps = params.breakpoints || [];
        DBG.bps[sp] = reqBps.map(function (b) { return { line: b.line, condition: b.condition || null, hitCondition: b.hitCondition || null, logMessage: b.logMessage || null }; });
        var verified = reqBps.map(function (b) { return { verified: true, line: b.line, source: { path: sp } }; });
        dapRespond(id, { breakpoints: verified });
        return null;
      }
      if (method === "configurationDone") {
        if (DBG.attachId) dapRespond(DBG.attachId, {});
        var bl = (DBG.bps[DBG.path] || []).map(function (b) { return b.line; }).sort(function (a, b) { return a - b; });
        DBG.currentLine = bl.length ? bl[0] : 1;
        DBG.frameDepth = 1;
        dbgStopped();
        dapRespond(id, {});
        return null;
      }
      if (method === "threads") { dapRespond(id, { threads: [{ id: DBG.threadId, name: "MainThread" }] }); return null; }
      if (method === "stackTrace") {
        var frames = [];
        var names = ["<module>", "compute", "main"];
        for (var i = 0; i < DBG.frameDepth; i++) {
          frames.push({ id: i + 1, name: names[i] || ("frame" + i), source: { path: DBG.path, name: dbgBasename(DBG.path) }, line: DBG.currentLine - i * 2, column: 1 });
        }
        dapRespond(id, { stackFrames: frames, totalFrames: frames.length });
        return null;
      }
      if (method === "scopes") {
        dapRespond(id, { scopes: [{ name: "Locals", presentationHint: "locals", variablesReference: 1000 }, { name: "Globals", presentationHint: "globals", variablesReference: 2000 }] });
        return null;
      }
      if (method === "variables") {
        var ref = params.variablesReference;
        if (ref === 2000) {
          dapRespond(id, { variables: [{ name: "__name__", value: "'__main__'", type: "str", variablesReference: 0 }, { name: "__file__", value: "'" + dbgBasename(DBG.path) + "'", type: "str", variablesReference: 0 }] });
        } else if (ref === 1000) {
          dapRespond(id, { variables: [{ name: "i", value: "3", type: "int", variablesReference: 0 }, { name: "name", value: "'world'", type: "str", variablesReference: 0 }, { name: "data", value: "{...}", type: "dict", variablesReference: 5000 }, { name: "ok", value: "True", type: "bool", variablesReference: 0 }] });
        } else if (ref === 5000) {
          dapRespond(id, { variables: [{ name: "a", value: "1", type: "int", variablesReference: 0 }, { name: "b", value: "2", type: "int", variablesReference: 0 }] });
        } else {
          dapRespond(id, { variables: [] });
        }
        return null;
      }
      if (method === "continue") {
        var nl = dbgNextBpAfter(DBG.currentLine);
        dapRespond(id, { allThreadsContinued: true });
        if (nl == null) dbgTerminate();
        else { DBG.currentLine = nl; dapEvent("continued", { threadId: DBG.threadId }); dbgStopped(); }
        return null;
      }
      if (method === "next") { DBG.currentLine = DBG.currentLine + 1; dapRespond(id, {}); dapEvent("continued", { threadId: DBG.threadId }); dbgStopped(); return null; }
      if (method === "stepIn") { DBG.currentLine = DBG.currentLine + 1; DBG.frameDepth = Math.min(DBG.frameDepth + 1, 3); dapRespond(id, {}); dapEvent("continued", { threadId: DBG.threadId }); dbgStopped(); return null; }
      if (method === "stepOut") {
        DBG.frameDepth = DBG.frameDepth - 1;
        dapRespond(id, {});
        if (DBG.frameDepth < 1) dbgTerminate();
        else { DBG.currentLine = DBG.currentLine + 1; dapEvent("continued", { threadId: DBG.threadId }); dbgStopped(); }
        return null;
      }
      if (method === "pause") { dapRespond(id, {}); return null; }
      if (method === "evaluate") { dapRespond(id, { result: String(params.expression) + " ⇒ <value>", type: "str", variablesReference: 0 }); return null; }
      if (method === "setVariable") { dapRespond(id, { name: params.name, value: params.value, variablesReference: 0 }); return null; }
      dapRespond(id, {}); // 兜底，避免前端 pending 15s 超时
      return null;
    }
    return "__unhandled__";
  }

  // ============ 框架探针表 / Pydantic 引擎推荐 / 端点扫描 mock（P1/F0/F1/F2/F4 E2E）============
  // 状态来源：window.__E2E_FRAMEWORK_PRESET__（addInitScript 预置，见 e2e/ux/02-frameworks.spec.ts）；
  // hints 持久 sessionStorage（reload 后仍在，验证「工作区级关闭」的持久语义——同 save_session 先例）。
  var FW_DEFAULT = {
    deps: "",            // 依赖声明文本（模拟 Rust collect_dep_text）
    hasFastApiApp: false, // 源码有 `app = FastAPI(`
    hasFlaskApp: false,
    hasManagePy: false,
    pydanticStack: false, // detect_pydantic_stack 的依赖命中（fastapi/pydantic）
    hints: {},            // framework_hints（工作区级「不再提示」）
    endpoints: [
      { framework: "fastapi", method: "GET", route: "/health", file: "main.py", line: 5, handler: "health" },
      { framework: "fastapi", method: "POST", route: "/v1/api/users", file: "main.py", line: 9, handler: "create_user" },
      { framework: "fastapi", method: "GET", route: "/v1/api/users/{uid}", file: "routes/users.py", line: 12, handler: "get_user" },
      { framework: "fastapi", method: "WS", route: "/v1/api/ws", file: "routes/ws.py", line: 3, handler: "ws_echo" },
    ],
  };
  function FW_STATE() {
    if (!window.__E2E_FRAMEWORK_STATE__) {
      var fw = JSON.parse(JSON.stringify(FW_DEFAULT));
      try {
        var saved = sessionStorage.getItem("oc-e2e-framework-hints");
        if (saved) fw.hints = JSON.parse(saved);
      } catch (e) { /* sessionStorage 不可用：hints 仅会话内 */ }
      var preset = window.__E2E_FRAMEWORK_PRESET__;
      if (preset) for (var k in preset) fw[k] = preset[k];
      window.__E2E_FRAMEWORK_STATE__ = fw;
    }
    return window.__E2E_FRAMEWORK_STATE__;
  }

  var LSP_KIND_METHOD = 2;
  // 内置类型成员表：type → [ [method, doc] ]
  var LSP_MEMBERS = {
    str: [["upper", "Return a copy converted to uppercase."], ["lower", "Return a copy converted to lowercase."], ["strip", "Strip leading/trailing whitespace."], ["split", "Split into a list of substrings."], ["join", "Concatenate an iterable of strings."], ["replace", "Replace occurrences of a substring."], ["startswith", "Check if the string starts with a prefix."], ["endswith", "Check if the string ends with a suffix."], ["format", "Format the string."], ["find", "Return lowest index of a substring."], ["count", "Count non-overlapping occurrences."], ["capitalize", "Return a capitalized copy."], ["title", "Return a titlecased copy."], ["isdigit", "True if all chars are digits."], ["isalpha", "True if all chars are alphabetic."]],
    list: [["append", "Append an item to the end."], ["extend", "Extend with an iterable."], ["insert", "Insert at index."], ["remove", "Remove first occurrence."], ["pop", "Remove and return item at index."], ["clear", "Remove all items."], ["index", "Return first index of value."], ["count", "Count occurrences of value."], ["sort", "Sort in place."], ["reverse", "Reverse in place."], ["copy", "Return a shallow copy."]],
    dict: [["keys", "Return a view of keys."], ["values", "Return a view of values."], ["items", "Return a view of (key, value) pairs."], ["get", "Return value for key or default."], ["pop", "Remove key and return value."], ["setdefault", "Return value or set default."], ["update", "Update from another mapping."], ["clear", "Remove all items."], ["copy", "Return a shallow copy."]]
  };

  var lspDocs = new Map();        // uri → { text, lines }
  var lspSymbols = new Map();     // name → { uri, line, doc }
  var lspClassMembers = new Map(); // uri → { className → [ [method, doc] ] }

  function lspDoc(uri) { return lspDocs.get(uri); }

  /** 读取 def/class 起始行紧跟的 docstring（"""..."""/'''...'''），无则 null */
  function lspDocstring(lines, startIdx) {
    var buf = [];
    var opener = null;
    for (var i = startIdx + 1; i < lines.length; i++) {
      var s = lines[i].trim();
      if (opener === null) {
        if (s === "") continue;
        var m = /^("""|''')([\s\S]*)$/.exec(s);
        if (!m) return null;
        opener = m[1];
        var rest = m[2];
        if (rest.length >= 3 && rest.slice(-3) === opener) { buf.push(rest.slice(0, -3)); return buf.join("\n").trim(); }
        if (rest) buf.push(rest);
      } else {
        var idx = s.indexOf(opener);
        if (idx >= 0) { buf.push(s.slice(0, idx)); return buf.join("\n").trim(); }
        buf.push(s);
      }
    }
    return buf.length ? buf.join("\n").trim() : null;
  }

  /** 索引文档：抽顶层 def/class 符号（跨文件跳转/hover 用）+ 类方法（属性补全用） */
  function lspIndexDoc(uri, text) {
    var lines = text.split("\n");
    lspDocs.set(uri, { text: text, lines: lines });
    lspSymbols.forEach(function (loc, name) { if (loc.uri === uri) lspSymbols.delete(name); });
    var classMembers = {};
    lspClassMembers.set(uri, classMembers);
    var currentClass = null;
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var indent = raw.length - raw.replace(/^\s+/, "").length;
      var code = raw.replace(/^\s+/, "");
      var m = /^(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(code);
      if (m) {
        var kind = m[1];
        var name = m[2];
        var doc = lspDocstring(lines, i);
        if (kind === "class") {
          currentClass = name;
          classMembers[name] = [];
          lspSymbols.set(name, { uri: uri, line: i + 1, doc: doc });
        } else if (indent > 0 && currentClass) {
          classMembers[currentClass].push([name, doc || ""]);
        } else {
          currentClass = null;
          lspSymbols.set(name, { uri: uri, line: i + 1, doc: doc });
        }
      } else if (indent === 0 && code.trim() !== "") {
        currentClass = null;
      }
    }
  }

  /** 变量类型推断：优先类型注解（name: type =），否则字面量赋值（name = "..." 等） */
  function lspVarType(uri, name) {
    var doc = lspDoc(uri);
    if (!doc) return null;
    var lines = doc.lines;
    var reAnn = new RegExp("\\b" + name + "\\s*:\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*=");
    for (var i = 0; i < lines.length; i++) {
      var m = reAnn.exec(lines[i]);
      if (m) return m[1];
    }
    var reLit = new RegExp("\\b" + name + "\\s*=\\s*(.*)$");
    for (var j = 0; j < lines.length; j++) {
      var mm = reLit.exec(lines[j]);
      if (!mm) continue;
      var rhs = mm[1].trim();
      if (/^['"]/.test(rhs)) return "str";
      if (/^\[/.test(rhs)) return "list";
      if (/^\{/.test(rhs)) return "dict";
      if (/^(True|False)$/.test(rhs)) return "bool";
      if (/^\d+(\.\d+)?$/.test(rhs)) return "int";
      if (/^set\(/.test(rhs)) return "set";
      break;
    }
    return null;
  }

  function lspMembersToItems(members, detail) {
    return members.map(function (mm) {
      return { label: mm[0], kind: LSP_KIND_METHOD, detail: detail, documentation: mm[1], sortText: "0" + mm[0] };
    });
  }

  /** 属性补全：`name.` → 返回 name 对应类型的成员 */
  function lspComplete(uri, pos) {
    var doc = lspDoc(uri);
    if (!doc) return [];
    var line = doc.lines[pos.line] || "";
    var before = line.slice(0, pos.character);
    var attr = /([A-Za-z_][A-Za-z0-9_]*)\s*\.$/.exec(before);
    if (attr) {
      var name = attr[1];
      var type = lspVarType(uri, name);
      if (type && LSP_MEMBERS[type]) return lspMembersToItems(LSP_MEMBERS[type], type + " method");
      var cls = (lspClassMembers.get(uri) || {})[name];
      if (cls && cls.length) return lspMembersToItems(cls, "method");
      return [];
    }
    return [];
  }

  /** 行内出现的全局已知符号（跳过 def/class/from/import/as 关键字） */
  function lspWordLocations(line) {
    var words = line.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
    var out = [];
    var skip = { "def": 1, "class": 1, "from": 1, "import": 1, "as": 1 };
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (skip[w]) continue;
      var loc = lspSymbols.get(w);
      if (loc) out.push({ word: w, loc: loc });
    }
    return out;
  }

  /** hover：返回该行第一个已知符号的 docstring（行级，容忍鼠标落点不精确） */
  function lspHover(uri, pos) {
    var doc = lspDoc(uri);
    if (!doc) return null;
    var line = doc.lines[pos.line] || "";
    var hits = lspWordLocations(line);
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      if (h.loc.doc) return { contents: "```python\ndef " + h.word + "(...)\n```\n\n" + h.loc.doc };
    }
    var attr = /([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
    if (attr) {
      var type = lspVarType(uri, attr[1]);
      var mem = LSP_MEMBERS[type];
      if (mem) {
        for (var j = 0; j < mem.length; j++) {
          if (mem[j][0] === attr[2]) return { contents: "```python\n" + attr[2] + "()\n```\n\n" + mem[j][1] };
        }
      }
    }
    return null;
  }

  /** 跳转定义：返回该行第一个全局已知符号的定义位置（自身定义处恒不再跳） */
  function lspDefinition(uri, pos) {
    var doc = lspDoc(uri);
    if (!doc) return null;
    var line = doc.lines[pos.line] || "";
    var hits = lspWordLocations(line);
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      if (h.loc.uri === uri && h.loc.line === pos.line + 1) continue;
      return {
        uri: h.loc.uri,
        range: { start: { line: h.loc.line - 1, character: 0 }, end: { line: h.loc.line - 1, character: h.word.length } },
      };
    }
    return null;
  }

  /** 光标处单词（references / rename / prepareRename 共用锚定语义；无词返回 null） */
  function lspWordAt(uri, pos) {
    var doc = lspDoc(uri);
    if (!doc) return null;
    var line = doc.lines[pos.line] || "";
    var col = Math.min(Math.max(pos.character, 0), line.length);
    var isW = function (c) { return /[A-Za-z0-9_]/.test(c || ""); };
    if (!isW(line[col]) && col > 0 && isW(line[col - 1])) col = col - 1; // 光标贴在词尾
    if (!isW(line[col])) return null;
    var start = col, end = col;
    while (start > 0 && isW(line[start - 1])) start--;
    while (end < line.length && isW(line[end])) end++;
    return { word: line.slice(start, end), start: start, end: end };
  }

  /** 查找引用：该词在全部已镜像文档中的所有出现（含定义；\b 词边界，字符串/注释不区分） */
  function lspReferences(uri, pos) {
    var w = lspWordAt(uri, pos);
    if (!w) return [];
    var out = [];
    lspDocs.forEach(function (doc, docUri) {
      for (var i = 0; i < doc.lines.length; i++) {
        var re = new RegExp("\\b" + w.word + "\\b", "g");
        var m;
        while ((m = re.exec(doc.lines[i])) !== null) {
          out.push({
            uri: docUri,
            range: { start: { line: i, character: m.index }, end: { line: i, character: m.index + w.word.length } },
          });
        }
      }
    });
    return out;
  }

  /** prepareRename：返回光标处单词范围与占位名（无词 → null，前端据此提示「不可重命名」） */
  function lspPrepareRename(uri, pos) {
    var w = lspWordAt(uri, pos);
    if (!w) return null;
    return {
      range: { start: { line: pos.line, character: w.start }, end: { line: pos.line, character: w.end } },
      placeholder: w.word,
    };
  }

  /** 重命名：全部已镜像文档中该词的所有出现 → WorkspaceEdit.changes。
   *  window.__E2E_RENAME_SCOPE__ = "single" 时只改当前文件——复刻真实 pyrefly 对
   *  Pydantic 字段的缺陷行为（F0 实测 references=0 / rename 只改声明处），供阶段 4
   *  「改名传播补充」验收：补充路径把跨文件调用点找回来。 */
  function lspRename(uri, pos, newName) {
    var w = lspWordAt(uri, pos);
    if (!w) return { changes: {} };
    var single = window.__E2E_RENAME_SCOPE__ === "single";
    var changes = {};
    lspDocs.forEach(function (doc, docUri) {
      if (single && docUri !== uri) return;
      var edits = [];
      for (var i = 0; i < doc.lines.length; i++) {
        var re = new RegExp("\\b" + w.word + "\\b", "g");
        var m;
        while ((m = re.exec(doc.lines[i])) !== null) {
          edits.push({
            range: { start: { line: i, character: m.index }, end: { line: i, character: m.index + w.word.length } },
            newText: newName,
          });
        }
      }
      if (edits.length) changes[docUri] = edits;
    });
    return { changes: changes };
  }

  /** documentSymbol：def/class 平铺列表（kind: class=5 / 方法=6 / 顶层函数=12），Code Vision 与面包屑共用 */
  function lspDocumentSymbols(uri) {
    var doc = lspDoc(uri);
    if (!doc) return [];
    var out = [];
    for (var i = 0; i < doc.lines.length; i++) {
      var raw = doc.lines[i];
      var indent = raw.length - raw.replace(/^\s+/, "").length;
      var code = raw.replace(/^\s+/, "");
      var m = /^(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(code);
      if (!m) continue;
      var nameChar = raw.indexOf(m[2], indent + m[1].length);
      out.push({
        name: m[2],
        kind: m[1] === "class" ? 5 : indent > 0 ? 6 : 12,
        range: { start: { line: i, character: indent }, end: { line: i, character: raw.length } },
        selectionRange: { start: { line: i, character: nameChar }, end: { line: i, character: nameChar + m[2].length } },
      });
    }
    return out;
  }

  /** 诊断（「提醒」）：对 `import nonexistent_*` / `import missing_*` 生成 missing-import 错误，
   *  对齐真实 pyrefly 的 missing-import 诊断形态（severity=1 / code=missing-import）。 */
  function lspComputeDiagnostics(uri) {
    var doc = lspDoc(uri);
    if (!doc) return [];
    var out = [];
    var lines = doc.lines;
    for (var i = 0; i < lines.length; i++) {
      var m = /^\s*(?:from|import)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(lines[i]);
      if (m && /^(nonexistent|missing)/i.test(m[1])) {
        out.push({
          range: { start: { line: i, character: 0 }, end: { line: i, character: lines[i].length } },
          severity: 1,
          message: "Unresolved import \"" + m[1] + "\"",
          source: "pyrefly",
          code: "missing-import",
        });
      }
    }
    return out;
  }

  async function invokeMock(cmd, args) {
    args = args || {};
    invokeLog.push(cmd + "(" + Object.keys(args).join(",") + ")");
    if (invokeLog.length > 200) invokeLog.shift();
    // 0.5) E2E 动作记录（端点工具窗 F2 验收：浏览器打开 / 复制 URL 的落点断言）
    if (cmd === "open_external") {
      (window.__E2E_OPENED_URLS__ = window.__E2E_OPENED_URLS__ || []).push(String(args.url ?? ""));
      return null;
    }
    if (cmd === "copy_to_clipboard") {
      (window.__E2E_COPIED__ = window.__E2E_COPIED__ || []).push(String(args.text ?? ""));
      return null;
    }
    // 1) 事件注册：args.handler 是 transformCallback 返回的回调 id（number）
    if (cmd === "plugin:event|listen") {
      var handlerId = args.handler;
      if (typeof handlerId === "number") eventHandlers.set(handlerId, args.event);
      return handlerId; // listen() 把返回值当 eventId，unlisten 时回传
    }
    if (cmd === "plugin:event|unlisten") {
      var unId = args.eventId;
      if (typeof unId === "number") {
        eventHandlers.delete(unId);
        callbacks.delete(unId);
      }
      return null;
    }
    // 2) git_*：转发 Playwright 侧真实 git 仓库
    if (cmd.indexOf("git_") === 0) {
      var b = bridge();
      if (b) {
        // 迭代 6：clone 域命令附带测试预设（fail/delayMs/files/branch，页面侧 addInitScript 注入）
        if (cmd === "git_clone" || cmd === "git_default_branch") {
          args = Object.assign({}, args, { __preset: window.__E2E_CLONE_PRESET__ || null });
        }
        return b("git", cmd, args);
      }
      console.warn("[tauri-mock] E2E_BRIDGE 未注入，git 命令 " + cmd + " 走空返回");
      return gitFallback(cmd);
    }
    // 3) 文件系统：经 bridge 走真实磁盘（工作区打开/文件树/编辑器读写都需要）
    if (FS_CMDS.indexOf(cmd) >= 0) {
      var fb = bridge();
      if (fb) return fb("fs", cmd, args);
      if (cmd === "list_dir") return [];
      throw new Error("[tauri-mock] " + cmd + " 需 E2E_BRIDGE");
    }
    // 4) 最近工作区：测试侧可经 setRecentWorkspaces 通道覆写（autoOpenRecentWorkspace 用）
    if (cmd === "get_recent_workspaces") {
      var rb = bridge();
      if (rb) return await rb("getRecentWorkspaces", "", null);
      return [];
    }
    // 4.4) 真实 pyrefly 模式：lsp_* 命令经 bridge 转发到 Node 侧真实 `pyrefly lsp` 进程
    //      （pyrefly 适配 E2E 用；equipPage 传入 realPyrefly 时注入 __E2E_LSP_REAL__ 标志）
    if (window.__E2E_LSP_REAL__ && (cmd === "lsp_send_request" || cmd === "lsp_send_notification" || cmd === "lsp_send_response" || cmd === "lsp_start" || cmd === "lsp_stop")) {
      var lb = bridge();
      if (lb) return lb("lsp", cmd, args);
      console.warn("[tauri-mock] E2E_BRIDGE 未注入，真实 pyrefly lsp 命令 " + cmd + " 无桥");
      return null;
    }
    // 4.5) LSP 协议层：lsp_send_request 结果经 "lsp-message" 事件回灌 client 的 pending；
    //       lsp_send_notification 维护文档镜像；lsp_start/stop/send_response 为生命周期 no-op
    if (cmd === "lsp_send_request") {
      var eng0 = args.engine, rid = args.id, method0 = args.method, params0 = args.params || {};
      var result0 = null;
      if (method0 === "initialize") {
        result0 = { capabilities: { textDocumentSync: 2, completionProvider: { triggerCharacters: [".", "_"], resolveProvider: true }, hoverProvider: true, definitionProvider: true, referencesProvider: true, documentSymbolProvider: true, renameProvider: { prepareProvider: true } } };
      } else if (method0 === "textDocument/completion") {
        var td0 = params0.textDocument || {};
        result0 = { isIncomplete: false, items: lspComplete(td0.uri, params0.position || { line: 0, character: 0 }) };
      } else if (method0 === "completionItem/resolve") {
        result0 = params0; // 补全项本身已含 documentation/detail，resolve 原样返回
      } else if (method0 === "textDocument/hover") {
        var td1 = params0.textDocument || {};
        result0 = lspHover(td1.uri, params0.position || { line: 0, character: 0 });
      } else if (method0 === "textDocument/definition") {
        var td2 = params0.textDocument || {};
        result0 = lspDefinition(td2.uri, params0.position || { line: 0, character: 0 });
      } else if (method0 === "textDocument/documentSymbol") {
        var td4 = params0.textDocument || {};
        result0 = lspDocumentSymbols(td4.uri);
      } else if (method0 === "textDocument/references") {
        var td5 = params0.textDocument || {};
        result0 = lspReferences(td5.uri, params0.position || { line: 0, character: 0 });
      } else if (method0 === "textDocument/prepareRename") {
        var td6 = params0.textDocument || {};
        result0 = lspPrepareRename(td6.uri, params0.position || { line: 0, character: 0 });
      } else if (method0 === "textDocument/rename") {
        var td7 = params0.textDocument || {};
        result0 = lspRename(td7.uri, params0.position || { line: 0, character: 0 }, String(params0.newName ?? ""));
      }
      emitEvent("lsp-message", { engine: eng0, id: rid, result: result0 });
      // 诊断用：记录 LSP 请求方法 + 结果（供 E2E 调试读取 window.__PYLUME_LSP_LOG__）
      window.__PYLUME_LSP_LOG__ = window.__PYLUME_LSP_LOG__ || [];
      window.__PYLUME_LSP_LOG__.push({ m: method0, params: params0, r: result0 });
      if (window.__PYLUME_LSP_LOG__.length > 60) window.__PYLUME_LSP_LOG__.shift();
      return null;
    }
    if (cmd === "lsp_send_notification") {
      var method1 = args.method, params1 = args.params || {};
      if (method1 === "textDocument/didOpen" || method1 === "textDocument/didChange" || method1 === "textDocument/didSave") {
        var td3 = params1.textDocument || {};
        var newText = null;
        if (method1 === "textDocument/didOpen" || method1 === "textDocument/didSave") {
          newText = td3.text;
        } else {
          var cc = params1.contentChanges;
          if (cc && cc.length) newText = cc[cc.length - 1].text;
        }
        if (typeof newText === "string" && td3.uri) {
          lspIndexDoc(td3.uri, newText);
          // 索引后同步推送该文件的诊断（红波浪线「提醒」）
          var diags = lspComputeDiagnostics(td3.uri);
          if (diags.length) {
            emitEvent("lsp-message", { engine: args.engine || "static", method: "textDocument/publishDiagnostics", params: { uri: td3.uri, diagnostics: diags } });
          }
        }
      }
      return null;
    }
    if (cmd === "lsp_send_response" || cmd === "lsp_start" || cmd === "lsp_stop") return null;
    // 4.65) 框架探针表 / Pydantic 引擎推荐 / 端点扫描（形状对齐 env_cmds.rs / fs_cmds.rs）
    if (cmd === "detect_framework" || cmd === "set_framework_hint_disabled" || cmd === "detect_pydantic_stack" ||
        cmd === "scan_endpoints" || cmd === "scan_pydantic_issues" || cmd === "scan_pydantic_ctor_refs" ||
        cmd === "get_project_run" || cmd === "set_project_run") {
      var fw = FW_STATE();
      if (cmd === "detect_framework") {
        // 优先级同 Rust：django（manage.py 强约定）→ fastapi → flask；hints 内为 true 的框架跳过
        if (!fw.hints.django && fw.hasManagePy && fw.deps.indexOf("django") >= 0) {
          return { framework: "django", label: "Django", file: "manage.py", entry: { kind: "script", target: "manage.py" }, args: "runserver", cwd: "${workspaceRoot}", summary: "manage.py runserver", missing: [] };
        }
        if (!fw.hints.fastapi && fw.deps.indexOf("fastapi") >= 0 && fw.hasFastApiApp) {
          var server = fw.deps.indexOf("uvicorn") >= 0 ? "uvicorn" : (fw.deps.indexOf("hypercorn") >= 0 ? "hypercorn" : "uvicorn");
          return { framework: "fastapi", label: "FastAPI", file: "main.py", entry: { kind: "module", target: server }, args: "main:app --reload", cwd: "${workspaceRoot}", summary: "-m " + server + " main:app --reload", missing: [] };
        }
        if (!fw.hints.flask && fw.deps.indexOf("flask") >= 0 && fw.hasFlaskApp) {
          return { framework: "flask", label: "Flask", file: "app.py", entry: { kind: "module", target: "flask" }, args: "--app app:app run --debug", cwd: "${workspaceRoot}", summary: "-m flask --app app:app run --debug", missing: [] };
        }
        return null;
      }
      if (cmd === "set_framework_hint_disabled") {
        fw.hints[String(args.framework)] = !!args.disabled;
        try { sessionStorage.setItem("oc-e2e-framework-hints", JSON.stringify(fw.hints)); } catch (e) { /* 不可持久则仅会话内 */ }
        return null;
      }
      if (cmd === "detect_pydantic_stack") return !!fw.pydanticStack && !fw.hints.pydantic_engine;
      if (cmd === "scan_endpoints") return JSON.parse(JSON.stringify(fw.endpoints));
      // 阶段 4：Pydantic 构造校验 / rename 传播补充（形状对齐 fs_cmds.rs；测试经
      // window.__E2E_PYDANTIC_PRESET__ 预置 { issues, ctorRefs }；未预置返回空）
      if (cmd === "scan_pydantic_issues") {
        var pd = window.__E2E_PYDANTIC_PRESET__ || {};
        return Array.isArray(pd.issues) ? JSON.parse(JSON.stringify(pd.issues)) : [];
      }
      if (cmd === "scan_pydantic_ctor_refs") {
        var pd2 = window.__E2E_PYDANTIC_PRESET__ || {};
        var refs = Array.isArray(pd2.ctorRefs) ? pd2.ctorRefs : [];
        // 与 Rust 同语义：按 (model, field) 过滤（预置面给全量，mock 侧筛选）
        var wantModel = String(args.model ?? ""), wantField = String(args.field ?? "");
        return refs.filter(function (r) { return (!wantModel || r.model === wantModel) && (!wantField || r.field === wantField); });
      }
      if (cmd === "get_project_run") return window.__E2E_PROJECT_RUN__ || null;
      if (cmd === "set_project_run") { window.__E2E_PROJECT_RUN__ = args.config || null; return null; }
    }
    // 4.6) 调试 DAP mock（E2E 专用，无真实 debugpy）：模拟 stdio adapter 架构时序与步进推演
    var dh = handleDebugCommand(cmd, args);
    if (dh !== "__unhandled__") return dh;
    // 4.7) A-5 会话快照：存 sessionStorage（addInitScript 每次导航都会重跑，模块级变量会丢；
    //      sessionStorage 在 reload 后仍在，才能验证「重启后恢复」）。
    //      注：静态表调用形如 `h()` 不传 args，故这里必须单独分支才能拿到 root/state。
    if (cmd === "save_session") {
      try {
        sessionStorage.setItem("oc-session:" + String(args.root), JSON.stringify(args.state));
      } catch (e) {}
      return null;
    }
    if (cmd === "get_session") {
      try {
        var sraw = sessionStorage.getItem("oc-session:" + String(args.root));
        if (sraw) return JSON.parse(sraw);
      } catch (e) {}
      return { tabs: [], active: null };
    }
    // 4.9) B3 数据库工具窗（sqliteView.ts ↔ db_cmds.rs）
    if (cmd.indexOf("db_") === 0) {
      var dbOut = dbHandle(cmd, args);
      if (dbOut !== undefined) return dbOut;
    }
    // pick_file：默认返回 null（= 用户取消，与真实对话框一致）；预置 __E2E_DB__.pick 时回该路径
    // （数据库「添加连接」的 e2e 用；runConfigPanel 等既有调用点不受影响）
    if (cmd === "pick_file" && window.__E2E_DB__ && window.__E2E_DB__.pick !== undefined) {
      return window.__E2E_DB__.pick;
    }
    // 5) 静态表
    var h = staticHandlers[cmd];
    if (h) return h();
    // 5.5) 工作区文件列表（quickOpen 文件源）：经 bridge 走真实磁盘
    if (cmd === "list_workspace_files") {
      var wb = bridge();
      if (wb) return await wb("fs", cmd, args);
      return [];
    }
    // 5.7) 插件域命令（loader 扫描/热重载/脚手架/路径/zip 分发）：经 bridge 走真实磁盘
    if (cmd === "list_plugin_dirs" || cmd === "read_plugin_file" || cmd === "scaffold_plugin" || cmd === "get_plugins_dir" || cmd === "get_data_doc_path" || cmd === "export_plugin" || cmd === "import_plugin" || cmd === "plugin_export_filename") {
      var pb = bridge();
      if (pb) return await pb("plugins", cmd, args);
      return cmd === "list_plugin_dirs" ? [] : cmd === "get_plugins_dir" ? "" : null;
    }
    // 5.7b) 插件日志落盘（v1.1 §9.14）：E2E 无数据根，成功空响应即可（前端 fire-and-forget 容错）
    if (cmd === "append_plugin_log") return null;
    // 5.6) 已知数组型命令兜底 []（防前端 for...of "list is not iterable"）
    if (ARRAY_CMDS.indexOf(cmd) >= 0) return [];
    // 6) 未覆盖命令：静默 null（应用多已 .catch 容错）+ 控制台留痕便于排查
    console.debug("[tauri-mock] 未覆盖命令 → null: " + cmd, args);
    return null;
  }

  window.__TAURI_INTERNALS__ = {
    invoke: invokeMock,
    /** core.js transformCallback：注册回调返回 id（listen/once/Channel 都走这里） */
    transformCallback: function (cb, once) {
      var id = ++callbackSeq;
      callbacks.set(id, { cb: cb, once: !!once });
      return id;
    },
    unregisterCallback: function (id) {
      callbacks.delete(id);
      eventHandlers.delete(id);
    },
    metadata: {
      currentWindow: { label: "e2e-main" },
      currentWebview: { label: "e2e-main" },
    },
    convertFileSrc: function (path) { return path; },
    /** 测试侧主动触发事件（模拟 Rust 推送，如 watcher 的 fs 事件） */
    __emit: function (event, payload) {
      emitEvent(event, payload);
    },
  };

  // event.js v2.1+ 的 _unlisten 先走这里再 invoke——不存在时整条 unlisten 抛错
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: function (_event, eventId) {
      callbacks.delete(eventId);
      eventHandlers.delete(eventId);
    },
  };
})();
