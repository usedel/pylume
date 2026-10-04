# pylume-intel

Pylume 运行时智能 LSP（Phase 3）。独立 Rust 包/进程，经 stdio 挂着到 shell 的 LSP 桥，消费 pylume-probe 写入的 SQLite trace 库，提供运行时驱动的代码补全 / 跳转 / hover。

**独立包，不依赖外壳内部 API（架构第一原则）。**

## 定位

| 层 | sortText | 来源标注 | 状态 |
|---|---|---|---|
| 智能 live template | `0xx` | `⟳ ctx=…` | Phase 1 已交付（shell） |
| **运行时智能（intel）** | **`1xx`** | **`⟳ runtime`** | **Phase 3 本包** |
| 静态引擎（pyrefly） | `2xx` | — | Phase 1 已交付 |

## 数据契约

读取 `~/.pylume/traces/<project-hash>.db`（probe 的 trace 库，schema 见 `probe/src/pylume_probe/store.py`）：

- `functions(filename, qualname, lineno, hits, stale)` —— 函数自然键 + 命中数 + 陈旧标记；
- `arg_types(fid, arg, type_label, shape, count)` / `ret_types` / `exc_types` —— 类型观测跨运行累加；
- 类型紧凑表示：实例 → `模块.类名`；容器 → `dict[str, int]` / `list[int|str]`；`shape` 为 `shape_fingerprint` JSON 数组（dict 键 / 实例属性名集合）。

## 构建

```powershell
cd intel
cargo build            # debug
cargo build --release  # P3-T02 性能验收用
```

> ⚠️ 联调 shell 前必须 `cargo build -p pylume-intel`（**非 `cargo test`**）——`cargo test` 只构建测试 harness，不刷新 shell 调用的 `pylume-intel.exe`（曾因此踩坑：shell 加载到 P3-T01 骨架版，补全返回 `method_not_found`）。

## 阶段任务

| 编号 | 任务 | 状态 |
|---|---|---|
| P3-T01 | 骨架（cargo workspace + tower-lsp stdio） | 已完成 |
| P3-T02 | trace 索引层（读 SQLite，10 万条 < 2s） | 已完成（2026-09-10 整改后实测 **429.9ms**，bench_load PASS） |
| P3-T03 | 补全 provider（符号补全） | 已完成（见下） |
| P3-T03b | 属性访问补全（局部类型推断） | 已完成（见下） |
| P3-T04 | 跳转 provider | 已完成（见下） |
| P3-T05 | hover provider | 已完成（见下） |
| P3-T06' | 挂载 shell LSP 桥（`⟳ runtime`，sortText `1xx`） | 已完成（端到端验证通过） |
| P3-T07 | inlay hints（运行时类型标注，`⟳ type`） | 已完成（`inlay.rs` + shell `registerLspInlayHints`） |
| P3-T08 | 类型推断补强（for 循环变量）+ stale 新鲜度降权 | 已完成（`type_infer` + 全链路降权） |
| P3-T09 | 运行时层一键关闭全局开关 | 已完成（设置 `runtime_intel_enabled` + `stopIntel`） |
| P3-T10 | bench 补全准确率评测 + Gate D 验收 | 确定性评测 23/23 通过（红线 ≥85%）；**人工对标工作单已自动生成**（`bench/reports/gate-d-ab-worklist.md`，Pylume 侧 23 点排名已由测试填好）；⏳ 只差真人在 PyCharm 里勾 23 点 + 真实项目端到端采数 |

### P3-T10 现状（2026-10-03 更新）

**两格 PENDING 的工具侧已全部就绪，缺的只是人的动作与真实数据：**

| 项 | 状态 |
|---|---|
| 确定性口径 base 数值 | ✅ 23/23 = 100%（`bench/reports/gate-d-runtime-completion.md`），红线 ≥85% PASS |
| 评测覆盖的已知空洞 | ⚠️ `completion.rs::bench_seed()` 的 6 个函数**全部 `stale=0`** → 23 个评测点对**降权策略零覆盖**；100% 既不能证明也不能反驳降权合理性。已补单测 `stale_candidates_rank_below_fresh_ones` 钉住降权行为（33/33 通过） |
| 降权参数的依据 | 🔄 此前是裸字面量 `f.hits / 2`。现已提成具名常量 `STALE_HITS_DIVISOR`（值不变）+ 注释记录首个实测：改 1/2 源文件后只跑另一半，**stale 占比 30.0%**（3/10）——即常见编辑流下约 1/3 观测立刻变 stale。取值待真实项目 ≥1000 条观测后用 `tools/intel/trace_stats.py` 复核 |
| 人工横向对标 | ⏳ **待人工**：设 `OC_GATE_D_WORKLIST=<路径>` 后跑 `cargo test -p pylume-intel -- --nocapture runtime_completion_accuracy` 导出工作单，在 PyCharm 同一样例上勾 23 点 → `gate-d-ab.md` |
| 真实项目端到端 | ⏳ **待数据**：本机此前无任何 `traces/*.db`。用 IDE 同款注入 env（`run_env.rs:274-289` 四件套）跑真实代码产出库后，`python tools/intel/trace_stats.py` 出统计与建议 |
| trace 库保留窗口 | ⏳ 现行无条数/体积上限；`probe clean --days N` **只删 runs 行、不删观测数据**（易被误读为保留窗口）。`trace_stats.py` 建议按 8 MB 预算设条数上限并已在报告中给出反推口径 |

## 索引与并发模型（2026-09-10 整改后）

- **倒排索引**（`pylume-intel-index/src/trace.rs`）：加载期预建 `by_qualname` / `by_location` / `by_file` / `by_last_segment`（qualname 最后段）/ `by_second_last_segment` / `by_type_label`（类型 → 观测定位）；消费端 7 处全量线性扫描全部改为索引查询，shape 解析带请求级缓存。
- **只读打开**：`TraceIndex::open` 用 `SQLITE_OPEN_READ_ONLY` + 路径不存在直接报错（不创建垃圾 .db）+ `busy_timeout(2s)`。
- **server.rs 并发**：`parking_lot::RwLock`（无中毒）+ `Option<Arc<TraceIndex>>` 快照（读锁内只 clone，重计算锁外）+ 补全/hover/definition/inlay/诊断全部 `spawn_blocking`；didChange 带 **version 校验**（旧版本后到不覆盖新文本）；索引加载失败**指数退避**（连续失败后按 2 的幂间隔重试，不再每键重试刷 stderr）。

### P3-T03 运行时补全（已交付部分）

**符号补全**（`completion.rs::complete_symbols`）：基于 `qualname` 命名空间链匹配，覆盖三类：

| 输入 | 语义 | 示例 |
|---|---|---|
| `scraper.par` | 模块/类成员前缀补全 | `scraper.parse_page` |
| `scraper.`（尾点） | 命名空间成员全量补全 | `scraper.*` |
| `parse_p`（无点） | 运行过的函数名补全（跨文件） | 所有最后段以 `parse_p` 开头者 |

- 候选 `label` = 成员名，`detail` = `⟳ runtime · <qualname> · <hits> hits · ret→<类型>`，`sortText` = `1xx`（hits 降序）；
- 索引懒加载自 `initializationOptions.traceDbPath`；文档经 didOpen/didChange/didClose 全量同步。

**属性补全**（`completion.rs::complete` + `type_infer.rs`，P3-T03b）：`x.` / `x.field` 时经轻量类型推断定位 `x` 的运行时类型，聚合该类型的 `shape` 字段（dict 键 / 实例属性名）为候选（`kind=Field`）。

| 推断规则 | 示例 |
|---|---|
| 赋值 = 函数调用 → 返回类型 | `data = parse_page()` → `dict[str, int]` |
| 赋值 = 字面量 | `x = []` → `list`；`x = "s"` → `str` |
| 函数参数观测 | `def parse_page(resp):` → `resp` 的 arg 观测 |

已知边界（MVP，逐行回溯 + 前缀匹配，无完整解析器）：链式 receiver（`a.b.c` 的字段级类型传播——受 shape 无「字段→类型」映射限制）、条件分支内的类型收窄不追踪。**循环变量（`for x in …`）已在 P3-T08 支持**（容器元素类型推断）。

**Hover**（`hover.rs`，P3-T05）：悬停展示运行时观测（markdown）：

- 悬停函数名 → `⟳ runtime · <qualname> · <hits> hits` + 参数/返回/异常观测（按 count 降序）；
- 悬停对象变量 → `⟳ runtime · <name> : <类型>` + shape 字段列表；
- 复用 `type_infer` 的 receiver 定位与成员聚合，与补全共用一套推断语义。

**跳转**（`definition.rs`，P3-T04）：光标落函数名时，按 qualname 最后段匹配 trace 函数，返回其 `(filename, lineno)`（probe 记下的 def 行）；同名函数返回多个、按 hits 降序（最常运行的实现排前）；server 层经 `Url::from_file_path` 转 file URI。

### P3-T06' 挂载 shell 桥（已交付）

- `shell/src-tauri/src/lsp.rs`：多引擎（`engine` 键区分 `static`/`intel`，事件 payload 带 engine）；新增 `get_intel_info`（定位 exe + 算 trace 库路径）；
- `shell/src/lsp/client.ts`：双引擎会话 + 补全三层合并（intel `1xx` / 静态 `2xx`，模板 `0xx` 在 main.ts）、hover/definition 合并、文档同步广播；intel 启动失败**静默降级**（静态引擎照常）；
- 关键坑：`project_hash` 用 Rust `fs::canonicalize`，Windows 上返回 `\\?\` verbatim 前缀，与 probe `os.path.realpath`（无前缀）不一致 → trace 库 hash 错位；已用 `strip_verbatim_prefix` 对齐（见 `shell/src-tauri/src/file_ops.rs`，含对齐测试）。补：Windows 路径大小写不敏感，两端已加大小写归一（Rust `to_lowercase` / probe `os.path.normcase`），否则同目录大小写不同会产两个 trace 库（tech-debt #4）。

## 已知约定（来自 probe）

- 类方法/闭包 qualname 带 `<locals>` 段，消费时需处理；
- `stale=1` 表示函数所在文件在末次运行后被修改，消费时可降权或忽略；
- `shape` 列存空串而非 NULL（SQLite 唯一约束对 NULL 不生效）。