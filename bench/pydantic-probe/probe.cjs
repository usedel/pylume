// F0 探针：静态引擎对 Pydantic 的支持度实测（docs/pycharm_framework_support_report.md §8.3 F0）
//
// 用法：node bench/pydantic-probe/probe.cjs [pyrefly|basedpyright]
// 输出：bench/reports/pydantic-probe-<engine>.json + stdout 摘要
//
// 设计要点（踩坑先例，务必保留）：
// - 引擎命令与产品一致：`pyrefly lsp` / `basedpyright-langserver --stdio`（lsp/client.ts::ENGINES）；
// - 解释器口径与产品一致：pyrefly 走 initializationOptions.pythonPath，basedpyright 走
//   workspace/configuration(section=python).pythonPath；**必须响应配置请求**，否则 basedpyright
//   挂起（P1-BUG-001 根因）；
// - pyrefly 是 lazy-non-blocking-background 索引：rename/references 前必须轮询到引用数稳定，
//   否则只覆盖已索引文件 → 漏改（产品 waitReferencesStable 同款）；
// - 进程 cwd = 受控项目根（pyrefly 从 cwd 发现 pyproject.toml 才建工作区索引）。

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "sample", "pydantic_models");
const ENGINE = (process.argv[2] || "pyrefly").toLowerCase();
const VENV_PY = path.join(ROOT, ".venv", "Scripts", "python.exe");

const ENGINES = {
  pyrefly: { command: "pyrefly", args: ["lsp"] },
  basedpyright: { command: "basedpyright-langserver", args: ["--stdio"] },
};

// plain.py 是「标准库 dataclass 对照组」：用于区分「引擎不认 Pydantic」与
// 「引擎本来就不对 __init__ 做构造参数校验」两种根因。
const FILES = ["models.py", "usage.py", "complete.py", "alias.py", "validators.py", "plain.py"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uriOf = (p) => "file:///" + path.join(ROOT, p).replace(/\\/g, "/");
const ROOT_URI = "file:///" + ROOT.replace(/\\/g, "/");

const info = ENGINES[ENGINE];
if (!info) {
  console.error(`未知引擎：${ENGINE}（可选 pyrefly / basedpyright）`);
  process.exit(1);
}

const child = spawn(info.command, info.args, {
  cwd: ROOT,
  stdio: ["pipe", "pipe", "pipe"],
  shell: process.platform === "win32",
});

let buf = Buffer.alloc(0);
const pending = new Map();
const diags = new Map();
let stderrTail = "";
let nextId = 1;

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

function handle(msg) {
  // 服务端 → 客户端请求：必须响应
  if (msg.id !== undefined && msg.id !== null && msg.method) {
    let result = null;
    if (msg.method === "workspace/configuration") {
      const items = Array.isArray(msg.params?.items) ? msg.params.items : [];
      result = items.map((it) =>
        it?.section === "python" ? { pythonPath: VENV_PY } : null,
      );
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
  if (msg.method === "textDocument/publishDiagnostics") {
    const p = msg.params;
    const name = String(p.uri || "").split("/").pop();
    diags.set(name, p.diagnostics || []);
  }
}

/** 等待 5 个受控文件都收到至少一次诊断（或超时） */
async function waitDiagnostics(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (FILES.every((f) => diags.has(f))) return true;
    await sleep(200);
  }
  return false;
}

/** 引用数稳定轮询（pyrefly lazy 索引：不等待会漏改） */
async function referencesStable(uri, position) {
  let prev = -1;
  for (let i = 0; i < 8; i++) {
    const res = await sendRequest("textDocument/references", {
      textDocument: { uri },
      position,
      context: { includeDeclaration: false },
    });
    const n = Array.isArray(res) ? res.length : 0;
    if (n > 0 && n === prev) return n;
    prev = n;
    await sleep(700);
  }
  return prev;
}

async function main() {
  await sendRequest("initialize", {
    processId: process.pid,
    clientInfo: { name: "pylume-pydantic-probe", version: "1.0" },
    rootUri: ROOT_URI,
    capabilities: {
      textDocument: {
        synchronization: { didSave: true },
        completion: { completionItem: { snippetSupport: true, documentationFormat: ["markdown", "plaintext"] } },
        hover: { contentFormat: ["markdown", "plaintext"] },
        references: {},
        rename: { prepareSupport: true },
        publishDiagnostics: { relatedInformation: true },
      },
      workspace: { configuration: true, workspaceFolders: true, applyEdit: true, didChangeConfiguration: {} },
    },
    initializationOptions: { pythonPath: VENV_PY },
    workspaceFolders: [{ uri: ROOT_URI, name: "pydantic_models" }],
  });
  sendNotification("initialized", {});

  for (const f of FILES) {
    sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: uriOf(f),
        languageId: "python",
        version: 1,
        text: fs.readFileSync(path.join(ROOT, f), "utf8"),
      },
    });
  }

  const diagReady = await waitDiagnostics(15000);

  // ---- 1) 字段补全：complete.py 的 `User(id=1, na|)` ----
  const cText = fs.readFileSync(path.join(ROOT, "complete.py"), "utf8");
  const cLines = cText.split(/\r?\n/);
  const cLine = cLines.findIndex((l) => l.includes("User(id=1, na"));
  const cChar = cLines[cLine].indexOf("na") + 2;
  let completion = { error: null };
  try {
    const res = await sendRequest("textDocument/completion", {
      textDocument: { uri: uriOf("complete.py") },
      position: { line: cLine, character: cChar },
      context: { triggerKind: 1 },
    });
    const items = Array.isArray(res) ? res : res?.items || [];
    const labels = items.map((it) => it.label);
    // 引擎可能给 "name" 或 "name="（带等号后缀）两种形态，判定统一剥离尾部 "="
    const bare = labels.map((l) => String(l).replace(/=+$/, ""));
    completion = {
      total: items.length,
      labels,
      fieldsHit: ["id", "name", "is_active"].filter((f) => bare.includes(f)),
      nameItem: items.find((it) => String(it.label).replace(/=+$/, "") === "name") || null,
    };
  } catch (e) {
    completion.error = String(e.message || e);
  }

  // ---- 2) 字段改名传播：models.py 的 `name: str` → full_name ----
  const mText = fs.readFileSync(path.join(ROOT, "models.py"), "utf8");
  const mLines = mText.split(/\r?\n/);
  const mLine = mLines.findIndex((l) => l.trim() === "name: str");
  const mChar = mLines[mLine].indexOf("name");
  const renamePos = { line: mLine, character: mChar };
  let refs = 0;
  let rename = { error: null };
  try {
    refs = await referencesStable(uriOf("models.py"), renamePos);
    const edit = await sendRequest("textDocument/rename", {
      textDocument: { uri: uriOf("models.py") },
      position: renamePos,
      newName: "full_name",
    });
    const perFile = {};
    if (edit?.changes) {
      for (const [uri, edits] of Object.entries(edit.changes)) {
        perFile[String(uri).split("/").pop()] = edits.map((e) => ({
          line: e.range.start.line,
          newText: e.newText,
        }));
      }
    } else if (Array.isArray(edit?.documentChanges)) {
      for (const dc of edit.documentChanges) {
        const name = String(dc.textDocument?.uri || "").split("/").pop();
        perFile[name] = (dc.edits || []).map((e) => ({ line: e.range.start.line, newText: e.newText }));
      }
    }
    rename = { files: Object.keys(perFile), edits: perFile };
  } catch (e) {
    rename.error = String(e.message || e);
  }

  // ---- 3) hover：字段类型是否可读 ----
  let hover = null;
  try {
    const res = await sendRequest("textDocument/hover", {
      textDocument: { uri: uriOf("models.py") },
      position: renamePos,
    });
    const c = res?.contents;
    hover = typeof c === "string" ? c : c?.value ?? null;
  } catch {
    hover = null;
  }

  const report = {
    engine: ENGINE,
    generatedAt: new Date().toISOString(),
    venvPython: VENV_PY,
    diagReady,
    diagnostics: Object.fromEntries(
      [...diags.entries()].map(([f, list]) => [
        f,
        list
          .slice(0, 14)
          .map((d) => ({
            line: d.range?.start?.line,
            severity: d.severity,
            code: d.code ?? null,
            source: d.source ?? null,
            message: String(d.message || "").slice(0, 200),
          })),
      ]),
    ),
    completion,
    rename: { ...rename, stableReferences: refs },
    hover,
    stderrTail: stderrTail.slice(-600),
  };

  const out = path.resolve(__dirname, "..", "reports", `pydantic-probe-${ENGINE}.json`);
  fs.writeFileSync(out, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report, null, 2));

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
