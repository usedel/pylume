// 简体中文语言包聚合入口：各域词条在此展开成一张扁平表，并派生全局 TKey。
//
// 新增域的三步：① 建 `./<domain>.ts` 并 `export const <domain> = {}`；
// ② 在此 import 并在 zhCN 里加一行展开；③ 在 ../../en-US/ 建同名文件并在其 index.ts 展开。
// 展开顺序无关——各域 key 前缀互不相同是**约定**而非编译期保证（两个域若含同名 string key，
// 后展开者静默覆盖前者）；跨域重复由 i18n.test.ts 的全表扫描单测兜底。
import { cloneRepository } from "./cloneRepository";
import { core } from "./core";
import { database } from "./database";
import { debug } from "./debug";
import { dep } from "./dep";
import { devtools } from "./devtools";
import { editor } from "./editor";
import { endpoints } from "./endpoints";
import { env } from "./env";
import { ext } from "./ext";
import { filetree } from "./filetree";
import { git } from "./git";
import { ide } from "./ide";
import { lt } from "./lt";
import { main } from "./main";
import { newproject } from "./newproject";
import { run } from "./run";
import { search } from "./search";
import { settings } from "./settings";
import { storage } from "./storage";
import { welcome } from "./welcome";
import { workbench } from "./workbench";

/** 全量中文词条（真源）：英文包的 Record<TKey, string> 以它为基准做同构校验。 */
export const zhCN = { ...core, ...git, ...debug, ...filetree, ...run, ...env, ...storage, ...dep, ...settings, ...newproject, ...welcome, ...search, ...workbench, ...editor, ...ide, ...lt, ...devtools, ...ext, ...endpoints, ...database, ...main, ...cloneRepository };

/** 各域原始表（spread 前的独立视图）：spread 会把跨域同名 key 静默覆盖，单测扫这里才能发现重复。 */
export const zhDomains: Record<string, Record<string, string>> = { core, git, debug, filetree, run, env, storage, dep, settings, newproject, welcome, search, workbench, editor, ide, lt, devtools, ext, endpoints, database, main, cloneRepository };

/** 全部文案 key：en-US 的 `Record<TKey, string>` 与 `t()` 的入参类型都从这里派生。 */
export type TKey = keyof typeof zhCN;
