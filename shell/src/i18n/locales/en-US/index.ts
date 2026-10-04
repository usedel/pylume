// English (US) 语言包聚合入口：与 zh-CN/index.ts 的域清单保持一致。
//
// 编译期保证：`Record<TKey, string>` 要求此处覆盖 zh-CN 的全部 key，漏一个就编译失败。
// 反向的「多译」不在此拦（各域文件自己的 Record<XxxKey, string> 已拦住），故新增域时
// 两边 index.ts 要同步改。
import type { TKey } from "../zh-CN";
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

export const enUS: Record<TKey, string> = { ...core, ...git, ...debug, ...filetree, ...run, ...env, ...storage, ...dep, ...settings, ...newproject, ...welcome, ...search, ...workbench, ...editor, ...ide, ...lt, ...devtools, ...ext, ...endpoints, ...database, ...main, ...cloneRepository };
