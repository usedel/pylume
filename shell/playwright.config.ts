import { defineConfig } from "@playwright/test";

/**
 * E2E 验收配置（git 改进报告 §11.2）。
 *
 * 架构：浏览器模式驱动 vite dev（5173），Tauri invoke 由 e2e/mocks/tauri.ts 注入的
 * window.__TAURI_INTERNALS__ mock 承载——git_* 命令映射到 Playwright 侧管理的真实
 * 临时 git 仓库（保留真实 git 行为，不依赖 Tauri 运行时）。用例只写「用户旅程」，
 * 不与 vitest 单测（src/__tests__/）重复。
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // 用例共享同一 dev server + mock 仓库句柄，串行最稳
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  // 产物落系统临时目录：Playwright 每轮清空 outputDir，任何工作区内路径都会触发
  // safe-delete 批量删除确认门槛（>500 文件）卡死测试进程（node_modules 内也一样）
  outputDir: `${process.env.TEMP ?? process.env.TMP ?? "/tmp"}/pylume-pw-results`,
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure", // 失败留现场（trace + 截图）
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: true, // 本地起过 dev 就复用，避免端口冲突
    timeout: 60_000,
  },
});
