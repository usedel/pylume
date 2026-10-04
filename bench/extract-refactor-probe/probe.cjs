// 第三梯队探针：静态引擎是否提供 Extract Variable / Function（refactor 类 code action）
// 结论产出：docs/dx_features_backlog.md §3 第三梯队（立项 / 登记放弃裁决依据）
//
// 用法：node bench/extract-refactor-probe/probe.cjs [pyrefly|basedpyright]
// 输出：bench/reports/extract-refactor-probe-<engine>.json + stdout 摘要
//
// 设计要点（沿用 bench/pydantic-probe/probe.cjs 骨架与踩坑先例）：
// - 引擎命令与 ci/versions.toml 锁定版本一致：本机 uv tool 装的 pyrefly 是 1.2.0（旧），
//   必须经 `uv tool run pyrefly@1.3.1 lsp` 命中锁定版 1.3.1；basedpyright 经
//   `uv tool run --from basedpyright basedpyright-langserver --stdio`（uv tool list 未装，按需拉取）。
// - 进程 cwd = 受控项目根：pyrefly 从 cwd 发现 pyproject.toml 才建工作区索引
//   （缺 pyproject.toml 会连索引都不建，PR-N e2e 教训同源）。
// - Extract 是**选区式** code action：range 必须罩住表达式（探针按子串定位起止字符）。
// - 引擎可能三种形态返回：① action 直接带 edit；② action 带 command（pyright 血统的
//   applyRefactoring）需 workspace/executeCommand 回收（结果经 workspace/applyEdit 回推）；
//   ③ action 带 data 需 codeAction/resolve。三种都探。

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "sample", "extract_refactor");
const ENGINE = (process.argv[2] || "pyrefly").toLowerCase();

const ENGINES = {
  pyrefly: {
    command: "uv",
    args: ["tool", "run", "pyrefly@1.3.1", "lsp"],
    label: "pyrefly@1.3.1",
  },
  // PATH 直装的 pyrefly（本机 uv tool 是 1.2.0）——验证最低版本口径
  pyrefly_path: {
    command: "pyrefly",
    args: ["lsp"],
    label: "pyrefly@PATH",
  },
  basedpyright: {
    // 锁定版本（ci/versions.toml [engines] basedpyright = "1.39.10"）；不锁会拉到 latest（1.40.1）
    command: "uv",
    args: ["tool", "run", "--from", "basedpyright@1.39.10", "basedpyright-langserver", "--stdio"],
    label: "basedpyright@1.39.10",
  },
};

const info = ENGINES[ENGINE];
if (!info) {
  console.error(`未知引擎：${ENGINE}（可选 pyrefly / basedpyright）`);
  process.exit(1);
}

// ---- 选区定位：按子串找表达式在 main.py 中的 0-based 行/字符区间 ----
const MAIN_TEXT = fs.readFileSync(path.join(ROOT, "main.py"), "utf8");
function rangeOf(snippet) {
  const lines = MAIN_TEXT.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const col = lines[i].indexOf(snippet);
    if (col >= 0) {
      return { start: { line: i, character: col }, end: { line: i, character: col + snippet.length } };
    }
  }
  throw new Error(`靶子未找到：${snippet}`);
}
const TARGET_EXPR = rangeOf("price * qty"); // print(price * qty) → extract variable
const TARGET_RETURN = rangeOf("subtotal + subtotal * TAX_RATE"); // 长表达式 → extract variable
const TARGET_FUNC = rangeOf("price * qty"); // 同点位试 extract function/method

const uriOf = (p) => "file:///" + path.join(ROOT, p).replace(/\\/g, "/");
const MAIN_URI = uriOf("main.py");
const ROOT_URI = "file:///" + ROOT.replace(/\\/g, "/");

const child = spawn(info.command, info.args, {
  cwd: ROOT,
  stdio: ["pipe", "pipe", "pipe"],
  shell: process.platform === "win32",
});

let buf = Buffer.alloc(0);
const pending = new Map();
let stderrTail = "";
let nextId = 1;
const appliedEdits = []; // workspace/applyEdit 回推记录
let mainDiagArrived = false; // main.py 首次 publishDiagnostics（引擎索引就绪信号）

child.stderr.on("data", (c) => {
  stderrTail = (stderrTail + c.toString("utf8")).slice(-2000);
});

child.stdout.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const idx = buf.indexOf("\r\n\r\n");
    if (idx < 0) return;
    const header = buf.slice(0, idx).toString("ascii");
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) {
      buf = buf.slice(idx + 4);
      continue;
    }
    const len = Number(m[1]);
    if (buf.length < idx + 4 + len) return;
    const body = buf.slice(idx + 4, idx + 4 + len).toString("utf8");
    buf = buf.slice(idx + 4 + len);
    try {
      handle(JSON.parse(body));
    } catch {
      /* 忽略无法解析的帧 */
    }
  }
});

function send(msg) {
  const s = JSON.stringify(msg);
  child.stdin.write(Buffer.from(`Content-Length: ${Buffer.byteLength(s, "utf8")}\r\n\r\n${s}`, "utf8"));
}

function sendRequest(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} 超时（20s）`));
      }
    }, 20000);
  });
}

function sendNotification(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function summarizeAction(a) {
  return {
    title: a.title,
    kind: a.kind ?? null,
    command: a.command?.command ?? null,
    commandArgs: a.command?.arguments ? JSON.stringify(a.command.arguments).slice(0, 300) : null,
    hasEdit: !!a.edit,
    editSummary: a.edit
      ? JSON.stringify(a.edit).slice(0, 600)
      : null,
    hasData: a.data !== undefined && a.data !== null,
  };
}

function handle(msg) {
  // 服务端 → 客户端请求：必须响应
  if (msg.id !== undefined && msg.id !== null && msg.method) {
    let result = null;
    if (msg.method === "workspace/applyEdit") {
      appliedEdits.push(msg.params?.edit ?? null);
      result = { applied: true };
    } else if (msg.method === "workspace/configuration") {
      result = (msg.params?.items || []).map(() => null);
    } else if (msg.method === "window/workDoneProgress/create" || msg.method === "client/registerCapability") {
      result = null;
    }
    send({ jsonrpc: "2.0", id: msg.id, result });
    return;
  }
  if (msg.id !== undefined && msg.id !== null) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    }
    return;
  }
  // 服务端通知：main.py 首诊断 = 引擎对该文件分析就绪
  if (msg.method === "textDocument/publishDiagnostics" && String(msg.params?.uri || "") === MAIN_URI) {
    mainDiagArrived = true;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await sendRequest("initialize", {
    processId: process.pid,
    clientInfo: { name: "pylume-extract-probe", version: "1.0" },
    rootUri: ROOT_URI,
    capabilities: {
      textDocument: {
        synchronization: { didSave: true },
        publishDiagnostics: { relatedInformation: true },
        codeAction: {
          disabledSupport: true,
          dataSupport: true,
          resolvesSupport: true,
          codeActionLiteralSupport: {
            codeActionKind: {
              valueSet: ["", "quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite", "source", "source.organizeImports"],
            },
          },
        },
      },
      workspace: { configuration: true, workspaceFolders: true, applyEdit: true, executeCommand: {} },
    },
    initializationOptions: { pyrefly: { typeCheckingMode: "default" } },
    workspaceFolders: [{ uri: ROOT_URI, name: "extract_refactor" }],
  });
  sendNotification("initialized", {});

  sendNotification("textDocument/didOpen", {
    textDocument: { uri: MAIN_URI, languageId: "python", version: 1, text: MAIN_TEXT },
  });
  await sleep(3000); // 等索引/首诊断（pyrefly lazy 索引，同文件 codeAction 也依赖其就绪）
  // 精确等待 main.py 首诊断（basedpyright 对照组 0 项时的排查信号：引擎是否真的分析了该文件）
  for (let i = 0; i < 40 && !mainDiagArrived; i++) await sleep(250);

  const probe = async (name, range, only) => {
    const context = only ? { diagnostics: [], only } : { diagnostics: [] };
    let res;
    try {
      res = await sendRequest("textDocument/codeAction", {
        textDocument: { uri: MAIN_URI },
        range,
        context,
      });
    } catch (e) {
      return { target: name, error: String(e.message || e) };
    }
    const actions = Array.isArray(res) ? res : [];
    const out = { target: name, total: actions.length, actions: actions.map(summarizeAction) };
    // 形态③：带 data 且 resolvesSupport → resolve 后看是否补 edit
    out.resolved = [];
    for (const a of actions) {
      if (a.data !== undefined && a.data !== null && !a.edit && !a.command) {
        try {
          const r = await sendRequest("codeAction/resolve", a);
          out.resolved.push(summarizeAction(r || a));
        } catch (e) {
          out.resolved.push({ error: String(e.message || e) });
        }
      }
    }
    // 形态②：带 command（applyRefactoring 家族）→ executeCommand 回收编辑
    out.executed = [];
    for (const a of actions) {
      if (a.command?.command && !a.edit) {
        try {
          const r = await sendRequest("workspace/executeCommand", { command: a.command.command, arguments: a.command.arguments || [] });
          out.executed.push({
            command: a.command.command,
            title: a.title,
            result: JSON.stringify(r ?? null).slice(0, 600),
          });
        } catch (e) {
          out.executed.push({ command: a.command.command, title: a.title, error: String(e.message || e) });
        }
      }
    }
    return out;
  };

  // 引擎活性探针：hover 有响应 = 文件已被分析（basedpyright 0 项排查用）
  let hoverAlive = null;
  try {
    const h = await sendRequest("textDocument/hover", {
      textDocument: { uri: MAIN_URI },
      position: { line: TARGET_EXPR.start.line, character: TARGET_EXPR.start.character + 1 },
    });
    hoverAlive = h ? JSON.stringify(h).slice(0, 200) : null;
  } catch (e) {
    hoverAlive = `error: ${String(e.message || e)}`;
  }

  const fullList = await probe("全量 codeAction（不带 only）· print(price * qty)", TARGET_EXPR, null);
  const onlyRefactor = await probe("only=[refactor] · print(price * qty)", TARGET_EXPR, ["refactor"]);
  const onlyExtract = await probe("only=[refactor.extract] · print(price * qty)", TARGET_EXPR, ["refactor.extract"]);
  const returnExpr = await probe("only=[refactor] · return 长表达式", TARGET_RETURN, ["refactor"]);
  const funcTarget = await probe("only=[refactor.extract] · extract function 试点", TARGET_FUNC, ["refactor.extract"]);

  const report = {
    engine: info.label,
    generatedAt: new Date().toISOString(),
    projectRoot: ROOT,
    mainDiagArrived,
    hoverAlive,
    probes: { fullList, onlyRefactor, onlyExtract, returnExpr, funcTarget },
    appliedEdits,
    stderrTail: stderrTail.slice(-600),
  };

  const out = path.resolve(__dirname, "..", "reports", `extract-refactor-probe-${ENGINE}.json`);
  fs.writeFileSync(out, JSON.stringify(report, null, 2), "utf8");

  // stdout 摘要：只打判定相关的动作清单
  for (const p of Object.values(report.probes)) {
    console.log(`\n=== ${p.target} → ${p.total ?? "?"} 项 ===`);
    for (const a of p.actions || []) {
      console.log(`  [${a.kind ?? "-"}] ${a.title} | command=${a.command} | edit=${a.hasEdit} | data=${a.hasData}`);
    }
    for (const a of p.resolved || []) console.log(`  resolve→ [${a.kind ?? "-"}] ${a.title} edit=${a.hasEdit}`);
    for (const a of p.executed || []) console.log(`  execute→ ${a.command} result=${a.result ?? a.error}`);
  }
  console.log(`\n报告：${out}`);

  try {
    child.stdin.end();
    child.kill();
  } catch {
    /* ignore */
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(JSON.stringify({ engine: ENGINE, fatal: String(e.message || e), stderrTail: stderrTail.slice(-600) }, null, 2));
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
