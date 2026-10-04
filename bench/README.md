# bench：基准项目集

> 对应开发计划 v2 S1-T05 / S1-T07。Phase 0 版本已清理，本目录为重建版。

## 样例项目

| 项目 | 特征 | 考察点 | 状态 |
|---|---|---|---|
| `sample/errors/` | 5 类错误 + 语法错误 | **traceback 点击跳转**（Gate B 验收第 3 条） | ✅ traceback 格式已验证 |
| `sample/fastapi_annotated/` | Pydantic 注解齐全 | 静态引擎上限（有注解补全 ≥95%） | ✅ 可导入 |
| `sample/unannotated_scraper/` | 无注解、动态结构 | 运行时采样价值（Phase 2/3 主战场） | ✅ 可导入 |
| `sample/pydantic_models/` | Pydantic 模型 + 标准库 dataclass 对照组 | **静态引擎对 Pydantic 的支持度**（F0：补全 / 类型检查 / 缺失必填 / 改名传播 / alias / validator） | ✅ 已实测，报告见 `reports/pydantic-engine-probe.md` |
| `sample/large_repo/` | 88 个 .py × 4 层深目录（生成器 `gen_large_repo.py`） | **dep_scan 全量性能红线 ≤ 2s**（M4-6） | ✅ 880ms（含 uv.lock + E5） |
| `sample/extract_refactor/` | 单文件选区式 code action 靶场（无第三方依赖，无需 venv） | **Extract 重构支持度**（refactor.extract code action，dx_features_backlog 第三梯队 PR-O 探针） | ✅ 已实测：pyrefly 1.3.1 原生支持；脚本 `extract-refactor-probe/probe.cjs` |

每个样例目录含独立 `pyproject.toml` + `.venv`（uv 管理，Python 3.13.7；`.venv` 已被根 `.gitignore` 忽略）。

## errors 验收步骤（S1-T05）

在 Pylume 中打开 `bench/sample/errors/` 为工作区，逐条运行（运行按钮或终端）：

```powershell
uv run main.py -- --case runtime    # ZeroDivisionError（line 23）
uv run main.py -- --case attribute  # AttributeError（line 29）
uv run main.py -- --case import     # ModuleNotFoundError（line 34）
uv run main.py -- --case assert     # AssertionError（line 40）
uv run main.py -- --case nested     # KeyError 多帧（line 46/50/54）
uv run syntax_error.py              # SyntaxError 单行格式（line 16）
```

> 注意 `--` 分隔符：uv run 需用它区分自身参数与脚本参数。

**验收标准**：输出面板中每个 `File "…", line N` 帧渲染为可点击链接，点击后打开文件并定位到出错行（含跨文件场景——traceback 中 venv 内文件路径也应可跳转）。

## 环境版本（锁定基线）

| 工具 | 版本 |
|---|---|
| Python（uv 管理） | 3.13.7（`D:\py3\3.13.7`） |
| uv | 0.10.11 |
| pyrefly | 1.3.0（`~/.local/bin`，实测 `pyrefly --version`） |
| basedpyright | 1.40.1（based on pyright 1.1.414；`~/.local/bin`，已入 PATH） |
| pydantic（`sample/pydantic_models/.venv`） | 2.13.5 |
| ruff | 0.16.1 |

## dep_scan 性能红线回放（M4-6，2026-09-16）

`cargo test --release bench_dep_scan -- --ignored --nocapture`（Windows / release）：

| 样例 | 文件数 | 全量耗时 | 备注 |
|---|---|---|---|
| errors | 个位数 | 823ms | 含 uv.lock（E5 `uv lock --check`）；**首轮回放 3243ms 为 uv 索引冷缓存联网开销，warm 后回落**——E5 联网特性见计划 §10 风险 1 |
| fastapi_annotated | 个位数 | 638ms | |
| large_repo | **88** | **880ms** | 4 层深目录 × 6 包 × 80 模块 + 惰性导入 + 相对导入全形态；**红线 ≤ 2s 达标** |
| unannotated_scraper | 个位数 | 667ms | |

增量路径（M4-2 scope 分流后）不在本表口径：.py 信号走 code 范围（跳过 L1/E5，AST mtime + resolution 缓存吸收），声明信号走 declaration（跳过探针）。

## 待补（S1-T07 后续）

- [x] 指标采集脚本（启动时间/内存）→ ✅ `collect-metrics.ps1`，报告落盘 `bench/reports/`
- [x] 运行时补全准确率评测 → ✅ `bench/reports/gate-d-runtime-completion.md`（P3-T10，23/23）
- [x] 大仓样例（50~100 脚本 + 深目录）→ ✅ `sample/large_repo/`（M4-6 红线验收）
- [ ] 静态引擎补全/跳转准确率评测用例（每项目 ≥50 评测点）
- [ ] 动态架构样例（Phase 2/3 前补齐）
