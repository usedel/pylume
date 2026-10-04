/**
 * E2E 测试基建（git 改进报告 §11.2）。
 *
 * 职责：
 *  1. 每用例建一个真实临时 git 仓库（git init + 基线提交）；
 *  2. page.addInitScript 注入 tauri-mock（先于应用任何模块加载）；
 *  3. page.exposeFunction 注册 __E2E_BRIDGE__：git_* 映射到 Node 子进程真实 git、
 *     fs_* 映射到真实磁盘操作（限仓库目录内，防越权）；
 *  4. 通过 recentWorkspaces 让应用启动即打开该仓库（autoOpenRecentWorkspace 链路）。
 *
 * 返回形状刻意与 Rust 侧 git_cmds.rs / git_status.rs 对齐（snake_case 字段）。
 */
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync, rmSync, cpSync } from "node:fs";
import { basename } from "node:path";
import { tmpdir } from "node:os";
import { join, dirname, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

/** tauri-mock 纯 JS 源码（注入用；addInitScript 直接执行源码串，不可含 TS 语法） */
const MOCK_PATH = join(dirname(fileURLToPath(import.meta.url)), "mocks", "tauri-mock.js");

/** 临时 git 仓库句柄 */
export interface GitRepo {
  root: string;
  /** 在仓库内执行 git（cwd=root），返回 stdout */
  git(args: string[]): Promise<string>;
  /** 写文件（相对仓库根），自动建父目录 */
  write(rel: string, content: string): void;
  /** 读文件（相对仓库根） */
  read(rel: string): string;
  /** 仓库相对路径 → 绝对路径 */
  abs(rel: string): string;
}

/** 建临时 git 仓库：init + user 配置 + 可选基线文件与提交 */
export async function makeGitRepo(baseline?: { files: Record<string, string>; commitMsg?: string }): Promise<GitRepo> {
  const root = mkdtempSync(join(tmpdir(), "pylume-e2e-"));
  return finishRepo(root, baseline);
}

/** 建非 git 工作区（验收 E2E-03：非仓库空态 → init 流程）。内部句柄仍带 git 函数
 *  （后续 init 后可直接用），但**不执行 git init**。 */
export async function makePlainDir(files?: Record<string, string>): Promise<GitRepo> {
  const root = mkdtempSync(join(tmpdir(), "pylume-plain-"));
  // 只装配句柄不 init：git 命令照常可跑（mock git_status 会失败 → 前端显示非仓库空态 ✓）
  const git = (args: string[]): Promise<string> =>
    execFileAsync("git", ["-c", "core.autocrlf=false", "-c", "protocol.file.allow=always", ...args], { cwd: root, maxBuffer: 16 * 1024 * 1024 })
      .then((r) => r.stdout)
      .catch((e: { stdout?: string; stderr?: string; message: string }) => {
        throw new Error(`git ${args.join(" ")} 失败: ${e.stderr || e.message}`);
      });
  const repo: GitRepo = {
    root,
    git,
    write(rel, content) {
      const target = join(root, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
    },
    read(rel) {
      return readFileSync(join(root, rel), "utf8");
    },
    abs(rel) {
      return join(root, rel);
    },
  };
  if (files) for (const [rel, content] of Object.entries(files)) repo.write(rel, content);
  return repo;
}

/** 共享的仓库句柄装配（git init + 配置 + 可选基线提交） */
async function finishRepo(root: string, baseline?: { files: Record<string, string>; commitMsg?: string }): Promise<GitRepo> {
  // -c 组合：autocrlf=false 防 CRLF 化；protocol.file.allow=always 是 Git 2.38.1+
  //（CVE-2022-39253）默认禁 file 协议 push/fetch 的绕行——E2E 需要本地 bare 仓库上游
  const git = (args: string[]): Promise<string> =>
    execFileAsync("git", ["-c", "core.autocrlf=false", "-c", "protocol.file.allow=always", ...args], { cwd: root, maxBuffer: 16 * 1024 * 1024 })
      .then((r) => r.stdout)
      .catch((e: { stdout?: string; stderr?: string; message: string }) => {
        throw new Error(`git ${args.join(" ")} 失败: ${e.stderr || e.message}`);
      });
  await git(["init", "--quiet", "-b", "main"]);
  await git(["config", "user.name", "E2E Tester"]);
  await git(["config", "user.email", "e2e@test.local"]);
  const repo: GitRepo = {
    root,
    git,
    write(rel, content) {
      const target = join(root, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
    },
    read(rel) {
      return readFileSync(join(root, rel), "utf8");
    },
    abs(rel) {
      return join(root, rel);
    },
  };
  if (baseline) {
    for (const [rel, content] of Object.entries(baseline.files)) repo.write(rel, content);
    await git(["add", "-A"]);
    await git(["commit", "--quiet", "-m", baseline.commitMsg ?? "baseline"]);
  }
  return repo;
}

/** 构造真实冲突仓库（E2E-06）：base → 两分支改同一文件同一区域 → merge 触发冲突 */
export async function makeConflictRepo(): Promise<{ repo: GitRepo; conflictedPath: string; currentContent: string; incomingContent: string }> {
  const repo = await makeGitRepo({ files: { "app.py": "line1\nline2\nline3\n" }, commitMsg: "base" });
  // current（main）：改第 2 行
  await repo.git(["checkout", "--quiet", "-b", "feature"]);
  repo.write("app.py", "line1\nline2-INCOMING\nline3\n");
  await repo.git(["add", "-A"]);
  await repo.git(["commit", "--quiet", "-m", "incoming change"]);
  await repo.git(["checkout", "--quiet", "main"]);
  repo.write("app.py", "line1\nline2-CURRENT\nline3\n");
  await repo.git(["add", "-A"]);
  await repo.git(["commit", "--quiet", "-m", "current change"]);
  // merge feature → 冲突
  await repo.git(["merge", "feature"]).catch(() => { /* 冲突退出码非零，预期内 */ });
  return {
    repo,
    conflictedPath: "app.py",
    currentContent: "line2-CURRENT",
    incomingContent: "line2-INCOMING",
  };
}

// ---------- git 命令实现（对齐 git_cmds.rs 的输出形状） ----------

interface StatusFile { path: string; x: string; y: string; code: string }

/** porcelain v1 -z 解析（对齐 git_status.rs::parse_porcelain_z：重命名取新路径） */
function parsePorcelainZ(stdout: string): StatusFile[] {
  const fields = stdout.split("\0");
  const files: StatusFile[] = [];
  let i = 0;
  while (i < fields.length) {
    const field = fields[i];
    if (field.length < 4) { i++; continue; }
    const x = field[0];
    const y = field[1];
    const isRename = x === "R" || x === "C";
    let displayPath: string;
    if (isRename) {
      const dest = fields[i + 1];
      if (dest === undefined) break;
      displayPath = dest;
      i += 2;
    } else {
      displayPath = field.slice(3);
      i++;
    }
    const code = statusCode(x, y);
    if (code) files.push({ path: displayPath, x, y, code });
  }
  return files;
}

/** 对齐 git_status.rs::status_code 的合并规则 */
function statusCode(x: string, y: string): string {
  if (x === "?" && y === "?") return "?";
  if (x !== " " && y !== " " && x !== "M" && y !== "M") return "!";
  if (y !== " ") return y;
  if (x !== " ") return x;
  return "";
}

/** git_* invoke 分发（形状对齐 Rust 命令的 Serialize 结构） */
async function dispatchGit(cmd: string, args: Record<string, unknown>, repo: GitRepo): Promise<unknown> {
  // 前端 workspaceRoot 是正斜杠（Tauri 风格）；MSYS git 对「正斜杠 cwd + 正斜杠参数」
  // 会做 POSIX 路径转换导致拼错位（实测 git apply 报 No such file）。统一 resolve 成
  // 系统原生分隔符（Windows=反斜杠），一处修复覆盖全部 git 子命令。
  const root = resolve(String(args.root ?? repo.root));
  // -c 组合与 makeGitRepo 的 git() 同源：autocrlf（防 CRLF 化）+ file 协议放行（本地 bare 上游）
  const inRepo = async (a: string[], opts: { input?: string } = {}): Promise<string> =>
    execFileAsync("git", ["-c", "core.autocrlf=false", "-c", "protocol.file.allow=always", ...a], { cwd: root, maxBuffer: 16 * 1024 * 1024, ...opts })
      .then((r) => r.stdout)
      .catch((e: { stderr?: string; message: string }) => { throw new Error(e.stderr?.trim() || e.message); });
  const arg = <T,>(k: string, dflt?: T): T => (args[k] as T) ?? dflt as T;

  switch (cmd) {
    case "git_status": {
      const out = await inRepo(["status", "--porcelain=v1", "-z"]);
      let currentBranch: string | null = null;
      try {
        currentBranch = (await inRepo(["branch", "--show-current"])).trim() || null;
      } catch { currentBranch = null; }
      return { files: parsePorcelainZ(out), is_git: true, current_branch: currentBranch };
    }
    case "git_stage": {
      const paths = arg<string[]>("paths");
      await inRepo(["add", "--", ...paths]);
      return "";
    }
    case "git_unstage": {
      const paths = arg<string[]>("paths");
      await inRepo(["reset", "--quiet", "HEAD", "--", ...paths]);
      return "";
    }
    case "git_commit": {
      const message = arg<string>("message");
      const amend = arg<boolean>("amend", false);
      return inRepo(["commit", ...(amend ? ["--amend"] : []), "-m", message]);
    }
    case "git_log": {
      const count = Math.min(Math.max(arg<number>("count", 50), 1), 200);
      const out = await inRepo([
        "log", `-n${count}`, "--all", "--graph", "--date=short",
        "--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1f%d",
      ]);
      const commits = out.split("\n").flatMap((line) => {
        const sep = line.indexOf("\x1f");
        if (sep < 0) return [];
        const hashStart = line.search(/[^ *|/\\_.<>]/);
        if (hashStart < 0 || hashStart >= sep) return [];
        const f = line.slice(hashStart).split("\x1f");
        if (f.length < 5) return [];
        return [{
          hash: f[0], short_hash: f[1], author: f[2], date: f[3], subject: f[4],
          graph: line.slice(0, hashStart).trimEnd(),
          refs: (f[5] ?? "").trim().replace(/^\(+|\)+$/g, "").trim(),
        }];
      });
      return commits;
    }
    case "git_show": {
      const hash = String(args.hash ?? "").trim();
      if (!hash) throw new Error("提交哈希不能为空");
      return inRepo(["show", hash]);
    }
    case "git_log_file": {
      // E-4（PyCharm 调研）：单文件历史（--follow），对齐 git_cmds.rs::git_log_file 输出形状
      const count = Math.min(Math.max(arg<number>("count", 50), 1), 200);
      const path = String(args.path ?? "").trim();
      if (!path) throw new Error("文件路径不能为空");
      const out = await inRepo([
        "log", `-n${count}`, "--follow", "--date=short",
        "--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1f%d", "--", path,
      ]);
      const commits = out.split("\n").flatMap((line) => {
        const f = line.split("\x1f");
        if (f.length < 5) return [];
        return [{
          hash: f[0], short_hash: f[1], author: f[2], date: f[3], subject: f[4],
          graph: "",
          refs: (f[5] ?? "").trim().replace(/^\(+|\)+$/g, "").trim(),
        }];
      });
      return commits;
    }
    case "git_blame": {
      const path = String(args.path ?? "");
      const out = await inRepo(["blame", "--line-porcelain", "--", path]);
      const lines = out.split("\n");
      const rows: { line: number; short_hash: string; author: string; time: number; summary: string }[] = [];
      let cur: { hash: string; author: string; time: number; summary: string } | null = null;
      let lineNo = 0;
      for (const l of lines) {
        const m = l.match(/^([0-9a-f]{40}) (\d+) (\d+) (\d+)/);
        if (m) {
          if (cur) rows.push({ line: lineNo, short_hash: cur.hash.slice(0, 8), author: cur.author, time: cur.time, summary: cur.summary });
          lineNo = parseInt(m[2], 10);
          cur = { hash: m[1], author: "", time: 0, summary: "" };
        } else if (cur) {
          if (l.startsWith("author ")) cur.author = l.slice(7);
          else if (l.startsWith("author-time ")) cur.time = parseInt(l.slice(12), 10);
          else if (l.startsWith("summary ")) cur.summary = l.slice(8);
        }
      }
      if (cur) rows.push({ line: lineNo, short_hash: cur.hash.slice(0, 8), author: cur.author, time: cur.time, summary: cur.summary });
      return rows;
    }
    case "git_branches": {
      // 与 Rust git_branches 同构：完整 %(refname)（:short 对远程分支输出 origin/x 无
      // remotes/ 前缀，按前缀判 remote 恒 false——B8 真 bug 的复刻修复）
      const out = await inRepo(["branch", "-a", "--format", "%(HEAD)\t%(refname)\t%(objectname:short)"]);
      return out.split("\n").filter((l) => l.trim()).flatMap((l) => {
        const [head = "", name = ""] = l.split("\t");
        const full = name.trim();
        if (!full || full === "HEAD") return [];
        const remotes = full.startsWith("refs/remotes/");
        const heads = full.startsWith("refs/heads/");
        if (!remotes && !heads) return [];
        return [{
          name: remotes ? full.slice("refs/remotes/".length) : full.slice("refs/heads/".length),
          current: head.trim() === "*",
          remote: remotes,
        }];
      });
    }
    case "git_init": {
      // 与 Rust 侧对齐：-b main（宿主 git 无 defaultBranch 配置时回落 master，与预期不符）
      await inRepo(["init", "--quiet", "-b", "main"]).catch(() => inRepo(["init", "--quiet"]));
      return "仓库已初始化";
    }
    // ---------- 迭代 3：高级工作流 ----------
    case "git_sync_status": {
      const upstream = await inRepo(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
        .then((s) => s.trim() || null)
        .catch(() => null);
      if (upstream === null) return { upstream: null, ahead: 0, behind: 0 };
      const out = await inRepo(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
      const [behind, ahead] = out.split(/\s+/).map((n) => parseInt(n, 10) || 0);
      return { upstream, ahead, behind };
    }
    case "git_cherry_pick": {
      const a = ["cherry-pick"];
      if (args.no_commit) a.push("-n");
      return inRepo([...a, String(args.hash ?? "")]);
    }
    case "git_revert": {
      return inRepo(["revert", "--no-edit", String(args.hash ?? "")]);
    }
    case "git_reset": {
      const mode = String(args.mode ?? "");
      if (!["soft", "mixed", "hard"].includes(mode)) throw new Error(`未知 reset 模式：${mode}`);
      return inRepo(["reset", `--${mode}`, String(args.hash ?? "")]);
    }
    case "git_merge": {
      const a = ["merge"];
      if (args.no_ff) a.push("--no-ff");
      if (args.squash) a.push("--squash");
      return inRepo([...a, String(args.branch ?? "")]);
    }
    case "git_rebase": {
      return inRepo(["rebase", String(args.branch ?? "")]);
    }
    case "git_abort_op": {
      const op = String(args.op ?? "");
      const map: Record<string, string[]> = { merge: ["merge", "--abort"], rebase: ["rebase", "--abort"], "cherry-pick": ["cherry-pick", "--abort"] };
      if (!map[op]) throw new Error(`未知操作：${op}`);
      return inRepo(map[op]);
    }
    case "git_tags": {
      const out = await inRepo(["tag", "--format", "%(refname:short)\t%(objectname:short)"]);
      return out.split("\n").filter((l) => l.trim()).map((l) => {
        const [name = "", short_hash = ""] = l.split("\t");
        return { name: name.trim(), short_hash: short_hash.trim() };
      });
    }
    case "git_create_tag": {
      const name = String(args.name ?? "").trim();
      if (!name) throw new Error("标签名不能为空");
      const hash = String(args.hash ?? "").trim();
      return inRepo(hash ? ["tag", name, hash] : ["tag", name]);
    }
    case "git_create_branch_at": {
      const name = String(args.name ?? "").trim();
      const hash = String(args.hash ?? "").trim();
      if (!name || !hash) throw new Error("分支名与哈希不能为空");
      return inRepo(["branch", name, hash]);
    }
    case "git_stash_show": {
      return inRepo(["stash", "show", "-p", `stash@{${arg<number>("index", 0)}}`]);
    }
    case "git_diff_hunks": {
      // 迭代 2：gutter 装饰与 hunk 暂存共用（工作区 vs HEAD 口径）
      const path = String(args.path ?? "");
      const ignoreWs = Boolean(args.ignoreWhitespace);
      const diffArgs = ["diff", "HEAD"];
      if (ignoreWs) diffArgs.push("-w");
      diffArgs.push("-U3", "--", path);
      const diff_text = await inRepo(diffArgs);
      const hunks: { old_start: number; old_lines: number; new_start: number; new_lines: number }[] = [];
      for (const line of diff_text.split("\n")) {
        if (!line.startsWith("@@ ")) continue;
        const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (!m) continue;
        hunks.push({
          old_start: parseInt(m[1], 10),
          old_lines: m[2] === undefined ? 1 : parseInt(m[2], 10),
          new_start: parseInt(m[3], 10),
          new_lines: m[4] === undefined ? 1 : parseInt(m[4], 10),
        });
      }
      return { hunks, diff_text };
    }
    case "git_apply_hunk": {
      // 迭代 2：hunk 级 stage/unstage/discard。Windows 三坑齐踩后的结论：
      //  1) execFile stdin pipe 与 git 内部锁冲突 → 走 patch 文件；
      //  2) 系统临时目录路径被 MSYS git 拒开 → 放 .git/ 内（永不进 status）；
      //  3) 前端传来的 root 是正斜杠，join 出的路径被 MSYS git 路径转换弄丢 →
      //     必须 path.resolve 归一成系统原生分隔符（反斜杠）再传 git。
      const mode = String(args.mode ?? "");
      const patch = String(args.patch ?? "");
      if (!patch.trim()) throw new Error("patch 不能为空");
      const patchFile = resolve(join(root, ".git", `pylume-e2e-patch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.diff`));
      writeFileSync(patchFile, patch, "utf8");
      try {
        const gitArgs = ["apply", "--recount", "--unidiff-zero"];
        if (mode === "stage") gitArgs.push("--cached");
        else if (mode === "unstage") gitArgs.push("--cached", "-R");
        else if (mode === "discard") gitArgs.push("-R");
        else throw new Error(`未知 mode：${mode}`);
        gitArgs.push(patchFile);
        // 必须 return await：裸 return promise 的 rejection 不会进本 catch（JS 语义坑）
        return await inRepo(gitArgs);
      } catch (e) {
        // 诊断增强：git 报打不开时附带文件存在性 + 目录内容（定位写读不一致）
        const diag = `patchFile=${patchFile} exists=${existsSync(patchFile)} gitDir=${readdirSync(join(root, ".git")).slice(0, 5).join(",")}`;
        throw new Error(`${String(e)} [diag: ${diag}]`);
      } finally {
        rmSync(patchFile, { force: true });
      }
    }
    case "git_diff_versions": {
      // staged ? HEAD↔Index : Index↔工作区（对齐 git_cmds.rs::git_diff_versions 语义）
      const path = String(args.path ?? "");
      const staged = arg<boolean>("staged", false);
      const readVer = async (rev: string): Promise<string> => {
        try { return await inRepo(["show", `${rev}:./${path}`]); }
        catch { return ""; } // 新文件一侧不存在 → 空
      };
      const head = await readVer("HEAD");
      const index = await readVer("");
      const worktree = readFileSync(join(root, path), "utf8");
      return {
        old: staged ? head : index,
        new: staged ? index : worktree,
        old_label: staged ? "HEAD" : "暂存区",
        new_label: staged ? "暂存区" : "工作区",
      };
    }
    case "git_fetch":
    case "git_pull":
    case "git_push": {
      // 迭代 4：本机 git 无法连本地 bare（EDR 拦截），push/pull 走「配置级」模拟——
      // git_push 带 remote+branch 时执行等价的 ref 写入（update-ref refs/remotes/...），
      // 让前端的上游绑定与同步计数链路可验证；fetch 恒成功（远程分支列表已由 refs 直写构造）。
      if (cmd === "git_push" && args.remote) {
        const branch = String(args.branch ?? "main").replace(/^HEAD:/, "").replace("refs/heads/", "");
        const head = await inRepo(["rev-parse", "HEAD"]);
        await inRepo(["update-ref", `refs/remotes/${String(args.remote)}/${branch}`, head.trim()]);
        await inRepo(["config", `remote.${String(args.remote)}.fetch`, `+refs/heads/*:refs/remotes/${String(args.remote)}/*`]);
        await inRepo(["config", `branch.${branch}.remote`, String(args.remote)]);
        await inRepo(["config", `branch.${branch}.merge`, `refs/heads/${branch}`]);
        return `模拟推送成功：${String(args.remote)}/${branch}（本机 file 协议被 EDR 拦截，改写远程跟踪 ref）`;
      }
      return `${cmd.slice(4)} 完成（E2E 简化执行）`;
    }
    case "git_cancel_op": {
      return null; // 无真实网络操作在途，取消即 no-op
    }
    case "git_remote_list": {
      const out = await inRepo(["remote", "-v"]);
      const remotes: { name: string; url: string; fetch: string }[] = [];
      const seen = new Set<string>();
      for (const line of out.split("\n")) {
        if (!line.endsWith("(fetch)")) continue;
        const body = line.replace(/\s*\(fetch\)$/, "");
        const tab = body.indexOf("\t");
        if (tab < 0) continue;
        const name = body.slice(0, tab);
        const url = body.slice(tab + 1);
        if (seen.has(name)) continue;
        seen.add(name);
        const fetch = await inRepo(["config", `remote.${name}.fetch`]).then((s) => s.trim()).catch(() => "");
        remotes.push({ name, url, fetch });
      }
      return remotes;
    }
    case "git_remote_add": {
      const name = String(args.name ?? "").trim();
      const url = String(args.url ?? "").trim();
      if (!name || !url) throw new Error("远程名与 URL 不能为空");
      return inRepo(["remote", "add", name, url]);
    }
    // ---------- 迭代 5：worktree ----------
    case "git_worktree_list": {
      const out = await inRepo(["worktree", "list", "--porcelain"]);
      const trees: { path: string; branch: string | null; main: boolean }[] = [];
      let path = "";
      let branch: string | null = null;
      let started = false;
      for (const line of out.split("\n")) {
        if (line.startsWith("worktree ")) {
          if (started) trees.push({ path, branch, main: false });
          path = line.slice("worktree ".length);
          branch = null;
          started = true;
        } else if (line.startsWith("branch ")) {
          branch = line.slice("branch ".length).replace("refs/heads/", "");
        }
      }
      if (started) trees.push({ path, branch, main: false });
      if (trees[0]) trees[0].main = true;
      return trees;
    }
    case "git_worktree_add": {
      const path = String(args.path ?? "").trim();
      const branch = String(args.branch ?? "").trim();
      if (!path) throw new Error("worktree 路径不能为空");
      if (path.includes("..")) throw new Error("worktree 路径不得包含 ..");
      const a = ["worktree", "add"];
      if (args.new_branch) a.push("-b", branch);
      a.push(path);
      if (!args.new_branch && branch) a.push(branch);
      return inRepo(a);
    }
    case "git_worktree_remove": {
      const path = String(args.path ?? "").trim();
      if (!path) throw new Error("worktree 路径不能为空");
      const a = ["worktree", "remove"];
      if (args.force) a.push("--force");
      a.push(path);
      return inRepo(a);
    }
    // ---------- 验收补齐：冲突命令 ----------
    case "git_conflict_versions": {
      const path = String(args.path ?? "");
      const readStage = async (stage: string): Promise<string> =>
        inRepo(["show", `:${stage}:${path}`]).catch(() => "");
      const [base, current, incoming] = await Promise.all([readStage("1"), readStage("2"), readStage("3")]);
      return { base, current, incoming };
    }
    case "git_accept_current": {
      const path = String(args.path ?? "");
      await inRepo(["checkout", "--ours", "--", path]);
      return inRepo(["add", "--", path]);
    }
    case "git_accept_incoming": {
      const path = String(args.path ?? "");
      await inRepo(["checkout", "--theirs", "--", path]);
      return inRepo(["add", "--", path]);
    }
    case "git_remote_remove": {
      const name = String(args.name ?? "").trim();
      if (!name) throw new Error("远程名不能为空");
      return inRepo(["remote", "remove", name]);
    }
    case "git_stash_push": {
      const a = ["stash", "push"];
      if (args.includeUntracked) a.push("-u");
      const msg = String(args.message ?? "").trim();
      if (msg) a.push("-m", msg);
      return inRepo(a);
    }
    case "git_stash_pop": {
      return inRepo(["stash", "pop"]);
    }
    case "git_stash_list": {
      return (await inRepo(["stash", "list"])).split("\n").filter(Boolean);
    }
    case "git_stash_pop_at": {
      return inRepo(["stash", "pop", `stash@{${arg<number>("index")}}`]);
    }
    case "git_stash_drop_at": {
      return inRepo(["stash", "drop", `stash@{${arg<number>("index")}}`]);
    }
    case "git_checkout": {
      const a = ["checkout"];
      if (args.track) a.push("--track");
      a.push(String(args.branch ?? ""));
      return inRepo(a);
    }
    case "git_create_branch": {
      return inRepo(["checkout", "-b", String(args.name ?? "")]);
    }
    case "git_discard": {
      // 对齐 git_cmds.rs::git_discard：tracked 文件 `git checkout -- <paths>`
      const paths = arg<string[]>("paths");
      if (Array.isArray(paths) && paths.length > 0) await inRepo(["checkout", "--", ...paths]);
      return null;
    }
    case "git_clean": {
      // 对齐 git_cmds.rs::git_clean：未跟踪文件/目录直接 fs 删除（不依赖 git clean 语义）
      const paths = arg<string[]>("paths");
      for (const rel of paths ?? []) {
        const target = resolve(join(root, String(rel)));
        if (target !== root && !target.startsWith(root + sep)) throw new Error(`[e2e-bridge] 越权路径: ${rel}`);
        rmSync(target, { recursive: true, force: true });
      }
      return null;
    }
    default:
      throw new Error(`[e2e-bridge] 未实现的 git 命令: ${cmd}`);
  }
}

// ---------- fs 命令实现（限仓库根内，防越权） ----------

/** fs 命令白名单（未列出的 fs 命令直接报错，避免静默 null 引发前端崩溃难排查） */
const FS_DISPATCH_CMDS = new Set(["list_dir", "read_dir", "read_file", "read_file_base64", "write_file",
  "create_dir", "create_file", "create_py_package", "rename_path", "paste_path", "delete_file", "watch_start", "watch_stop", "list_workspace_files",
  "create_project"]);

async function dispatchFs(cmd: string, args: Record<string, unknown>, repo: GitRepo): Promise<unknown> {
  const guard = (p: string): string => {
    const abs = p.includes(":") || p.startsWith("\\\\") ? p : join(repo.root, p);
    const norm = abs.replace(/\\/g, "/").toLowerCase();
    const rootNorm = repo.root.replace(/\\/g, "/").toLowerCase();
    if (!norm.startsWith(rootNorm + "/") && norm !== rootNorm) throw new Error(`[e2e-fs] 越权路径: ${p}`);
    return abs;
  };
  switch (cmd) {
    case "list_dir": {
      const dir = guard(String(args.path ?? repo.root));
      if (!existsSync(dir)) return [];
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.name !== ".git")
        .map((e) => ({ name: e.name, path: join(dir, e.name), is_dir: e.isDirectory() }));
    }
    case "read_dir": {
      // 文件树用（对齐 Rust read_dir：非 showHidden 时滤点开头；目录在前、名字序）
      const dir = guard(String(args.path ?? repo.root));
      if (!existsSync(dir)) return [];
      const showHidden = Boolean(args.showHidden);
      const entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => showHidden || !e.name.startsWith("."))
        .filter((e) => e.name !== "target")
        .map((e) => ({ name: e.name, path: join(dir, e.name), is_dir: e.isDirectory() }));
      entries.sort((a, b) => (a.is_dir === b.is_dir ? a.name.localeCompare(b.name) : a.is_dir ? -1 : 1));
      return entries;
    }
    case "read_file": {
      return readFileSync(guard(String(args.path)), "utf8");
    }
    case "read_file_base64": {
      return readFileSync(guard(String(args.path))).toString("base64");
    }
    case "write_file": {
      const target = guard(String(args.path));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, String(args.content ?? ""), "utf8");
      return null;
    }
    case "create_dir": {
      mkdirSync(guard(String(args.path)), { recursive: true });
      return null;
    }
    // PR-K：对齐 Rust file_ops::create_file（已存在报错；父目录不存在自动创建）
    case "create_file": {
      const target = guard(String(args.path));
      if (existsSync(target)) throw new Error(`文件已存在：${target}`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "", "utf8");
      return null;
    }
    // 对齐 Rust file_ops::create_py_package（目录 + 空 __init__.py 原子创建；已存在报错）
    case "create_py_package": {
      const pkg = guard(String(args.path));
      if (existsSync(pkg)) throw new Error(`路径已存在：${pkg}`);
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, "__init__.py"), "", "utf8");
      return null;
    }
    case "rename_path": {
      renameSync(guard(String(args.oldPath)), guard(String(args.newPath)));
      return null;
    }
    case "delete_file": {
      const target = guard(String(args.path));
      if (existsSync(target)) {
        const rm = await import("node:fs/promises");
        await rm.rm(target, { recursive: true, force: true });
      }
      return null;
    }
    case "paste_path": {
      throw new Error("[e2e-fs] paste_path 未实现（当前用例不覆盖）");
    }
    case "list_workspace_files": {
      // quickOpen 文件源：递归列出仓库内文件（对齐后端 ignore 走查的粗粒度——跳 .git 即可）
      const out: string[] = [];
      const walk = (dir: string): void => {
        if (!existsSync(dir)) return;
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (e.name === ".git" || e.name === ".pylume") continue;
          const p = join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else out.push(p);
        }
      };
      walk(repo.root);
      return out;
    }
    case "watch_start":
    case "watch_stop":
      return null; // watcher 走轮询刷新即可
    // F9（新建 FastAPI 项目）：对齐 Rust fs_cmds::create_project（真实磁盘）。
    // 模板与 Rust 粗粒度同步（断言只锁 FastAPI( / fastapi 键形状，细节以 Rust 单测为准——
    // fs_cmds.rs test_create_project_fastapi_template_and_deps 注释互指本处）。
    case "create_project": {
      const parent = String(args.parentDir ?? "");
      const name = String(args.name ?? "");
      const projectType = String(args.projectType ?? "script");
      if (!name || /[\\/:*?"<>|]/.test(name)) throw new Error(`项目名称非法：${name}`);
      // guard(parent)：真实磁盘调用方（NP-2）用 parent=repo.root 绕开越权 guard 的语义在此不适用——
      // 项目目录在 repo 内（repo.root/<name>），guard(parent) 校验父目录合法即可
      const parentAbs = guard(parent);
      if (!existsSync(parentAbs)) throw new Error(`位置不存在或不是文件夹：${parent}`);
      const root = join(parentAbs, name);
      if (existsSync(root)) throw new Error(`目标已存在：${root}`);
      mkdirSync(root, { recursive: true });
      const isFastapi = projectType === "fastapi";
      const mainPy = isFastapi
        ? 'from fastapi import FastAPI\n\napp = FastAPI()\n\n\n@app.get("/")\ndef root() -> str:\n    return "Hello from Pylume FastAPI!"\n'
        : 'def main() -> None:\n    print("Hello from Pylume!")\n\n\nif __name__ == "__main__":\n    main()\n'
      writeFileSync(join(root, "main.py"), mainPy, "utf8");
      // 最小 pyproject（对齐 Rust 方案 B 形状；方案 A/B 断言都用 contains）
      const pkg = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[._-]+|[._-]+$/g, "") || "app";
      const depsLine = isFastapi ? 'dependencies = ["fastapi", "uvicorn"]' : "dependencies = []";
      writeFileSync(
        join(root, "pyproject.toml"),
        `[project]\nname = "${pkg}"\nversion = "0.1.0"\nrequires-python = ">=3.12"\n${depsLine}\n`,
        "utf8",
      );
      if (args.gitInit) {
        writeFileSync(join(root, ".gitignore"), "# Python\n__pycache__/\n.venv/\n", "utf8");
        // git init 交由前端后续 git 流程；mock 下 gitInit 仅落 .gitignore（E2E 不断言 git_ok）
      }
      return { path: root, git_ok: true, git_message: "", pyproject_note: "E2E mock：已写入最小 pyproject.toml" };
    }
    default:
      throw new Error(`[e2e-fs] 未实现命令: ${cmd}`);
  }
}

// ---------- 真实 pyrefly LSP 桥（pyrefly 适配 E2E 用） ----------

/**
 * 在 Node 侧 spawn 真实 `pyrefly lsp` 进程，实现 Content-Length 帧解析，
 * 把前端 `lsp_send_*` 命令转发给真实引擎、引擎回包经 `lsp-message` 事件回灌页面。
 * 复刻 Rust lsp.rs 的协议形为：Content-Length 头 + `\r\n\r\n`、resolve_lsp_command 后 stdio、
 * 引擎回包 JSON 里注入 `engine` 字段。目的：真实验证前端 LSP 桥对 pyrefly 的适配
 *（initialize capabilities / documentSymbol hierarchical / didChange 全量 / 诊断 / 跳转 / 补全）。
 */
function realPyreflyBridgeFor(page: Page, cwd: string) {
  let proc: ReturnType<typeof spawn> | null = null;
  let stdoutBuf = Buffer.alloc(0);

  const emit = (event: string, payload: unknown): void => {
    void page
      .evaluate(
        ([ev, p]) => {
          (window as unknown as { __TAURI_INTERNALS__?: { __emit?: (e: string, p: unknown) => void } }).__TAURI_INTERNALS__?.__emit?.(ev, p);
        },
        [event, payload] as const,
      )
      .catch(() => { /* 页面跳转瞬间可忽略 */ });
  };

  const feedStdout = (chunk: Buffer): void => {
    stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
    for (;;) {
      const headerEnd = stdoutBuf.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = stdoutBuf.slice(0, headerEnd).toString("ascii");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) return;
      const len = parseInt(m[1], 10);
      const bodyStart = headerEnd + 4;
      if (stdoutBuf.length < bodyStart + len) return; // 帧不完整，等下一块
      const body = stdoutBuf.slice(bodyStart, bodyStart + len);
      stdoutBuf = stdoutBuf.slice(bodyStart + len);
      try {
        const msg = JSON.parse(body.toString("utf8"));
        if (msg && typeof msg === "object" && !Array.isArray(msg)) {
          (msg as Record<string, unknown>).engine = "static"; // 复刻 Rust 注入 engine 字段
        }
        emit("lsp-message", msg);
      } catch { /* 坏帧忽略 */ }
    }
  };

  const write = (obj: unknown): void => {
    if (!proc) throw new Error("[real-pyrefly] 引擎未启动");
    const payload = JSON.stringify(obj);
    proc.stdin!.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`, "utf8");
  };

  return {
    start(command: string, args: string[], lspCwd?: string): void {
      proc = spawn(command, args, { cwd: lspCwd ?? cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      proc.stdout!.on("data", (c: Buffer) => feedStdout(c));
      proc.stderr!.on("data", (c: Buffer) => emit("lsp-stderr", { engine: "static", data: c.toString("utf8") }));
      proc.on("exit", (code) => emit("lsp-exit", { engine: "static", code }));
    },
    sendRequest(_engine: string, id: unknown, method: string, params: unknown): void {
      write({ jsonrpc: "2.0", id, method, params });
    },
    sendNotification(_engine: string, method: string, params: unknown): void {
      write({ jsonrpc: "2.0", method, params });
    },
    sendResponse(_engine: string, id: unknown, result: unknown): void {
      write({ jsonrpc: "2.0", id, result });
    },
    stop(): void {
      proc?.kill();
      proc = null;
      stdoutBuf = Buffer.alloc(0);
    },
  };
}

// ---------- 编辑器 gutter 交互（debug 验收共享） ----------

/** 点击编辑器第 line 行的 glyph 边距（模拟用户点行号左侧空白下断点）。
 *  以「渲染后的行」定位（.view-line 序 = 行序，前提是无软换行）：引用计数 CodeLens
 *  会在 def/class 上方插入 view zone 改变行的视口位置——按 (line-1)*lineHeight 计算
 *  会点进 zone，Monaco 判为 GUTTER_VIEW_ZONE 而非 GUTTER_GLYPH_MARGIN，断点静默丢失
 *  （D-FUNC-1 flake 根因）。真实用户点的就是渲染后的行，此取法对 zone 免疫。 */
export async function clickGlyph(page: Page, line: number): Promise<void> {
  const glyph = await page.locator(".glyph-margin").first().boundingBox();
  if (!glyph) throw new Error("glyph-margin 不可见");
  const row = await page.locator(".view-line").nth(line - 1).boundingBox();
  if (!row) throw new Error(`第 ${line} 行未渲染（.view-line 不足）`);
  await page.mouse.click(glyph.x + 6, row.y + row.height / 2);
}

// ---------- Page 装配 ----------

/** 给 page 装上 Tauri mock + E2E bridge，并让应用启动即打开 repo 工作区。
 *  opts.slowGitMs：指定命令前注入延迟（E2E-09 防重入验收用，如 { fetch: 3000 }）。
 *  opts.pluginsDir：插件目录（plugin 验收用）——提供后 list_plugin_dirs/read_plugin_file
 *  映射到该真实目录，写命令后自动触发 plugins-dir-changed（复刻 Rust watcher 行为）。 */
/** 给 page 装上 Tauri mock + E2E bridge，并让应用启动即打开 repo 工作区。
 *  opts.slowGitMs：指定命令前注入延迟（E2E-09 防重入验收用，如 { fetch: 3000 }）。
 *  opts.pluginsDir：插件目录（plugin 验收用）——提供后 list_plugin_dirs/read_plugin_file
 *  映射到该真实目录；返回值附带 triggerPluginsChanged() 供测试手动模拟 watcher 事件。
 *  opts.realPyrefly：true 时 LSP 命令走 Node 侧真实 `pyrefly lsp` 进程（而非 tauri-mock
 *  内置语义引擎），用于真实验证前端对 pyrefly 的协议适配。
 *  opts.startEmpty：true 时最近工作区为空——应用启动停在欢迎页（F9 新建项目面板用：
 *  有工作区时 #ew-actions 隐藏，欢迎页入口不可达）。 */
export async function equipPage(page: Page, repo: GitRepo, opts: { slowGitMs?: Record<string, number>; pluginsDir?: string; realPyrefly?: boolean; startEmpty?: boolean } = {}) {
  // realPyrefly 标志须先于 mock 注入（addInitScript 按序执行；mock 读取 window.__E2E_LSP_REAL__ 决定走真实进程还是内置语义引擎）
  if (opts.realPyrefly) {
    await page.addInitScript(() => {
      (window as unknown as { __E2E_LSP_REAL__?: boolean }).__E2E_LSP_REAL__ = true;
    });
  }
  const mockSrc = readFileSync(MOCK_PATH, "utf8");
  // 注入必须在任何应用模块前（addInitScript 保证先于页面脚本执行）
  await page.addInitScript(mockSrc);
  let recentWorkspaces: string[] = opts.startEmpty ? [] : [repo.root];
  const slowGitMs = opts.slowGitMs ?? {};
  const pluginsDir = opts.pluginsDir;
  // 真实 pyrefly 桥（惰性 start，见 bridge 的 "lsp" 通道）
  const pyrefly = opts.realPyrefly ? realPyreflyBridgeFor(page, repo.root) : null;

  /** 模拟 Rust watcher 推送 fs-changed（真实 Tauri 下由 notify 驱动，mock 由写操作后触发） */
  const emitFsChanged = (paths: string[]): void => {
    void page.evaluate(([ev, payload]) => {
      const internals = (window as unknown as { __TAURI_INTERNALS__?: { __emit?: (e: string, p: unknown) => void } }).__TAURI_INTERNALS__;
      internals?.__emit?.(ev, payload);
    }, ["fs-changed", paths] as const).catch(() => { /* 页面跳转瞬间可忽略 */ });
  };

  // git/fs 写命令完成后推送 fs-changed（驱动前端 refreshGitStatus/文件树增量刷新，
  // 复刻真实 watcher 的行为——UI 状态更新依赖该事件链，而非命令返回值）
  const GIT_WRITE_CMDS = new Set(["git_stage", "git_unstage", "git_commit", "git_discard", "git_clean",
    "git_accept_current", "git_accept_incoming", "git_stash_push", "git_stash_pop", "git_stash_pop_at",
    "git_stash_drop_at", "git_checkout", "git_create_branch", "git_init"]);
  const FS_WRITE_CMDS = new Set(["write_file", "create_dir", "create_file", "create_py_package", "rename_path", "delete_file"]);

  /** 模拟 Rust plugin watcher 推送 plugins-dir-changed（plugin_cmds.rs::watch_plugins_dir） */
  const emitPluginsDirChanged = (): void => {
    void page.evaluate(() => {
      const internals = (window as unknown as { __TAURI_INTERNALS__?: { __emit?: (e: string, p: unknown) => void } }).__TAURI_INTERNALS__;
      internals?.__emit?.("plugins-dir-changed", null);
    }).catch(() => { /* 页面跳转瞬间可忽略 */ });
  };

  /** plugin_cmds 分发（形状对齐 plugin_cmds.rs）：list/read/scaffold/get_plugins_dir/get_data_doc_path */
  const dispatchPlugins = async (cmd: string, args: Record<string, unknown>): Promise<unknown> => {
    if (cmd === "get_plugins_dir") return pluginsDir ?? "";
    if (cmd === "get_data_doc_path") {
      // 对齐 Rust：仅文件名，落 plugins 根旁的 docs（测试域内）
      const name = String(args.name ?? "");
      if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) throw new Error("文档名不合法");
      const dir = pluginsDir ? join(pluginsDir, "..", "docs") : join(repo.root, "docs");
      mkdirSync(dir, { recursive: true });
      return join(dir, name);
    }
    if (cmd === "scaffold_plugin") {
      // 对齐 Rust scaffold_plugin（P1 三模板 + .d.ts）：id 校验 + 不覆盖已有 + manifest/entry/d.ts 落盘
      if (!pluginsDir) throw new Error("[e2e-plugins] 未提供 pluginsDir");
      const id = String(args.id ?? "");
      const name = String(args.name ?? "");
      const template = String(args.template ?? "panel");
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error(`插件 id 不合法：${id}`);
      if (!name.trim()) throw new Error("插件名称不能为空");
      if (!["panel", "inline", "blank"].includes(template)) throw new Error(`未知模板：${template}`);
      const root = join(pluginsDir, id);
      if (existsSync(root)) throw new Error(`目录已存在：${root}（不覆盖已有插件）`);
      mkdirSync(root, { recursive: true });
      const nameJson = JSON.stringify(name);
      const inlineDecl = template === "blank" ? "" : `,\n        "inline": { "label": "问候选区", "handler": "helloSelection" }`;
      const title = template === "inline" ? "问候选区" : template === "blank" ? "我的工具" : "我的第一个工具";
      const manifest = `{"schemaVersion": 1,\n  "id": "${id}",\n  "name": ${nameJson},\n  "version": "0.1.0",\n  "engines": { "pylume": ">=0.1.0" },\n  "contributes": {\n    "tools": [\n      {\n        "id": "hello",\n        "title": "${title}",\n        "description": "脚手架模板",\n        "category": "文本",\n        "icon": "rocket",\n        "entry": "./hello.js"${inlineDecl}\n      }\n    ]\n  },\n  "permissions": ["clipboard", "selection"]\n}\n`;
      const entry =
        template === "inline"
          ? `// @ts-check\n/** inline 变换（E2E 复刻版）\n * @param {string} text\n * @param {ToolHost} host\n * @returns {string}\n */\nexport function helloSelection(text, host) {\n  host.log("变换输入：" + text.slice(0, 50));\n  return "你好，" + text + "！";\n}\n`
          : `// @ts-check\nexport function mount(host) { const { kit } = host; const wrap = kit.body(); const input = kit.textarea({ placeholder: "输入名字…", flex: true }); const out = kit.output({}); const greet = () => { out.set("你好，" + (input.value.trim() || "世界") + "！"); host.log("问候了：" + input.value.trim()); }; const go = kit.primaryButton("问候", "play", greet); wrap.append(input, kit.toolbar(go), out.el); host.root.appendChild(wrap); greet(); }\nexport function helloSelection(text) { return "你好，" + text + "！"; }\n`;
      writeFileSync(join(root, "pylume.plugin.json"), manifest, "utf8");
      writeFileSync(join(root, "hello.js"), entry, "utf8");
      writeFileSync(join(root, "pylume-plugin.d.ts"), "// 类型声明（E2E 复刻占位）\n", "utf8");
      return root;
    }
    if (cmd === "export_plugin") {
      // E2E 语义模拟：真实 zip 编解码由 Rust plugin_pkg 单测覆盖（Zip Slip/结构校验/噪声过滤）。
      // 此处复刻往返语义：包内含单顶层目录（=插件 id，对齐 Rust zip 结构），验证前端 UI 链路。
      if (!pluginsDir) throw new Error("[e2e-plugins] 未提供 pluginsDir");
      const src = String(args.pluginDir ?? "");
      const save = String(args.savePath ?? "");
      if (!src || !save) throw new Error("export_plugin 参数缺失");
      if (!existsSync(src)) throw new Error(`插件目录不存在：${src}`);
      const id = basename(src);
      // 先清旧目标（上一轮测试残留的包会与新 cpSync 合并 → 结构错乱）
      if (existsSync(save)) rmSync(save, { recursive: true, force: true });
      mkdirSync(dirname(save), { recursive: true });
      cpSync(src, join(save, id), { recursive: true });
      return save;
    }
    if (cmd === "plugin_export_filename") {
      const m = JSON.parse(readFileSync(join(String(args.pluginDir ?? ""), "pylume.plugin.json"), "utf8"));
      return `${m.id ?? "plugin"}-${m.version ?? "0.0.0"}.zip`;
    }
    if (cmd === "import_plugin") {
      // E2E 语义模拟（同上）：校验逻辑对齐 Rust（单顶层 + manifest + id 一致 + 不覆盖）
      if (!pluginsDir) throw new Error("[e2e-plugins] 未提供 pluginsDir");
      const zipPath = String(args.zipPath ?? "");
      if (!existsSync(zipPath)) throw new Error(`zip 不存在：${zipPath}`);
      const tops = readdirSync(zipPath).filter((n) => !n.startsWith("."));
      if (tops.length !== 1) throw new Error("zip 结构不对：应只有一个顶层目录（插件 id）");
      const id = tops[0];
      const srcRoot = join(zipPath, id);
      const manifestPath = join(srcRoot, "pylume.plugin.json");
      if (!existsSync(manifestPath)) throw new Error("插件目录缺少 pylume.plugin.json");
      const m = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (m.id !== id) throw new Error(`manifest.id（${m.id}）与目录名（${id}）不一致`);
      const dest = join(pluginsDir, id);
      if (existsSync(dest)) throw new Error(`插件 ${id} 已存在（不覆盖）`);
      cpSync(srcRoot, dest, { recursive: true });
      return dest;
    }
    if (!pluginsDir) return cmd === "list_plugin_dirs" ? [] : null;
    if (cmd === "list_plugin_dirs") {
      // 对齐 Rust：只列含 pylume.plugin.json 的一级子目录，目录名序
      if (!existsSync(pluginsDir)) return [];
      return readdirSync(pluginsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(pluginsDir, e.name, "pylume.plugin.json")))
        .map((e) => ({ dir_name: e.name, dir_path: join(pluginsDir, e.name) }))
        .sort((a, b) => a.dir_name.localeCompare(b.dir_name));
    }
    if (cmd === "read_plugin_file") {
      // 对齐 Rust：相对路径 + 禁越界（前缀组件比较）
      const base = String(args.pluginDir ?? "");
      const rel = String(args.rel ?? "");
      if (rel.includes("..") || rel.isAbsolute === true || /^[a-zA-Z]:/.test(rel) || rel.startsWith("/") || rel.startsWith("\\")) {
        throw new Error("[e2e-plugins] 插件文件路径必须是相对路径");
      }
      const full = resolve(join(base, rel));
      const baseNorm = resolve(base);
      if (!full.startsWith(baseNorm)) throw new Error("[e2e-plugins] 插件文件路径越界");
      if (!existsSync(full)) throw new Error(`[e2e-plugins] 插件文件不存在: ${rel}`);
      return readFileSync(full, "utf8");
    }
    return null;
  };

  // ---------- 迭代 6：clone 域 mock（git_clone / git_default_branch / git_cancel_op["clone"]）----------
  // 本机 file 协议被 EDR 拦截（git_push 同款结论）——clone 走「落盘模拟」：在目标目录
  // 生成 README.md + main.py 并 git init + commit，产出与真实 clone 等价的磁盘结果；
  // 进度行经 __TAURI_INTERNALS__.__emit 推 git-op-stdout 事件（前端流式消费用）。
  // 行为注入：window.__E2E_CLONE_PRESET__（tauri-mock 附加进 args.__preset）：
  //   fail: "notEmpty"|"auth"|"net" · delayMs（取消窗口）· files（落盘内容覆写）· branch。
  type ClonePreset = { fail?: "notEmpty" | "auth" | "net"; delayMs?: number; files?: Record<string, string>; branch?: string };
  let pendingCloneCancel: (() => void) | null = null;

  const emitCloneProgress = (data: string): Promise<void> =>
    page
      .evaluate(([ev, payload]) => {
        (window as unknown as { __TAURI_INTERNALS__?: { __emit?: (e: string, p: unknown) => void } })
          .__TAURI_INTERNALS__?.__emit?.(ev, payload);
      }, ["git-op-stdout", { op: "clone", data }] as const)
      .then(() => undefined);

  const runGitClone = async (a: Record<string, unknown>): Promise<string> => {
    const preset = (a.__preset ?? null) as ClonePreset | null;
    const target = resolve(String(a.targetDir ?? a.target_dir ?? ""));
    const url = String(a.url ?? "");
    const branch = a.branch ? String(a.branch) : null;
    if (preset?.delayMs) await new Promise((r) => setTimeout(r, preset.delayMs));
    const line = (data: string): Promise<void> => emitCloneProgress(data);
    await line(`Cloning into '${basename(target)}'...`);
    if (preset?.fail === "notEmpty")
      throw new Error(`fatal: destination path '${target}' already exists and is not an empty directory.`);
    if (preset?.fail === "auth") throw new Error(`fatal: Authentication failed for '${url}'`);
    if (preset?.fail === "net")
      throw new Error(`fatal: unable to access '${url}': Could not resolve host: github.com`);
    // 成功：落盘模拟 clone 结果
    mkdirSync(target, { recursive: true });
    const files = preset?.files ?? { "README.md": "# cloned-repo\n\nE2E clone fixture\n", "main.py": "print('hello clone')\n" };
    for (const [rel, content] of Object.entries(files)) {
      const f = join(target, rel);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, content, "utf8");
    }
    await line("remote: Enumerating objects: 12, done.");
    await line("Receiving objects:  50% (6/12)");
    await line("Receiving objects: 100% (12/12), done.");
    const cfg = ["-c", "user.name=E2E Tester", "-c", "user.email=e2e@test.local", "-c", "core.autocrlf=false"];
    await execFileAsync("git", [...cfg, "init", "--quiet", "-b", branch ?? "main"], { cwd: target }).catch(() => { /* 尽力而为 */ });
    await execFileAsync("git", [...cfg, "add", "-A"], { cwd: target }).catch(() => { /* 尽力而为 */ });
    await execFileAsync("git", [...cfg, "commit", "--quiet", "-m", "initial"], { cwd: target }).catch(() => { /* 尽力而为 */ });
    await line(`Switched to a new branch '${branch ?? "main"}'`);
    return `Cloning into '${basename(target)}'... done.`;
  };

  await page.exposeFunction("__E2E_BRIDGE__", (channel: string, cmd: string, args: unknown) => {
    const relToAbs = (p: string): string => (p && !p.includes(":") && !p.startsWith("\\\\") ? join(repo.root, p) : p);
    let result: Promise<unknown>;
    if (channel === "git") {
      const delay = slowGitMs[cmd];
      const run = (): Promise<unknown> => {
        // 迭代 6：clone 域命令特判（Node 侧可取消的 pending clone / 分支预览静态返回）
        if (cmd === "git_clone") {
          return new Promise((res, rej) => {
            let settled = false;
            pendingCloneCancel = () => {
              if (!settled) { settled = true; rej(new Error("已取消")); }
            };
            runGitClone(args as Record<string, unknown>).then(
              (v) => { if (!settled) { settled = true; res(v); } },
              (e) => { if (!settled) { settled = true; rej(e); } },
            );
          });
        }
        if (cmd === "git_cancel_op" && String((args as Record<string, unknown>).op ?? "") === "clone") {
          pendingCloneCancel?.();
          pendingCloneCancel = null;
          return Promise.resolve(null);
        }
        if (cmd === "git_default_branch") {
          const preset = ((args as Record<string, unknown>).__preset ?? null) as ClonePreset | null;
          return Promise.resolve(preset?.branch ?? "main");
        }
        return dispatchGit(cmd, args as Record<string, unknown>, repo);
      };
      result = delay ? (async () => { await new Promise((r) => setTimeout(r, delay)); return run(); })() : run();
    }
    else if (channel === "fs") result = dispatchFs(cmd, args as Record<string, unknown>, repo);
    else if (channel === "plugins") result = dispatchPlugins(cmd, args as Record<string, unknown>);
    else if (channel === "getRecentWorkspaces") return recentWorkspaces;
    else if (channel === "setRecentWorkspaces") { recentWorkspaces = cmd as unknown as string[]; return null; }
    else if (channel === "lsp") {
      // 真实 pyrefly 桥：lsp_* 命令 → Node 侧真实进程 stdio（Content-Length 帧）
      if (!pyrefly) throw new Error("[e2e-bridge] 未启用真实 pyrefly，却收到 lsp 命令");
      const a = (args ?? {}) as Record<string, unknown>;
      switch (cmd) {
        case "lsp_start":
          pyrefly.start(String(a.command ?? "pyrefly"), Array.isArray(a.args) ? (a.args as string[]) : [], a.cwd ? String(a.cwd) : undefined);
          return null;
        case "lsp_send_request":
          pyrefly.sendRequest(String(a.engine ?? "static"), a.id, String(a.method), a.params);
          return null;
        case "lsp_send_notification":
          pyrefly.sendNotification(String(a.engine ?? "static"), String(a.method), a.params);
          return null;
        case "lsp_send_response":
          pyrefly.sendResponse(String(a.engine ?? "static"), a.id, a.result);
          return null;
        case "lsp_stop": {
          // 只有面向 static 引擎的停止才杀真实 pyrefly；intel 停机（runtime_intel_enabled=false
          // 时 startLsp 末尾会 stopIntel → lsp_stop("intel")）不得误杀 static 引擎。
          const eng = String(a.engine ?? "");
          if (eng === "*" || eng === "all" || eng === "static") pyrefly.stop();
          return null;
        }
        default:
          return null;
      }
    }
    else throw new Error(`[e2e-bridge] 未知通道: ${channel}`);
    // 写命令完成 → 推送 fs-changed（.git 内部变化不在监听范围，推送仓库根触发全量刷新即可）
    return result.then((r) => {
      if (GIT_WRITE_CMDS.has(cmd)) emitFsChanged([repo.root]);
      else if (FS_WRITE_CMDS.has(cmd) && args && typeof args === "object" && "path" in (args as Record<string, unknown>)) {
        emitFsChanged([relToAbs(String((args as Record<string, unknown>).path))]);
      }
      return r;
    });
  });

  return { triggerPluginsChanged: emitPluginsDirChanged, stopPyrefly: () => pyrefly?.stop() };
}
