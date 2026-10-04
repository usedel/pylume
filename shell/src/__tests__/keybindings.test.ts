// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  KEYBINDING_META,
  bindingChord,
  chordFromEvent,
  codeToKeyToken,
  modsFromEvent,
  normalizeBinding,
  parseBinding,
  parseKeyToken,
  validateKeybindingMap,
} from "../keybindings";
import { KEYBINDING_GROUP, KEYBINDING_GROUP_ORDER, keybindingsOfGroup } from "../keybindingDefaults";
import { DEFAULT_SETTINGS } from "../state";

describe("parseBinding 键位串解析", () => {
  it("字母键 + 修饰键", () => {
    expect(parseBinding("Ctrl+D")).toEqual({ ctrl: true, shift: false, alt: false, key: "KeyD" });
    expect(parseBinding("ctrl+shift+f")).toEqual({ ctrl: true, shift: true, alt: false, key: "KeyF" });
    expect(parseBinding("Ctrl+Alt+T")).toEqual({ ctrl: true, shift: false, alt: true, key: "KeyT" });
  });

  it("符号键（Shift 不改变 code，匹配依赖 e.code）", () => {
    expect(parseBinding("Ctrl+/")).toEqual({ ctrl: true, shift: false, alt: false, key: "Slash" });
    expect(parseBinding("Ctrl+Shift+/")).toEqual({ ctrl: true, shift: true, alt: false, key: "Slash" });
  });

  it("功能键与无修饰键", () => {
    expect(parseBinding("F10")).toEqual({ ctrl: false, shift: false, alt: false, key: "F10" });
    expect(parseBinding("Ctrl+F10")).toEqual({ ctrl: true, shift: false, alt: false, key: "F10" });
    expect(parseBinding("Shift+F12")).toEqual({ ctrl: false, shift: true, alt: false, key: "F12" });
  });

  it("命名键大小写不敏感", () => {
    expect(parseBinding("ctrl+enter")?.key).toBe("Enter");
    expect(parseBinding("Alt+PageUp")?.key).toBe("PageUp");
  });

  it("非法输入返回 null", () => {
    expect(parseBinding("")).toBeNull();
    expect(parseBinding("Ctrl+")).toBeNull();
    expect(parseBinding("Foo")).toBeNull();
    expect(parseBinding("Ctrl+X+Y")).toBeNull(); // 修饰键位出现非修饰词
    expect(parseBinding("Win+D")).toBeNull(); // 不支持的修饰键
    expect(parseBinding("F25")).toBeNull();
  });
});

describe("按键录入（设置面板：按组合键直接写入，而非手输字面量）", () => {
  const ev = (code: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}): KeyboardEvent =>
    ({
      code,
      ctrlKey: !!mods.ctrl,
      shiftKey: !!mods.shift,
      altKey: !!mods.alt,
      metaKey: !!mods.meta,
    }) as KeyboardEvent;

  it("code → 键 token（parseKeyToken 的反向）", () => {
    expect(codeToKeyToken("KeyS")).toBe("S");
    expect(codeToKeyToken("Digit0")).toBe("0");
    expect(codeToKeyToken("Slash")).toBe("/");
    expect(codeToKeyToken("F10")).toBe("F10");
    expect(codeToKeyToken("ArrowLeft")).toBe("ArrowLeft");
    expect(codeToKeyToken("Numpad0")).toBeNull(); // 键位串无法表达
    expect(codeToKeyToken("ControlLeft")).toBeNull(); // 纯修饰键不成键
  });

  it("事件 → 键位串", () => {
    expect(chordFromEvent(ev("Digit0", { ctrl: true }))).toBe("Ctrl+0");
    expect(chordFromEvent(ev("KeyS", { ctrl: true, shift: true }))).toBe("Ctrl+Shift+S");
    expect(chordFromEvent(ev("F5"))).toBe("F5");
    expect(chordFromEvent(ev("ControlLeft", { ctrl: true }))).toBeNull();
  });

  it("录入结果必须能被现有解析/校验链路接受", () => {
    for (const chord of ["Ctrl+0", "Ctrl+Shift+S", "Alt+F7", "F5", "Ctrl+Shift+/", "Ctrl+Alt+ArrowLeft"]) {
      expect(parseBinding(chord), chord).not.toBeNull();
    }
  });

  it("Cmd 归一为 Ctrl（与 eventMatches 一致）；修饰键按 Ctrl→Shift→Alt 排序", () => {
    expect(modsFromEvent(ev("KeyS", { meta: true }))).toEqual(["Ctrl"]);
    expect(modsFromEvent(ev("KeyS", { alt: true, shift: true, ctrl: true }))).toEqual(["Ctrl", "Shift", "Alt"]);
  });
});

describe("normalizeBinding 归一化", () => {
  it("修饰键固定序 + key 码", () => {
    expect(normalizeBinding("shift+ctrl+d")).toBe("Ctrl+Shift+KeyD");
    expect(normalizeBinding("Alt+Ctrl+Shift+/")).toBe("Ctrl+Shift+Alt+Slash");
  });

  it("非法输入返回 null", () => {
    expect(normalizeBinding("nope")).toBeNull();
  });
});

describe("validateKeybindingMap 校验", () => {
  it("出厂默认表通过校验", () => {
    expect(validateKeybindingMap(DEFAULT_SETTINGS.keybindings)).toBeNull();
  });

  it("空串 = 解绑，合法", () => {
    expect(validateKeybindingMap({ save: "", run_script: "Ctrl+F10" })).toBeNull();
  });

  it("格式无效报错", () => {
    expect(validateKeybindingMap({ save: "NotAKey" })).toContain("格式无效");
  });

  it("重复键位报冲突（大小写 / 修饰键序不敏感）", () => {
    const err = validateKeybindingMap({ save: "Ctrl+S", run_script: "ctrl+s" });
    expect(err).toContain("冲突");
  });
});

describe("三处默认值漂移锁", () => {
  it("KEYBINDING_META.def 与 DEFAULT_SETTINGS.keybindings 完全一致", () => {
    for (const m of KEYBINDING_META) {
      expect(DEFAULT_SETTINGS.keybindings[m.id], m.id).toBe(m.def);
    }
    expect(Object.keys(DEFAULT_SETTINGS.keybindings).length).toBe(KEYBINDING_META.length);
  });

  it("PyCharm 风格关键默认键", () => {
    const kb = DEFAULT_SETTINGS.keybindings;
    expect(kb.duplicate_line).toBe("Ctrl+D");
    expect(kb.comment_line).toBe("Ctrl+/");
    expect(kb.comment_block).toBe("Ctrl+Shift+/");
    expect(kb.goto_definition).toBe("Ctrl+B");
    expect(kb.stop).toBe("Ctrl+F2");
    // PR-G（dx_features_backlog §6.6）：文件内符号 Quick Pick（PyCharm 同款）
    expect(kb.goto_symbol).toBe("Ctrl+F12");
    // v3.4 §17-7（M3-3.5）：run 拆为 run_script + run_project
    expect(kb.run_script).toBe("Ctrl+F10");
    expect(kb.run_project).toBe("Ctrl+Shift+F10");
  });

  it("所有默认键均可解析", () => {
    for (const m of KEYBINDING_META) {
      expect(parseBinding(m.def), m.id).not.toBeNull();
    }
  });
});

describe("parseKeyToken 方位键短名（P1：导航历史 Ctrl+Alt+Left/Right）", () => {
  it("短名归一到标准 code（KeyboardEvent.code 只有 Arrow* 形态）", () => {
    expect(parseKeyToken("Left")).toBe("ArrowLeft");
    expect(parseKeyToken("right")).toBe("ArrowRight");
    expect(parseKeyToken("UP")).toBe("ArrowUp");
    expect(parseKeyToken("down")).toBe("ArrowDown");
  });

  it("完整 Arrow* 写法仍然可用", () => {
    expect(parseKeyToken("ArrowLeft")).toBe("ArrowLeft");
  });

  it("导航历史默认键可解析", () => {
    expect(parseBinding("Ctrl+Alt+Left")).toEqual({ ctrl: true, shift: false, alt: true, key: "ArrowLeft" });
    expect(parseBinding("Ctrl+Alt+Right")).toEqual({ ctrl: true, shift: false, alt: true, key: "ArrowRight" });
  });
});

describe("bindingChord 键位分段（UI-25 欢迎页 <kbd> 渲染）", () => {
  it("按 + 拆段，修饰键归一大小写", () => {
    expect(bindingChord("Ctrl+Shift+F")).toEqual(["Ctrl", "Shift", "F"]);
    expect(bindingChord("ctrl+alt+t")).toEqual(["Ctrl", "Alt", "T"]);
    expect(bindingChord("Control+S")).toEqual(["Ctrl", "S"]);
  });

  it("末位主键单字符转大写，功能键与符号原样保留", () => {
    expect(bindingChord("ctrl+s")).toEqual(["Ctrl", "S"]);
    expect(bindingChord("Ctrl+F10")).toEqual(["Ctrl", "F10"]);
    expect(bindingChord("Shift+F12")).toEqual(["Shift", "F12"]);
    expect(bindingChord("Ctrl+/")).toEqual(["Ctrl", "/"]);
  });

  it("空串返回空数组（调用方据此显示「未绑定」占位，而非渲染空 kbd 框）", () => {
    expect(bindingChord("")).toEqual([]);
    expect(bindingChord("   ")).toEqual([]);
  });

  it("非法串整串作一段返回：不猜拆法，也不丢信息", () => {
    expect(bindingChord("Ctrl+X+Y")).toEqual(["Ctrl+X+Y"]);
    expect(bindingChord("Win+D")).toEqual(["Win+D"]);
  });
});

describe("UI-32 快捷键功能分组（设置面板按组渲染）", () => {
  it("每个键位都归了组，且组别在渲染顺序内", () => {
    for (const m of KEYBINDING_META) {
      expect(KEYBINDING_GROUP[m.id], m.id).toBeTruthy();
      expect(KEYBINDING_GROUP_ORDER).toContain(KEYBINDING_GROUP[m.id]);
    }
  });

  it("按组取项不重不漏（漏项会让面板静默少渲染一个键位）", () => {
    const seen: string[] = [];
    for (const g of KEYBINDING_GROUP_ORDER) {
      for (const m of keybindingsOfGroup(g)) seen.push(m.id);
    }
    expect(seen.length).toBe(KEYBINDING_META.length);
    expect(new Set(seen).size).toBe(KEYBINDING_META.length);
    expect([...seen].sort()).toEqual(KEYBINDING_META.map((m) => m.id).sort());
  });
});
