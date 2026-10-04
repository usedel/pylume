// P2 探针：pyrefly 1.3.1 对「字符串内 DSL」（正则 / str.format / %-format）的支持度实测
// 决定：L1 层（正则诊断、格式串校验）是否必须自研
//
// 用法：node bench/lib-support-probe/p2_regex_probe.cjs
// 输出：bench/reports/lib-support-probe-p2.json + stdout 摘要
//
// 方法论沿用 bench/pydantic-probe/probe.cjs（踩坑先例）：
// - 命令与产品一致：`pyrefly lsp`；进程 cwd = 受控项目根（pyrefly 从 cwd 发现 pyproject 才建索引）；
// - 必须响应 workspace/configuration，否则挂起；
// - 发请求前等诊断就绪，避免「引擎还没看文件」的假阴性。

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "regex-ws");
const FILE = "regex_probe.py";
const VENV_PY = path.join(ROOT, ".venv", "Scripts", "python.exe");
const PY = fs.existsSync(VENV_PY) ? VENV_PY : "D:\\py\\python.exe";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uriOf = (p) => "file:///" + path.join(ROOT, p).replace(/\\/g, "/");
const ROOT_URI = "file:///" + ROOT.replace(/\\/g, "/");

const child = spawn("pyrefly", ["lsp"], {
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
      /* ignore */
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
  if (msg.id !== undefined && msg.id !== null && msg.method) {
    let result = null;
    if (msg.method === "workspace/configuration") {
      const items = Array.isArray(msg.params?.items) ? msg.params.items : [];
      result = items.map((it) => (it?.section === "python" ? { pythonPath: PY } : null));
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
    diags.set(String(msg.params.uri || "").split("/").pop(), msg.params.diagnostics || []);
  }
}

async function waitDiagnostics(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (diags.has(FILE)) return true;
    await sleep(200);
  }
  return false;
}

/** 定位：返回某行上 needle 第 occurrence 次出现的字符偏移（0-based） */
function posOf(text, needle, occurrence = 1) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let from = -1;
    for (let k = 0; k < occurrence; k++) {
      from = lines[i].indexOf(needle, from + 1);
      if (from < 0) break;
    }
    if (from >= 0) return { line: i, character: from + Math.floor(needle.length / 2) };
  }
  return null;
}

async function probeHover(text, label, needle, occurrence = 1) {
  const p = posOf(text, needle, occurrence);
  if (!p) return { label, error: `未找到锚点：${needle}` };
  try {
    const res = await sendRequest("textDocument/hover", { textDocument: { uri: uriOf(FILE) }, position: p });
    const c = res?.contents;
    const value = typeof c === "string" ? c : c?.value ?? c?.contents?.[0]?.value ?? null;
    return { label, needle, position: p, hover: value ? String(value).slice(0, 400) : null };
  } catch (e) {
    return { label, needle, error: String(e.message || e) };
  }
}

async function probeCompletion(text, label, needle, occurrence = 1) {
  const p = posOf(text, needle, occurrence);
  if (!p) return { label, error: `未找到锚点：${needle}` };
  try {
    const res = await sendRequest("textDocument/completion", {
      textDocument: { uri: uriOf(FILE) },
      position: p,
      context: { triggerKind: 1 },
    });
    const items = Array.isArray(res) ? res : res?.items || [];
    return { label, needle, position: p, total: items.length, labels: items.slice(0, 12).map((i) => i.label) };
  } catch (e) {
    return { label, needle, error: String(e.message || e) };
  }
}

async function main() {
  const text = fs.readFileSync(path.join(ROOT, FILE), "utf8");

  await sendRequest("initialize", {
    processId: process.pid,
    clientInfo: { name: "pylume-regex-probe", version: "1.0" },
    rootUri: ROOT_URI,
    capabilities: {
      textDocument: {
        synchronization: { didSave: true },
        completion: { completionItem: { snippetSupport: true, documentationFormat: ["markdown", "plaintext"] } },
        hover: { contentFormat: ["markdown", "plaintext"] },
        publishDiagnostics: { relatedInformation: true },
      },
      workspace: { configuration: true, workspaceFolders: true, didChangeConfiguration: {} },
    },
    initializationOptions: { pythonPath: PY },
    workspaceFolders: [{ uri: ROOT_URI, name: "regex-probe-ws" }],
  });
  sendNotification("initialized", {});
  sendNotification("textDocument/didOpen", {
    textDocument: { uri: uriOf(FILE), languageId: "python", version: 1, text },
  });

  const diagReady = await waitDiagnostics(20000);
  await sleep(1500); // 给二次诊断一轮机会

  const hovers = [];
  // 1) re.compile 标识符本身（引擎必给：typeshed 签名）
  hovers.push(await probeHover(text, "re.compile 标识符", "re.compile"));
  // 2) 非法正则字符串内部
  hovers.push(await probeHover(text, "非法正则串内部 r\"([a-z\"", "([a-z"));
  // 3) 合法正则串内部（含命名组）
  hovers.push(await probeHover(text, "合法正则串内部", "(?P<user>"));
  // 4) 非法格式规范 {:q}
  hovers.push(await probeHover(text, "非法格式规范 {:q}", "{:q}"));
  // 5) 合法 strftime 规范
  hovers.push(await probeHover(text, "合法日期规范", "%Y-%m-%d"));
  // 6) 非法 %-format 码
  hovers.push(await probeHover(text, "非法 %-format", "%Q"));

  const completions = [];
  // 7) 字符串内部触发补全（看引擎是否给「字符串内」的项）
  completions.push(await probeCompletion(text, "正则串内部补全", "(?P<user>"));
  completions.push(await probeCompletion(text, "格式规范内部补全", "%Y-%m-%d"));

  const list = diags.get(FILE) || [];
  // 关键：诊断是否落在「字符串内部」（行号 + 是否提到 regex/format/strftime）
  const interesting = list.filter((d) =>
    /regex|正则|format|strftime|pattern|invalid|Invalid|escape/i.test(String(d.message || "")),
  );

  const report = {
    probe: "P2 静态引擎对字符串内 DSL 的支持度（pyrefly）",
    generatedAt: new Date().toISOString(),
    engine: "pyrefly",
    pythonPath: PY,
    diagReady,
    diagnosticsTotal: list.length,
    diagnostics: list.map((d) => ({
      line: d.range?.start?.line,
      severity: d.severity,
      code: d.code ?? null,
      source: d.source ?? null,
      message: String(d.message || "").slice(0, 200),
    })),
    diagnosticsMentioningRegexOrFormat: interesting,
    hovers,
    completions,
    stderrTail: stderrTail.slice(-600),
  };

  const out = path.resolve(__dirname, "..", "reports", "lib-support-probe-p2.json");
  fs.writeFileSync(out, JSON.stringify(report, null, 2), "utf8");

  console.log("=== P2 结论 ===");
  console.log(`诊断总数：${list.length}；其中提及 regex/format/strftime 的：${interesting.length}`);
  if (interesting.length) console.log(JSON.stringify(interesting, null, 2));
  console.log("\n--- hover ---");
  for (const h of hovers) {
    console.log(`[${h.label}] ${h.hover ? JSON.stringify(h.hover.slice(0, 160)) : `无（${h.error || "null"}）`}`);
  }
  console.log("\n--- 字符串内补全 ---");
  for (const c of completions) {
    console.log(`[${c.label}] total=${c.total ?? "-"} ${c.labels ? JSON.stringify(c.labels.slice(0, 8)) : c.error || ""}`);
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
  console.error(JSON.stringify({ fatal: String(e.message || e), stderrTail: stderrTail.slice(-600) }, null, 2));
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
