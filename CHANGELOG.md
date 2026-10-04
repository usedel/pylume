# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-10-04

首个公开发布版本。项目自 2026-08-20 起开发，此前为私有仓库，本版本以 **Pylume** 之名开源（MIT）。

### 新增

**外壳与编辑器**
- Tauri 2 + Monaco 外壳：多标签 / 分屏 / 面包屑 / 书签 / 引用计数 / 行内值
- 可配置智能 Live Templates（容器 × 位置 × 词法三维上下文）
- 视觉身份体系：单色相品牌轴、表面五档阶梯、随包等宽字体、Monaco 自定义主题、材质与动效分级（配套 98 项 token 门禁）
- 中英双语（zh-CN / en-US），设置内即时切换
- 多窗口

**语义与运行时智能**
- 补全 / 跳转 / Hover / 诊断，经自研 LSP 桥挂载 Pyrefly（默认）或 basedpyright，第一天即可切换
- PEP 669 `sys.monitoring` 运行时采样探针（实测开销 1.35x，红线 1.5x）
- `pylume-intel`：消费 trace 库的独立运行时 LSP，补全结果带 `⟳ runtime` 来源标注
- 补全四层合并（模板 / 运行时 / 静态 / 关键字，固定 sortText 段位）

**运行与调试**
- 脚本 / 项目两种运行模式 + 统一 PTY 控制台 + 多实例并行 + 运行历史
- traceback 点击跳转
- 调试最小闭环：断点 / 单步 / 调用栈 / 变量（debugpy 随包分发 + 自研 DAP 桥，stdio adapter 模式）

**工程能力**
- Git 集成（含远端克隆）
- SQLite 数据库工具（编辑器 Tab 化，默认只读）
- Markdown 预览 · 依赖健康扫描 · 库特别支持（re 三件套 / 格式串 / JSON / 求值桥 / 参数表单）
- Pydantic 构造校验与改名传播补充
- 全局搜索 · 终端 · 本地历史 · 开发工具插件切片

### 已知限制

- 仅支持 Windows
- 真机 e2e 未纳入 CI（nightly 只告警）
- 调试与运行功能各留少量人工验收项
- 工具插件为 v1 信任模型，沙箱未实现

详见 [`docs/delivery-overview.md`](docs/delivery-overview.md) 的交付总览表与 [`docs/tech-debt.md`](docs/tech-debt.md)。
