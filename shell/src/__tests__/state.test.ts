// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { DEFAULT_FONT_FAMILY, DEFAULT_SETTINGS, type Settings } from "../state";

// 前端单源漂移锁（P2-A）：
//   keyof Settings（接口定义）与 keyof typeof DEFAULT_SETTINGS（默认值字面量）必须完全一致。
//   任一侧多字段 / 漏字段，SettingsDrift 就会变成非 never 的字面量联合，
//   从而令下方 `const ok: ... = true` 在 tsc 阶段编译失败（`npm run build` / CI 兜底）。
//   该断言不依赖 DEFAULT_SETTINGS 上的 `: Settings` 标注——即使未来该标注被移除，
//   只要两侧字段集合不一致，这里仍会报错，是稳健的回归测试。
type SettingsDrift =
  | Exclude<keyof Settings, keyof typeof DEFAULT_SETTINGS>
  | Exclude<keyof typeof DEFAULT_SETTINGS, keyof Settings>;

describe("Settings 前端单源一致性（P2-A）", () => {
  it("接口与默认值的字段集合完全一致（编译期锁）", () => {
    const ok: SettingsDrift extends never ? true : never = true;
    expect(ok).toBe(true);
  });

  it("关键默认值与后端 Settings::default 对齐（新增字段时需同步两侧）", () => {
    expect(DEFAULT_SETTINGS.theme).toBe("pylume-dark");
    expect(DEFAULT_SETTINGS.font_size).toBe(14);
    expect(DEFAULT_SETTINGS.font_family).toBe(DEFAULT_FONT_FAMILY);
    // 批 3：连字出厂默认开（JetBrains Mono 的编程连字是核心卖点）
    expect(DEFAULT_SETTINGS.font_ligatures).toBe(true);
    expect(DEFAULT_SETTINGS.tab_size).toBe(4);
    expect(DEFAULT_SETTINGS.insert_spaces).toBe(true);
    expect(DEFAULT_SETTINGS.word_wrap).toBe("off");
    expect(DEFAULT_SETTINGS.minimap).toBe(false);
    expect(DEFAULT_SETTINGS.probe_enabled).toBe(true);
    expect(DEFAULT_SETTINGS.runtime_intel_enabled).toBe(true);
    expect(DEFAULT_SETTINGS.keyword_completion).toBe(true);
    expect(DEFAULT_SETTINGS.terminal_cwd).toBe("workspace");
    expect(DEFAULT_SETTINGS.pypi_index).toBe("https://pypi.org/simple");
    // 快捷键默认（PyCharm 风格；完整漂移锁见 keybindings.test.ts）
    expect(DEFAULT_SETTINGS.keybindings.save).toBe("Ctrl+S");
    expect(DEFAULT_SETTINGS.keybindings.duplicate_line).toBe("Ctrl+D");
    expect(DEFAULT_SETTINGS.keybindings.goto_definition).toBe("Ctrl+B");
  });
});