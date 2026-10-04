// 数据库连接状态（B3 v1.4 Tab 化重设计）：sqliteView（侧栏资源管理器）与
// sqliteTabs（编辑器 Tab）共用的单一真源。
//
// 纪律：
// - 本模块持有数据与「增删改查 + 通知」；DOM 渲染归 sqliteView，查询执行归 sqliteTabs；
//   两个方向都只 import 本模块，**互相不 import**（无环）。
// - 变更后一律 notify()，订阅方（侧栏）自行重渲染——不做细粒度 diff，树很小。
//
// 后端契约见 db_cmds.rs：db_connections_load / db_connections_save / db_open / db_close /
// db_list_objects。连接 id 由路径哈希派生（同路径同 id，草稿与历史跨会话复用）。

import { invoke } from "@tauri-apps/api/core";
import { toastFail } from "./toast";
import { t } from "./i18n";
import { errMsg } from "./util";

// ---------- 数据契约（与 Rust 侧同名 camelCase） ----------

export interface DbConnection {
  id: string;
  /** 绝对路径 */
  path: string;
  /** 文件名（basename） */
  name: string;
  /** 是否以可写方式打开（默认 false） */
  writable: boolean;
  /** SQL 编辑器草稿 */
  sql: string;
  /** 查询历史（最近 20 条） */
  history: string[];
}

export interface DbColumn {
  name: string;
  declType: string;
  pk: boolean;
  notNull: boolean;
}

export interface DbObject {
  name: string;
  kind: "table" | "view" | "index";
  /** 建表 / 建索引语句（`sqlite_master.sql`） */
  sql: string | null;
  /** 表 / 视图行数；索引为 null */
  rowCount: number | null;
  /** 表 / 视图列；索引为 null */
  columns: DbColumn[] | null;
}

// ---------- 状态 ----------

let connections: DbConnection[] = [];
let activeId: string | null = null;
/** 活动连接的对象树（切换连接 / 刷新时整体替换） */
let objects: DbObject[] = [];
/** 对象树加载中（避免闪一下「没有表」空态） */
let treeLoading = false;

const listeners = new Set<() => void>();

/** 订阅状态变化（侧栏渲染用）。返回退订函数。 */
export function onDbStoreChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(): void {
  for (const fn of listeners) fn();
}

// ---------- 读取 ----------

export function getConnections(): DbConnection[] {
  return connections;
}

export function getActiveId(): string | null {
  return activeId;
}

export function getActiveConn(): DbConnection | null {
  return connections.find((c) => c.id === activeId) ?? null;
}

export function getConnById(id: string): DbConnection | null {
  return connections.find((c) => c.id === id) ?? null;
}

export function getObjects(): DbObject[] {
  return objects;
}

export function isTreeLoading(): boolean {
  return treeLoading;
}

// ---------- 变更 ----------

/** 整表替换连接列表（来自 db_connections_load / db_open 合并结果） */
export function setConnections(list: DbConnection[]): void {
  connections = list;
  if (activeId && !list.some((c) => c.id === activeId)) activeId = null;
  notify();
}

/** 设置活动连接 id（不负责开关后端连接，调用方编排） */
export function setActiveId(id: string | null): void {
  activeId = id;
  notify();
}

/** 活动连接的草稿更新（SQL Tab 输入防抖落盘用）；静默（不 notify，不重渲染树） */
export function updateConnDraft(id: string, sql: string): void {
  const conn = connections.find((c) => c.id === id);
  if (conn) conn.sql = sql;
}

/** 查询历史入档（去重、最近在前、上限 20）；静默同上 */
export function pushConnHistory(id: string, sql: string): void {
  const conn = connections.find((c) => c.id === id);
  if (!conn) return;
  conn.history = [sql, ...conn.history.filter((h) => h !== sql)].slice(0, 20);
}

export function setObjects(list: DbObject[]): void {
  objects = list;
  notify();
}

export function setTreeLoading(v: boolean): void {
  treeLoading = v;
  notify();
}

// ---------- 后端 IO ----------

/** 拉取全局连接列表（启动与需要时调用；db_open 也会把合并结果带回来） */
export async function refreshConnections(): Promise<void> {
  try {
    connections = await invoke<DbConnection[]>("db_connections_load");
  } catch (e) {
    connections = [];
    toastFail(t("database.failLoad"), e);
  }
  if (activeId && !connections.some((c) => c.id === activeId)) activeId = null;
  notify();
}

/** 把当前列表写回全局 json（草稿 / 历史 / 移除连接后调用；db_open 自己会写） */
export async function saveConnections(): Promise<void> {
  try {
    await invoke("db_connections_save", { list: connections });
  } catch (e) {
    toastFail(t("database.failSave"), e);
  }
}

/** 打开一个连接并激活（关旧开新，同时只活一个——SQLite 可写连接持文件锁）。
 *  返回 false = 打开失败（toast 已提示；活动连接回退原值）。 */
export async function activateConnection(id: string): Promise<boolean> {
  if (!id || id === activeId) return true;
  const target = connections.find((c) => c.id === id);
  if (!target) return false;
  const old = activeId;
  if (old) {
    try {
      await invoke("db_close", { id: old });
    } catch {
      // 关旧连接失败不阻断（后端可能已摘除）
    }
  }
  activeId = id;
  objects = [];
  treeLoading = true;
  notify();
  try {
    const conn = await invoke<DbConnection>("db_open", { path: target.path, writable: target.writable });
    // db_open 会把合并后的条目写回全局列表（保留草稿与历史），以它为准
    connections = await invoke<DbConnection[]>("db_connections_load");
    activeId = conn.id;
    await refreshTree();
    return true;
  } catch (e) {
    // 打开失败：回退到上一个有效连接
    activeId = old;
    treeLoading = false;
    notify();
    toastFail(t("database.failOpen"), e);
    return false;
  }
}

/** 重新拉活动连接的对象树（不重连） */
export async function refreshTree(): Promise<void> {
  if (!activeId) {
    objects = [];
    treeLoading = false;
    notify();
    return;
  }
  treeLoading = true;
  objects = [];
  notify();
  try {
    objects = await invoke<DbObject[]>("db_list_objects", { id: activeId });
    treeLoading = false;
    notify();
  } catch (e) {
    objects = [];
    treeLoading = false;
    notify();
    toastFail(t("database.failListShort"), new Error(errMsg(e)));
  }
}

/** 工作区切换等场景的视图态复位（连接列表是全局的，保留；树与活动连接回空由调用方决定） */
export function resetDbStoreTree(): void {
  objects = [];
  treeLoading = false;
  notify();
}

/** 切换可写：关旧 + 以新模式重开（SQLite 打开模式在 open 时定死）。返回新条目；失败返回 null。 */
export async function reopenConnection(id: string, writable: boolean): Promise<DbConnection | null> {
  const target = connections.find((c) => c.id === id);
  if (!target) return null;
  try {
    await invoke("db_close", { id });
    const conn = await invoke<DbConnection>("db_open", { path: target.path, writable });
    connections = await invoke<DbConnection[]>("db_connections_load");
    notify();
    return conn;
  } catch (e) {
    toastFail(t("database.failOpen"), e);
    return null;
  }
}

/** 从列表移除连接（不删文件）；是活动连接则顺带关闭并清空树 */
export async function removeConnection(id: string): Promise<void> {
  try {
    await invoke("db_close", { id });
  } catch {
    // 已摘除/已关闭都当成功
  }
  connections = connections.filter((c) => c.id !== id);
  if (activeId === id) {
    activeId = null;
    objects = [];
  }
  notify();
  await saveConnections();
}

/** 断开连接（保留在列表里，只是释放文件锁）；是活动连接则清空树 */
export async function disconnectConnection(id: string): Promise<void> {
  try {
    await invoke("db_close", { id });
  } catch (e) {
    toastFail(t("database.failClose"), e);
  }
  if (activeId === id) {
    activeId = null;
    objects = [];
  }
  notify();
}
