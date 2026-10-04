// P6 探针 runner：打开 /e2e/_probe/monaco-perf.html，取回测量结果落 bench/reports/
// 用法：npx playwright test e2e/_probe/p6-monaco-perf.spec.ts
// 说明：本文件只做「取数」，不做断言（阈值结论写入 docs 后再决定）

import { test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

test("P6 面板内只读 Monaco 成本", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  await page.goto("/e2e/_probe/monaco-perf.html");
  await page.waitForFunction(() => document.body.dataset.done === "1", undefined, { timeout: 90_000 });
  const result = await page.evaluate(() => (window as unknown as { __PROBE_RESULT__: unknown }).__PROBE_RESULT__);
  const report = { generatedAt: new Date().toISOString(), pageErrors: errors, ...(result as object) };

  // 注意：本项目 package.json 为 ESM（"type": "module"），无 __dirname；cwd = shell/
  const out = path.resolve(process.cwd(), "..", "bench", "reports", "lib-support-probe-p6.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2), "utf8");

  console.log(JSON.stringify(report, null, 2));
});
