// 内置工具插件（PR-3，plugin_system_design §9.7 dogfooding）：
// 内置工具以「内联 manifest + 构建时静态 import 的工具模块」形态走与第三方完全相同的
// 加载路径（loader.registerBuiltinPlugin → 注册表），registry/菜单/picker 不区分来源。
//
// 与第三方差异（有意为之）：
// - entry 是静态 import（打包产物，无 Blob URL / 热重载）；
// - manifest 为 TS 对象（类型 = PluginManifest），构建期即校验；
// - 权限默认授予（随应用分发，已在信任边界内）。

import type { PluginManifest } from "../../extensions/manifest";
import { t } from "../../i18n"; // 第十七批 i18n：内置工具 manifest 展示文案走语言包
import * as curl2python from "./curl2python";
import * as jsonpath from "./jsonpath";
import * as base64 from "./base64";
import * as urlcode from "./urlcode";
import * as hash from "./hash";
import * as jsonfmt from "./jsonfmt";
import * as timestamp from "./timestamp";
import * as uuid from "./uuid";
import * as regex from "./regex";
import * as format from "./format";
import * as json2model from "./json2model";
// v1.1 批次（2026-09-30）
import * as radix from "./radix";
import * as htmlentity from "./htmlentity";
import * as unicode from "./unicode";
import * as caseconvert from "./caseconvert";
import * as wordcount from "./wordcount";
import * as sortlines from "./sortlines";
import * as color from "./color";
import * as password from "./password";
import * as textdiff from "./textdiff";

/** 内置工具模块表：entry 名 → 模块（对应第三方 manifest 的 entry 文件） */
export const BUILTIN_TOOL_MODULES: Record<string, ToolModuleLike> = {
  "./curl2python.ts": curl2python as ToolModuleLike,
  "./jsonpath.ts": jsonpath as ToolModuleLike,
  "./base64.ts": base64 as ToolModuleLike,
  "./urlcode.ts": urlcode as ToolModuleLike,
  "./hash.ts": hash as ToolModuleLike,
  "./jsonfmt.ts": jsonfmt as ToolModuleLike,
  "./timestamp.ts": timestamp as ToolModuleLike,
  "./uuid.ts": uuid as ToolModuleLike,
  "./regex.ts": regex as ToolModuleLike,
  "./format.ts": format as ToolModuleLike,
  "./json2model.ts": json2model as ToolModuleLike,
  // v1.1 批次
  "./radix.ts": radix as ToolModuleLike,
  "./htmlentity.ts": htmlentity as ToolModuleLike,
  "./unicode.ts": unicode as ToolModuleLike,
  "./caseconvert.ts": caseconvert as ToolModuleLike,
  "./wordcount.ts": wordcount as ToolModuleLike,
  "./sortlines.ts": sortlines as ToolModuleLike,
  "./color.ts": color as ToolModuleLike,
  "./password.ts": password as ToolModuleLike,
  "./textdiff.ts": textdiff as ToolModuleLike,
};

/** 工具模块契约（与第三方 ES module 导出同形；见 loader.ToolModule） */
export interface ToolModuleLike {
  mount?: (host: never) => unknown;
  [handler: string]: unknown;
}

/** 内置插件 manifest 构建（字段与磁盘版同构；id 固定 pylume.builtin）。
 *  构建函数而非模块级常量：title/description/inline 走 t() 取词，语言切换重注册时重建（踩坑 ④）。 */
export function buildBuiltinManifest(): PluginManifest {
  return {
  schemaVersion: 1,
  id: "pylume.builtin",
  name: t("devtools.manifest.name"),
  version: "1.0.0",
  engines: { pylume: ">=0.1.0" },
  contributes: {
    tools: [
      {
        id: "base64",
        title: t("devtools.tool.base64.title"),
        description: t("devtools.tool.base64.desc"),
        category: "编码",
        icon: "key",
        entry: "./base64.ts",
        inline: { label: t("devtools.tool.base64.inline"), handler: "encodeSelection" },
      },
      {
        id: "urlcode",
        title: t("devtools.tool.urlcode.title"),
        description: t("devtools.tool.urlcode.desc"),
        category: "编码",
        icon: "link",
        entry: "./urlcode.ts",
        inline: { label: t("devtools.tool.urlcode.inline"), handler: "encodeSelection" },
      },
      {
        id: "hash",
        title: "MD5 / SHA-256",
        description: t("devtools.tool.hash.desc"),
        category: "哈希",
        icon: "lock",
        entry: "./hash.ts",
        inline: { label: t("devtools.tool.hash.inline"), handler: "md5Selection" },
      },
      {
        id: "jsonfmt",
        title: t("devtools.tool.jsonfmt.title"),
        description: t("devtools.tool.jsonfmt.desc"),
        category: "格式化",
        icon: "json",
        entry: "./jsonfmt.ts",
      },
      {
        id: "curl2python",
        title: "cURL ⇄ Python",
        description: t("devtools.tool.curl2python.desc"),
        category: "转换",
        icon: "terminal",
        entry: "./curl2python.ts",
      },
      {
        id: "timestamp",
        title: t("devtools.tool.timestamp.title"),
        description: t("devtools.tool.timestamp.desc"),
        category: "转换",
        icon: "watch",
        entry: "./timestamp.ts",
        inline: { label: t("devtools.tool.timestamp.inline"), handler: "tsToReadable" },
      },
      {
        id: "uuid",
        title: t("devtools.tool.uuid.title"),
        description: t("devtools.tool.uuid.desc"),
        category: "生成",
        icon: "symbol-numeric",
        entry: "./uuid.ts",
      },
      {
        id: "jsonpath",
        title: t("devtools.tool.jsonpath.title"),
        description: t("devtools.tool.jsonpath.desc"),
        category: "提取",
        icon: "json",
        entry: "./jsonpath.ts",
      },
      {
        id: "regex",
        title: t("devtools.tool.regex.title"),
        description: t("devtools.tool.regex.desc"),
        category: "文本",
        icon: "regex",
        entry: "./regex.ts",
      },
      {
        id: "format",
        title: t("devtools.tool.format.title"),
        description: t("devtools.tool.format.desc"),
        category: "文本",
        icon: "calendar",
        entry: "./format.ts",
      },
      {
        id: "json2model",
        title: t("devtools.tool.json2model.title"),
        description: t("devtools.tool.json2model.desc"),
        category: "生成",
        icon: "json",
        entry: "./json2model.ts",
      },
      // ---------- v1.1 批次（2026-09-30，原 §9.7 备选清单） ----------
      {
        id: "radix",
        title: t("devtools.tool.radix.title"),
        description: t("devtools.tool.radix.desc"),
        category: "转换",
        icon: "symbol-numeric",
        entry: "./radix.ts",
        inline: { label: t("devtools.tool.radix.inline"), handler: "toHexSelection" },
      },
      {
        id: "htmlentity",
        title: t("devtools.tool.htmlentity.title"),
        description: t("devtools.tool.htmlentity.desc"),
        category: "编码",
        icon: "code",
        entry: "./htmlentity.ts",
        inline: { label: t("devtools.tool.htmlentity.inline"), handler: "encodeSelection" },
      },
      {
        id: "unicode",
        title: t("devtools.tool.unicode.title"),
        description: t("devtools.tool.unicode.desc"),
        category: "转换",
        icon: "whole-word",
        entry: "./unicode.ts",
        inline: { label: t("devtools.tool.unicode.inline"), handler: "unescapeSelection" },
      },
      {
        id: "caseconvert",
        title: t("devtools.tool.caseconvert.title"),
        description: "UPPER / lower / Title / snake_case / camelCase",
        category: "文本",
        icon: "case-sensitive",
        entry: "./caseconvert.ts",
        inline: { label: t("devtools.tool.caseconvert.inline"), handler: "upperSelection" },
      },
      {
        id: "wordcount",
        title: t("devtools.tool.wordcount.title"),
        description: t("devtools.tool.wordcount.desc"),
        category: "文本",
        icon: "symbol-keyword",
        entry: "./wordcount.ts",
      },
      {
        id: "sortlines",
        title: t("devtools.tool.sortlines.title"),
        description: t("devtools.tool.sortlines.desc"),
        category: "文本",
        icon: "sort-precedence",
        entry: "./sortlines.ts",
      },
      {
        id: "color",
        title: t("devtools.tool.color.title"),
        description: t("devtools.tool.color.desc"),
        category: "转换",
        icon: "color-mode",
        entry: "./color.ts",
      },
      {
        id: "password",
        title: t("devtools.tool.password.title"),
        description: t("devtools.tool.password.desc"),
        category: "生成",
        icon: "key",
        entry: "./password.ts",
      },
      {
        id: "textdiff",
        title: t("devtools.tool.textdiff.title"),
        description: t("devtools.tool.textdiff.desc"),
        category: "文本",
        icon: "diff",
        entry: "./textdiff.ts",
      },
    ],
  },
  // monaco：正则测试器的测试文本区（P6 定案）需要裸 Monaco 实例；fs:read：workspaceRoot()（求值桥定位解释器）
  permissions: ["clipboard", "selection", "monaco", "fs:read"],
  };
}
