# F0：静态引擎对 Pydantic 的支持度实测

> 日期：2026-09-26 · 性质：实测记录（对应 PyCharm 框架支持调研报告 §8.3 **F0**，该报告已归档）
> 结论用途：决定「FastAPI 第一档」的地基——是否需要切换默认静态引擎；**是否落地仍以开发计划与产品负责人裁决为准**
> 原始数据：`bench/reports/pydantic-probe-pyrefly.json`、`bench/reports/pydantic-probe-basedpyright.json`
> 探针脚本：`bench/pydantic-probe/probe.cjs` · 受控用例：`bench/sample/pydantic_models/`

---

## 0. 一页结论

1. **pyrefly 1.3.0 对 Pydantic 只覆盖“一半”**：字段**补全**与 **hover** 有，**传值类型检查 / 缺失必填报错 / 字段改名传播**三项**全无**。
2. **根因不是“不认 Pydantic”，而是 pyrefly 当前不对 `__init__` 做构造参数校验**：对照组（标准库 `@dataclass`）同样零诊断、字段引用同样为 0——Pydantic 与 dataclass 被一视同仁地少了一半能力。
3. **basedpyright 1.40.1 覆盖 4/6 项**（补全 / 类型检查 / 缺失必填 / 改名传播），仅 **alias（`Field(alias=...)` + `ConfigDict`）场景有双向误报**。
4. **对 FastAPI 的影响是实打实的**：FastAPI 的核心价值之一（请求体/必填校验）恰好落在 pyrefly 缺失的那一半——用户会得到「补全有、红线没有」的体验。
5. **建议（推荐 B + C）**：
   - **A（保守）**：维持 pyrefly 默认，文档明示「Pydantic 校验以运行时为准」——零成本，但第一档体验有缺口；
   - **B（推荐）**：**工作区依赖声明含 `pydantic` / `fastapi` 时，推荐（或默认）切到 basedpyright**——引擎切换能力架构首日即有（`engineChip.ts` / `lsp/client.ts::ENGINES`），成本只在「检测 + 提示」；代价是 basedpyright 更严格（alias 误报、噪声更多）；
   - **C（跟踪）**：跟踪 pyrefly 对 dataclass_transform / 构造参数校验的进展，达标后回切——零成本但不可控。

---

## 1. 方法与口径

- **探针**：Node LSP 裸会话（`bench/pydantic-probe/probe.cjs`），与产品同口径启动，避免"探针与产品不一致"的假结论：
  - 命令：`pyrefly lsp` / `basedpyright-langserver --stdio`（同 `shell/src/lsp/client.ts::ENGINES`）；
  - 解释器：pyrefly 走 `initializationOptions.pythonPath`，basedpyright 走 `workspace/configuration(section=python).pythonPath`——**必须响应配置请求**，否则 basedpyright 挂起（P1-BUG-001 根因）；
  - 进程 cwd = 受控项目根（pyrefly 从 cwd 发现 `pyproject.toml` 才建工作区索引，既有踩坑）；
  - **rename 前轮询 references 至稳定**（pyrefly 是 lazy-non-blocking-background 索引，不等会漏改；产品 `waitReferencesStable` 同款）。
- **受控用例**（`bench/sample/pydantic_models/`，独立 `.venv` + pydantic 2.13.5）：

| 文件 | 考察点 |
|---|---|
| `models.py` | `BaseModel` 定义 + 子类继承（`Admin(User)`），rename 目标字段 `name` |
| `usage.py` | 正确实例化 / **类型不匹配** `User(id="not-an-int")` / **缺失必填** `User(id=1)` / 子类两种错 |
| `complete.py` | `User(id=1, na\|)` 处请求补全（期望候选含字段） |
| `alias.py` | `Field(alias=...)` + `ConfigDict(populate_by_name=True)`，两个方向各调一次（考察误报） |
| `validators.py` | `@field_validator` / `@model_validator(mode="after")`（考察误报） |
| `plain.py` | **标准库 `@dataclass` 对照组**：区分「不认 Pydantic」与「整体不做构造校验」两种根因 |

- **环境版本**：pyrefly **1.3.0**、basedpyright **1.40.1**（based on pyright 1.1.414）、Python 3.13.14、pydantic **2.13.5**（venv 内）。

---

## 2. 结果对照

| # | 能力（对标 PyCharm §5.1） | pyrefly 1.3.0 | basedpyright 1.40.1 | PyCharm 基准 |
|---|---|---|---|---|
| 1 | **字段补全**（构造 kwargs） | ✅ 3 个候选，正好是 `id=` / `is_active=` / `name=` | ✅ 候选 127 个（模糊匹配噪声大），但 `name=` 排首位（`sortText 06.9999.name`） | ✅ |
| 2 | **传值类型检查** | ❌ `usage.py` **零诊断** | ✅ `reportArgumentType`：`Literal['not-an-int']` 无法赋给 `int` | ✅ |
| 3 | **缺失必填** | ❌ `User(id=1)` **零诊断** | ✅ `reportCallIssue`：`参数 "name" 缺少传入值`（usage.py 2 处） | ✅ |
| 4 | **字段改名传播**（声明 ↔ 调用处） | ❌ references=**0**，rename 只改 `models.py` 声明处 | ✅ references=3，rename 覆盖 `models.py` + `usage.py` 3 处调用 | ✅（还跨子类/基类） |
| 5 | **alias / ConfigDict 不误报** | ⚠️ 静默（既不校验也不误报） | ⚠️ **双向误报**：传 `my_alias` 报"缺少传入值"、传 `my_field` 报"参数不存在" | ✅ 两者都接受 |
| 6 | **validator 识别**（不误报） | ✅ 零诊断 | ✅ 零诊断 | ✅ |
| 7 | **hover 字段类型** | ✅ `(variable) name: str` | ✅ 同 | ✅ |
| — | 对照组：标准库 `@dataclass` 的 2/3 项 | ❌ **零诊断** | ✅ 两项都报 | —— |

**关键判定**：pyrefly 对标准库 `@dataclass` 同样不报类型/必填错 ⇒ 缺失的不是「Pydantic 适配」，而是 **`__init__` 构造参数校验 + 字段↔调用处的引用关系**这一整块能力（即 PEP 681 `dataclass_transform` 语义链的产物）。

---

## 3. 对 FastAPI 第一档的影响

| FastAPI 场景 | 依赖的能力 | pyrefly 现状 |
|---|---|---|
| `Item(name=..., price=...)` 请求体构造 | 1 补全 + 7 hover | ✅ 可用 |
| 请求体字段类型写错（str 当 int） | 2 类型检查 | ❌ 无红线，只有运行时 422 |
| **漏传必填字段** | 3 缺失必填 | ❌ 无红线，只有运行时 422 |
| 模型字段改名后同步所有调用 | 4 改名传播 | ❌ 只改声明处，**静默漏改**（比报错更危险） |

第 4 项尤其需要注意：**不是"少一个提示"，而是"重命名会静默漏改"**——与 PyCharm「改名同步 `__init__` 调用处并传播到子类/基类」正好相反。若维持 pyrefly 默认，建议在重命名 Pydantic 字段时给出提示，或至少在文档中标注该边界。

---

## 4. 三个方案与取舍

| 方案 | 内容 | 成本 | 风险 / 代价 |
|---|---|---|---|
| **A 保守** | 维持 pyrefly 默认；文档标注「Pydantic 校验以运行时为准」 | 零 | FastAPI 第一档体验缺一半（尤其"漏改"是静默的） |
| **B 推荐** | 依赖声明含 `pydantic` / `fastapi` 的工作区 → 推荐或默认切 basedpyright | 低：检测可复用 `deps_mention`（`env_cmds.rs` 已有）+ 引擎切换入口已存在（`engineChip.ts`） | basedpyright 更严格：alias 双向误报、补全候选噪声大（127 条，需前端 filter/sort 兜底）；切换需用户可感知、可回退 |
| **C 跟踪** | 跟踪 pyrefly 对 `dataclass_transform` / 构造参数校验的进展，达标后回切 | 零 | 进度不可控 |

**推荐 B + C**：先用 B 把第一档体验补齐（这是我们压 FastAPI 的初衷），同时留 C 作为回切通道；A 作为"用户坚持 pyrefly"时的兜底说明。

---

## 4.1 落地状态（2026-09-26，裁决 B 已实施）

- **Rust**：新增 `detect_pydantic_stack`（`env_cmds.rs`：复用 `collect_dep_text` / `deps_mention`，依赖含 pydantic/fastapi 且未关闭 → true；3 条单测）。关闭开关**复用** `set_framework_hint_disabled`（键 `pydantic_engine`，与框架提示共用 workspace config 的 `framework_hints`，语义 = 框架相关提示的工作区级开关）。
- **前端**：新增 `pydanticEngineHint.ts`——输出面板持久 hint 行（「切换到 basedpyright」/「保持 pyrefly（不再提示）」两个链接），每工作区每会话最多一次，且仅当前引擎为 pyrefly 时提示；切换走 `engineChip::switchEngineTo`（与 chip 菜单同一套同值跳过 / 持久化 / 重启语义，无第二份真值）。
- **补全噪声已核验，无需新代码**：`lsp/client.ts` 给静态引擎段统一 `2xxx` sortText（**保留引擎返回顺序**——`name=` 在 basedpyright 原始返回中排首位），Monaco 再按 `filterText` 前缀过滤；127 条原始列表在弹窗内会被大幅收窄（待真实 IDE 实测复核）。
- **alias 误报实测不可单独规避（连坐实验）**：给受控项目加 `[tool.basedpyright] reportCallIssue = "none"` 后重跑——alias 双向误报消失，但「缺失必填」（同属 reportCallIssue）被**连坐关闭**，只剩 reportArgumentType。结论：**不推荐配置规避**，接受为已知边界（alias 场景在 FastAPI 项目占比低；重度 alias 用户可自行权衡该开关的代价）。
- C（跟踪 pyrefly 的 `__init__` 校验 / `dataclass_transform` 进展）仍开放，达标后可回切默认。

### 4.2 基线刷新（2026-09-28，pyrefly 1.3.1）

撤销推荐（计划阶段 1）实施当日重跑探针，**pyrefly 1.3.1 与 1.3.0 结论完全一致**：

| 项 | pyrefly 1.3.1 | 对照 1.3.0 |
|---|---|---|
| `usage.py` 诊断（类型错 / 缺必填） | 零诊断 ❌ | 同 ❌ |
| rename 字段传播 | references=0，只改 `models.py` 声明处 ❌ | 同 ❌ |
| 补全（`id=` / `is_active=` / `name=`） | ✅ 3 候选 | 同 ✅ |
| hover | ✅ | 同 ✅ |
| alias / validators 误报 | 零 ❌（静默但无误报） | 同 |

basedpyright 侧（`rename references=3`，覆盖 `usage.py` 3 处调用）结论不变。原始数据：`bench/reports/pydantic-probe-{pyrefly,basedpyright}.json`（`generatedAt: 2026-09-28`）。

> 升级跟踪基线以此为准：pyrefly 后续版本任一缺失项转绿即按计划阶段 3 回补并退役对应自研/提示。

---

## 5. 复现

```powershell
cd /d d:\aipro\pylume
node bench\pydantic-probe\probe.cjs pyrefly        # → bench/reports/pydantic-probe-pyrefly.json
node bench\pydantic-probe\probe.cjs basedpyright   # → bench/reports/pydantic-probe-basedpyright.json
```

受控环境首次准备（`.venv` 已被根 `.gitignore` 忽略）：

```powershell
cd bench\sample\pydantic_models
uv venv --python D:\py\python.exe
uv pip install --python .venv\Scripts\python.exe pydantic
```
