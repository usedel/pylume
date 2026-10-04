# ADR-0003: LSP 接入采用自研轻量桥接层（Rust stdio ↔ Tauri IPC ↔ Monaco providers）

- 状态：**已定案（2026-08-20）**
- 日期：2026-08-20
- 决策者：开发团队提出，产品负责人随技术方案 v3 一并确认
- 上游：换壳裁决（Tauri 2 + Monaco 取代 Zed，2026-08-20）；交接文档议题 2

## 背景

换壳（Tauri 2 + Monaco）后，需要把 pyrefly（默认）/ basedpyright（备选）/ ruff / 未来的 pylume-intel 挂载到 Monaco。社区标准方案是 `monaco-languageclient`（TypeFox）。

## 调研（2026-08-20）

- `monaco-languageclient` 与 `monaco-editor` **版本强耦合**（官方兼容表：monaco-editor 0.52.2 ↔ monaco-languageclient 9.x；0.53+ 需 10.x）。升级 Monaco 必须同步升级整条依赖链。
- 它依赖 `@codingame/monaco-vscode-api`，把 vscode 编辑器服务层整体带入 WebView，包体积与内存显著增加，与 ≤600 MB 内存预算（裁决 #2）存在冲突风险。
- 补全管线经 vscode 服务层中转，多 LSP 合并（运行时优先 + `⟳ runtime` 来源标注）的自定义控制点变深。
- **本项目换壳的直接动因就是「补全排序完全可控」**，这是最高优先级的架构约束。

## 决策

**自研轻量 LSP 桥接层**，只实现所需 LSP 子集：

- **Rust 侧**（`shell/src-tauri/src/lsp.rs`）：spawn 引擎进程（stdio）、`Content-Length` 帧解析、经 Tauri 事件转发（`lsp-message` / `lsp-stderr` / `lsp-exit`）；
- **TS 侧**（`shell/src/lsp/`）：JSON-RPC 关联（请求/响应/通知/取消）、Monaco provider 注册（completion / hover / definition / diagnostics）、位置换算（LSP UTF-16 0 基 ↔ Monaco 1 基）；
- **引擎切换** = 更换 spawn 命令表条目（`pyrefly lsp` / `basedpyright-langserver --stdio`），桥接层本身引擎无关。

## 备选方案

| 方案 | 评估 | 结论 |
|---|---|---|
| monaco-languageclient | 功能全（rename / code action / semantic tokens 开箱即用），社区维护 | ❌ 重、版本耦合、补全合并控制点深；**保留为后备** |
| 自研轻量桥 | 完全可控、轻量、无版本耦合；代价是自维护协议子集（约 1-2 周） | ✅ **选定** |

## 后果

- **正面**：补全三层合并（模板 `0xx` / 运行时 `1xx` 预留 / 静态 `2xx`）完全可控；内存友好；Monaco 可独立升级；为 pylume-intel 的挂载预留了干净的合并点。
- **负面**：LSP 客户端子集自维护（增量同步、UTF-16 位置换算、请求取消）；后续需要 rename / semantic tokens 等重功能时按需扩协议，或届时再评估引入 monaco-languageclient。
- **约束**：桥接层必须保持**引擎无关**（不出现 pyrefly 专属分支逻辑），保证 basedpyright 与 pylume-intel 可直接复用。
