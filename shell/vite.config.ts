import { realpathSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vite";

/**
 * 构建 root 的盘符大小写必须规范化（Windows 专项）。
 *
 * 现象：从 `d:\code\open-charm\shell`（小写盘符）下执行 `npm run build`，构建在
 * `[vite:html-inline-proxy]` 处失败——`No matching HTML proxy module found`。
 *
 * 根因：`process.cwd()` 会**原样保留调用方输入的盘符大小写**（`d:` vs `D:`），
 * 而 Rollup/Vite 解析出来的模块 id 用的是盘符规范形式（`D:`）。`html-inline-proxy`
 * 的 `load` 钩子用 `id.replace(config.root, "")` 计算缓存键，root 与 id 大小写不一致时
 * 替换不生效、键变成完整路径 → 查不到 transform 阶段写入的代理模块 → 抛错。
 * 本项目 `index.html` 有内联 `<style>`（首屏 FOUC 兜底），因此**必然触发**。
 *
 * 处理：显式把 root 设为 realpath 的规范形式（`realpathSync.native` 返回磁盘上的真实
 * 大小写），从根上消除"取决于从哪个盘符写法进入目录"的不确定性。
 */
const root = realpathSync.native(process.cwd());

export default defineConfig({
  root,
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    // P0 DX：pluginsTab 经 ?raw 引用仓库 docs/ 的作者指南（内置分发）——
    // dev server 默认 fs.allow 只有 root，放开到仓库根（= root 的上一级）
    fs: { allow: [root, realpathSync.native(join(root, ".."))] },
    watch: {
      // Rust 编译产物目录，前端无需监听；且 Windows 下 cargo 写入 dll 时
      // 会被 fs.watch 占用导致 EBUSY 崩溃（beforeDevCommand 退出）。
      ignored: ["**/src-tauri/target/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "chrome105",
    minify: "esbuild",
    sourcemap: false,
  },
  // E2E 用例（e2e/）只归 Playwright 管：vitest 默认会扫 *.spec.ts，
  // 不排除会出现「vitest 误跑 Playwright 用例 → import @playwright/test 报错」。
  test: {
    exclude: ["**/node_modules/**", "**/e2e/**"],
  },
});
