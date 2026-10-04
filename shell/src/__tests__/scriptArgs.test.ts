// scriptArgs 单测（库特别支持 PR-4 验收 §6）：表单模型 / 命令行拼装 / 回填 / inconsistent 纪律 / required。
import { describe, expect, it } from "vitest";
import {
  backfillFromCommandLine,
  buildCommandLine,
  missingRequired,
  toFormModel,
  tokenizeCommandLine,
  tryBackfill,
  type ScriptParam,
} from "../scriptArgs";

const P_INPUT: ScriptParam = { name: "input", flag: "--input", type: "str", default: null, required: true, help: null, choices: null, nargs: null, source: "argparse" };
const P_LANG: ScriptParam = { name: "lang", flag: "--lang", type: "str", default: "zh", required: false, help: null, choices: ["zh", "en"], nargs: null, source: "argparse" };
const P_VERBOSE: ScriptParam = { name: "verbose", flag: "--verbose", type: "bool", default: null, required: false, help: null, choices: null, nargs: null, source: "argparse" };
const P_LEVEL: ScriptParam = { name: "level", flag: "-l", type: "int", default: 1, required: false, help: null, choices: null, nargs: null, source: "argparse" };
const P_INFILE: ScriptParam = { name: "infile", flag: null, type: "str", default: null, required: false, help: null, choices: null, nargs: null, source: "argparse" };
/** nargs='*' / 2 的多值参数（§11.5：多行文本 → 命令行多个 token） */
const P_FILES: ScriptParam = { name: "files", flag: "--files", type: "str", default: null, required: false, help: null, choices: null, nargs: "*", source: "argparse" };
const P_PAIR: ScriptParam = { name: "pair", flag: "--pair", type: "str", default: null, required: false, help: null, choices: null, nargs: "2", source: "argparse" };
const PARAMS = [P_INPUT, P_LANG, P_VERBOSE, P_LEVEL, P_INFILE];

describe("toFormModel", () => {
  it("容错：缺字段 / 非法条目", () => {
    expect(toFormModel(null)).toEqual([]);
    const raw = [null, { name: "" }, { name: "ok", flag: "notflag", type: 42 }] as unknown as ScriptParam[];
    expect(toFormModel({ params: raw })).toEqual([
      { name: "ok", flag: null, type: "str", default: null, required: false, help: null, choices: null, nargs: null, source: "argparse" },
    ]);
  });
});

describe("buildCommandLine（表单 → 命令行）", () => {
  it("常规拼装 + bool 开关 + 位置参数", () => {
    expect(
      buildCommandLine(PARAMS, { input: "a.csv", lang: "zh", verbose: true, level: "2", infile: "data.txt" }),
    ).toBe("--input a.csv --lang zh --verbose -l 2 data.txt");
  });
  it("空值跳过；bool=false 不出 flag", () => {
    expect(buildCommandLine(PARAMS, { input: "a.csv", verbose: false })).toBe("--input a.csv");
  });
  it("含空格加引号", () => {
    expect(buildCommandLine(PARAMS, { input: "my file.csv" })).toBe('--input "my file.csv"');
  });
  it("无 flag（位置参数）只出值不带 flag", () => {
    expect(buildCommandLine([{ ...P_INPUT, flag: null }], { input: "x" })).toBe("x");
  });
  // §11.5：nargs='*' / N → 多值（空格或逗号分隔）展开成多个 token
  it("nargs='*'：多值展开", () => {
    expect(buildCommandLine([P_FILES], { files: "a.txt b.txt" })).toBe("--files a.txt b.txt");
    expect(buildCommandLine([P_FILES], { files: "a.txt,b.txt" })).toBe("--files a.txt b.txt");
  });
  it("nargs=2：超出上限的值照常输出（表单不替用户截断）", () => {
    expect(buildCommandLine([P_PAIR], { pair: "x y" })).toBe("--pair x y");
  });
});

describe("tokenizeCommandLine", () => {
  it("引号与转义", () => {
    expect(tokenizeCommandLine('--input "my file.csv" -l 2')).toEqual(["--input", "my file.csv", "-l", "2"]);
    expect(tokenizeCommandLine(`--input 'a b' --q "say \\"hi\\""`)).toEqual(["--input", "a b", "--q", 'say "hi"']);
  });
});

describe("backfillFromCommandLine（命令行 → 表单）", () => {
  it("完整回填（flag/短名/bool/位置参数）", () => {
    const r = backfillFromCommandLine(PARAMS, "--input a.csv --verbose -l 2 data.txt");
    expect(r.inconsistent).toBe(false);
    expect(r.values).toEqual({ input: "a.csv", verbose: true, level: "2", infile: "data.txt" });
  });
  it("--name=value 形态", () => {
    const r = backfillFromCommandLine(PARAMS, "--input=b.csv");
    expect(r.values).toEqual({ input: "b.csv" });
    expect(r.inconsistent).toBe(false);
  });
  it("未知 token → inconsistent（绝不静默覆盖）", () => {
    const r = backfillFromCommandLine(PARAMS, "--input a.csv --wat x");
    expect(r.inconsistent).toBe(true);
    expect(r.values).toBeNull();
    expect(tryBackfill(PARAMS, "--input a.csv --wat x")).toBeNull();
  });
  it("--flag 无值 → inconsistent", () => {
    expect(backfillFromCommandLine(PARAMS, "--input").inconsistent).toBe(true);
  });
  it("多余位置参数 → inconsistent", () => {
    expect(backfillFromCommandLine(PARAMS, "a.txt b.txt").inconsistent).toBe(true);
  });
  it("部分值也照常回填（未写的参数留空）", () => {
    const r = backfillFromCommandLine(PARAMS, "--verbose");
    expect(r.values).toEqual({ verbose: true });
    expect(r.inconsistent).toBe(false);
  });
  it("bool --flag=false", () => {
    expect(backfillFromCommandLine(PARAMS, "--verbose=false").values).toEqual({ verbose: false });
  });
  it("nargs='*'：其后连续非 flag token 全归入，遇下一个 flag 停止", () => {
    const r = backfillFromCommandLine([P_FILES, P_INPUT], "--files a.txt b.txt --input c.csv");
    expect(r.inconsistent).toBe(false);
    expect(r.values).toEqual({ files: "a.txt b.txt", input: "c.csv" });
  });
  it("nargs=2：吃掉两个值后归还后续 flag", () => {
    const r = backfillFromCommandLine([P_PAIR, P_INPUT], "--pair x y --input c.csv");
    expect(r.values).toEqual({ pair: "x y", input: "c.csv" });
  });
});

describe("missingRequired", () => {
  it("缺必填指出缺哪个；bool 不参与", () => {
    expect(missingRequired(PARAMS, {})).toEqual(["input"]);
    expect(missingRequired(PARAMS, { input: "a.csv" })).toEqual([]);
  });
});
