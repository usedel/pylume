# 贡献指南

感谢你愿意花时间。这份文件的目的是让你在动手前就知道：**改哪里、读哪份文档、过哪道门禁**。

## 1. 动手前先读

1. [`AGENTS.md`](AGENTS.md)——技术栈铁律与三语言规范红线索引，**跨 agent / 跨人通用**；
2. [`docs/delivery-overview.md`](docs/delivery-overview.md) §2——找到你要动的功能域，顺藤摸到它的计划真源与验收记录；
3. 该功能域的**专项计划文档**（计划里有 file:line 级落点，别直接读代码猜）；
4. [`docs/tech-debt.md`](docs/tech-debt.md)——确认你要做的事有没有被登记过。

**重要**：`docs/` 里标了「非排期依据」的调研报告不要当作需求。有些功能是被明确裁决**不做**的（pytest 面板、AI 能力、插件市场、协作编辑，见 `docs/python_ide_dev_plan_v2.md` §1.1），先查再写，免得白做。

## 2. 环境

当前**只支持 Windows**（ConPTY / WebView2 / NSIS，探针测试也假定 Windows 路径）。

| 工具 | 版本 |
|---|---|
| Node | 22 |
| Python | 3.13（uv 管理） |
| Rust | 1.96 |
| 平台 | Windows（CI 跑 `windows-latest`） |

```powershell
powershell -File .\tools\fetch-debugpy.ps1   # 拉 debugpy（sha256 锁定，产物不入库）
cd shell && npm install
npm run tauri dev
```

## 3. 分支与提交

- **主干开发 + 短分支 PR**；主干分支名 `master`。
- **CI 全绿才可合并**。
- 提交信息沿用现有风格：`type(scope): 简述`，如 `fix(theme): 行号色死映射`。type 常用 `feat` / `fix` / `docs` / `test` / `refactor` / `chore` / `ci`。
- 一个 PR 做一件事。跨功能域的改动拆开提。

## 4. 门禁

| 层 | 命令 |
|---|---|
| 前端 | `cd shell && npm test`（vitest；**别直接跑 vitest**，本机包装脚本处理盘符与 webstorage） |
| 前端类型 + 构建 | `cd shell && npm run build`（tsc + vite build） |
| E2E（mock 层） | `cd shell && npx playwright test` |
| Rust 外壳 | `cd shell/src-tauri && cargo test`；**改 `src-tauri` 后必须 `cargo check` 通过再交付** |
| 探针 | `cd probe && uv sync && uv run pytest` |
| 运行时智能 | `cd intel && cargo build -p pylume-intel`（**联调前必须 build**，cargo test 不刷新外壳调用的 exe） |
| UI token | `python tools/ui/audit_tokens.py`（98 项，退出码非 0 即失败） |
| 依赖扫描性能 | `cd shell/src-tauri && cargo test --release bench_dep_scan -- --ignored --nocapture`（红线 ≤ 2s） |

**真机 e2e（`shell/e2e-real/`）未进 CI**，由维护者手动执行（CDP 9223 + 隔离数据根）。你的 PR 本地全绿但真机有问题时，维护者会反馈，不是你的操作有误。

## 5. 代码规范红线

完整版在 `.codebuddy/rules/`，改动对应目录前先读全文。这里的几条最容易被违反：

**Python（probe 及所有 `*.py`）**
- 零第三方依赖；类型紧凑表示**绝不 repr 值本身**；trace 库 `shape` 列存空串而非 NULL；`_active` 计数禁止在 RAISE 回调里递减；探针只在 `PYLUME_PROBE_AUTOSTART=1` 时激活，任何失败只打警告、**不改写用户进程退出码**。

**Rust（`shell/src-tauri`）**
- 杀子进程必须 `util::kill_process_tree`（裸 `child.kill()` 会留孙进程孤儿）；stdin/PTY writer 用独立 `Arc<Mutex>`，锁内只克隆 Arc；DAP 固定 stdio adapter 模式，**禁止退回 TCP `--listen`**（ConPTY 下 pydevd 不建连）；`\\?\` verbatim 路径必须剥前缀。

**TypeScript（`shell/src`）**
- 补全四层合并 sortText 固定段位：模板 `0xx` → 运行时 `1xx` → 静态 `2xx` → 关键字 `3xx`；`main.ts` 不堆逻辑，新交互落功能域模块；禁用 `window.alert/confirm`，统一走 `dialog.ts`；色值走语义 token、字号间距走 scale token；**删任何样式类前先搜 TS 侧是否拿它当选择器钩子**。

## 6. 版本与依赖

工具链与外部组件版本锁定在 [`ci/versions.toml`](ci/versions.toml)。**升级任何组件必须 PR + bench 回归全绿**，别在功能 PR 里顺手升级。

## 7. 文档

- 每份文档有版本头（版本 / 日期 / 状态），修改时同步升版本。
- 一个功能域只有**一个真源**文档，别在两处写同一件事。
- 交付后更新对应验收记录；技术债登记到 `docs/tech-debt.md`。
- 发现文档互相矛盾：**发现即登记，登记即修**（`docs/delivery-overview.md` §4 是不一致台账）。

## 8. 不做的事

pytest 面板 · AI 能力 · 插件市场 · 协作编辑——已裁决不做，PR 会被拒。想讨论先开 issue 说明场景。
