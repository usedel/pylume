// 工具链引导（Phase 4 第 4 步）：探测 uv / 静态引擎（pyrefly/basedpyright）缺失项。
// 仅做底层 invoke 封装；引导确认与输出渲染见 main.ts 的 maybePromptToolchain。

import { invoke } from "@tauri-apps/api/core";

export interface ToolchainEngineStatus {
  name: string;
  command: string;
  ok: boolean;
}

export interface ToolchainStatus {
  uv: boolean;
  engine: ToolchainEngineStatus;
  ruff: boolean;
  /** uv 与当前静态引擎均就绪（补全 + 运行的最低门槛） */
  allOk: boolean;
}

/** 探测工具链（uv / 当前静态引擎 / ruff）缺失状态 */
export async function detectToolchain(engine: string): Promise<ToolchainStatus> {
  return invoke<ToolchainStatus>("detect_toolchain", { engine });
}

/** 一键安装缺失工具（uv → 静态引擎），进度经 toolchain-stdout / toolchain-stderr 事件流式推送 */
export async function installToolchain(engine: string): Promise<boolean> {
  return invoke<boolean>("install_toolchain", { engine });
}