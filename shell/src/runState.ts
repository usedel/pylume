// 运行态单一真值（TD-14 ①；v3.4 §17-4：多实例运行列表）。
// 运行态 = **运行实例列表**（脚本唯一 + 项目 N 个并行，§12）：
// - 每个实例对应一个统一运行控制台 tab（id 与后端会话 id 一致：`run-term-script` /
//   `run-term-project-<N>`），实例与 tab 同生共死（§7.1 不变式）；
// - `isRunning()` = 任一实例在跑（preparing/running）；⏹ 与 tab 停止按钮按实例 id 路由；
// - exited 是唯一「已结束驻留态」（附退出原因），tab 保留供回看；关闭 tab 后移除实例。
// 本模块零依赖（纯状态 + 纯函数）；运行流程（runFlow.ts）经访问器读写。
// CR-07 的准备期闸门 runPreparing 不并入——它是「进入运行态之前」的并发防线，
// 生命周期与实例列表正交，归 runFlow 私有。

// ---------- 运行配置类型（与后端 RunProfile serde 对齐；v3.4 §4.2 字段表） ----------

/** 环境变量（运行配置 env 列表元素） */
export interface EnvVar { key: string; value: string }

/** 运行入口（P0-C）：脚本路径 / 模块名（= python -m）二选一，对齐 PyCharm */
export interface RunEntry { kind: "script" | "module"; target: string }

/** 运行配置（v3.4 §4.2：脚本配置与项目配置共用；被裁的 v2 高级项已删） */
export interface RunConfig {
  entry: RunEntry;
  args: string;
  /** P0-D：支持 ${workspaceRoot} / $PROJECT_DIR$ 宏；空 = 默认（script→脚本目录，module→工作区根） */
  cwd: string;
  env: EnvVar[];
  /** P1-G：.env 文件（有序，相对工作区根）；注入位置 = 默认注入之后、用户显式 env 之前 */
  env_files: string[];
  /** P1-I：配置级解释器覆盖；空 = 沿用工作区解释器 */
  interpreter: string;
}

/** 缺省运行配置（与后端 RunProfile::default 一致） */
export const EMPTY_RUN_CONFIG: RunConfig = {
  entry: { kind: "script", target: "" },
  args: "",
  cwd: "",
  env: [],
  env_files: [],
  interpreter: "",
};

/** 归一化后端返回的运行配置（防御缺字段；与 RunProfile serde default 同口径；
 * v2 遗留字段（name/stdin/allow_multiple 等）即使出现在 raw 里也被静默丢弃，§4.3） */
export function normalizeRunConfig(raw: Partial<RunConfig> | undefined | null): RunConfig {
  return {
    entry: { kind: raw?.entry?.kind === "module" ? "module" : "script", target: raw?.entry?.target ?? "" },
    args: raw?.args ?? "",
    cwd: raw?.cwd ?? "",
    env: raw?.env ?? [],
    env_files: raw?.env_files ?? [],
    interpreter: raw?.interpreter ?? "",
  };
}

// ---------- 选区运行（临时文件映射，traceback 跳转用） ----------

/** 选区运行的元信息：临时文件路径 → 源文件 + 起始行（traceback 跳转映射用） */
export interface SelectionRunMeta {
  tempPath: string;
  sourcePath: string;
  startLine: number;
}

// ---------- 运行实例（§17-4 多实例模型） ----------

export type RunKind = "script" | "project";

/** 实例阶段（§7.2 状态机）：preparing → running → exited；preparing 的所有出口
 *  必须落到 running 或整实例移除，绝不驻留 preparing（§7.5 硬规则 2）。 */
export type RunPhase = "preparing" | "running" | "exited";

/** 退出原因（exited 附带）：code = 进程退出码；stopped = 用户停止；canceled = preparing 期关闭 tab */
export type ExitReason = { kind: "code"; code: number } | { kind: "stopped" } | { kind: "canceled" };

/** 一个运行实例 = 一个控制台 tab 上的进程会话（§7.1：实例与 tab 同生共死） */
export interface RunInstance {
  /** 实例 id = 后端终端会话 id：`run-term-script` / `run-term-project-<N>`（§17-12 约定） */
  id: string;
  kind: RunKind;
  /** tab 标签（「运行 · main.py」/「项目」/「项目 2」，历史归属记录用） */
  label: string;
  phase: RunPhase;
  startedAt: number;
  /** 脚本运行的目标文件（选区运行 = 临时文件）；项目运行 = null */
  path: string | null;
  /** 选区运行临时文件映射（traceback 跳转映射用；退出 / 停止 / 失败统一清理） */
  selection: SelectionRunMeta | null;
  /** exited 附带的退出原因 */
  exit: ExitReason | null;
  /** preparing 期被取消（关闭 tab）：invoke 返回后按 id 幂等补杀（§7.4） */
  canceled: boolean;
  /** stopping（M4 实测修复）：用户已发起停止（\x03 已写入）。ConPTY 把 \x03 转成
   *  CTRL_C_EVENT 后 Python 立即以 0xC000013A 退出，term-exit(code) 常常先于
   *  stopRunById 的宽限等待到达——若不区分，自然退出收口会把「用户停止」误记为
   *  exitKind=code。onExit 收口时 stopping=true ⇒ 按 stopped 落档（§7.2）。 */
  stopping: boolean;
}

// ---------- RunState（实例列表） ----------

let instances: RunInstance[] = [];

/** 当前全部运行实例（快照；⏹ 停止路由 / 状态展示用） */
export function listRunInstances(): RunInstance[] {
  return [...instances];
}

/** 按实例 id 查找 */
export function findRunInstance(id: string): RunInstance | null {
  return instances.find((x) => x.id === id) ?? null;
}

/** 登记一个新实例（preparing 起步） */
export function addRunInstance(inst: RunInstance): void {
  instances.push(inst);
}

/** 移除实例（关闭 tab / 工作区清理；幂等） */
export function removeRunInstance(id: string): void {
  instances = instances.filter((x) => x.id !== id);
}

/** 清空全部实例（工作区切换 / 关闭，§15） */
export function clearRunInstances(): void {
  instances = [];
}

/** 是否有运行进行中（任一实例 preparing/running；不含 exited，§7.3） */
export function isRunning(): boolean {
  return instances.some((x) => x.phase !== "exited");
}

/** 是否有**脚本**运行实例在跑（调试互斥判定，§13.2：互斥收窄至脚本运行） */
export function scriptRunActive(): boolean {
  return instances.some((x) => x.kind === "script" && x.phase !== "exited");
}

/** 是否有**项目**运行实例在跑（「运行项目」二选一对话框触发判定，§6.4） */
export function projectRunActive(): boolean {
  return instances.some((x) => x.kind === "project" && x.phase !== "exited");
}

/** 最近启动且**正在运行**（phase=running）的实例（⏹ 停止路由：只停一个，§10）。
 *  只算 running 不算 preparing——§7.3 矩阵规定 preparing 态 ⏹ 置灰（此时进程未落地，
 *  停止无处着力；preparing 期的取消走关闭 tab 的 canceled 路径，§7.4）。 */
export function latestActiveInstance(): RunInstance | null {
  return [...instances].filter((x) => x.phase === "running").sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
}

/** 正在运行的脚本文件路径集合（编辑器 tab 运行图标判定用；
 *  多实例下脚本仅一个，但保留集合口径容错） */
export function runningPathsOf(): Set<string> {
  return new Set(
    instances.filter((x) => x.kind === "script" && x.phase !== "exited" && x.path).map((x) => x.path as string),
  );
}

/** 选区运行元信息（traceback 跳转映射；非选区运行时 null）。选区运行走脚本实例
 *  （临时文件路径键），查找当前活跃脚本实例的 selection 字段。 */
export function selectionMetaOf(tempPath: string): SelectionRunMeta | null {
  for (const x of instances) {
    if (x.selection && x.selection.tempPath === tempPath) return x.selection;
  }
  return null;
}

/** 选区运行元信息（兼容单实例查询：任意活跃选区实例） */
export function anySelectionMeta(): SelectionRunMeta | null {
  return instances.find((x) => x.selection && x.phase !== "exited")?.selection ?? null;
}

/** 工作区切换 / 单测复位：全部清空 */
export function resetRunStateAll(): void {
  instances = [];
}
