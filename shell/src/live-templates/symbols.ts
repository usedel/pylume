// documentSymbol 缓存（M2，方案 §6.2）：为上下文判定提供符号数据
// 数据源由外层注入（LSP 桥 documentSymbols）；stale-while-revalidate：
// 查询总返回缓存（可能过期）并触发 300ms 防抖后台刷新，展开/补全永不阻塞。

export interface LspRangeLike {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

export interface RawSymbol {
  name: string;
  kind: number;
  range?: LspRangeLike;
  selectionRange: LspRangeLike;
  children?: RawSymbol[];
}

export interface FlatSymbol {
  name: string;
  kind: number;
  /** 1-based 行号，闭区间 */
  startLine: number;
  endLine: number;
}

/** LSP SymbolKind（与引擎无关的通用值） */
export const SYMBOL_KIND_CLASS = 5;
export const SYMBOL_KIND_METHOD = 6;
export const SYMBOL_KIND_FUNCTION = 12;

/** 层级符号树 → 扁平列表（含全部种类，判定侧按需过滤） */
export function flattenSymbols(raw: RawSymbol[]): FlatSymbol[] {
  const out: FlatSymbol[] = [];
  const walk = (s: RawSymbol): void => {
    const r = s.range ?? s.selectionRange;
    if (r) {
      out.push({ name: s.name, kind: s.kind, startLine: r.start.line + 1, endLine: r.end.line + 1 });
    }
    s.children?.forEach(walk);
  };
  raw.forEach(walk);
  return out;
}

interface VersionedModel {
  getVersionId(): number;
}

/** 缓存条目上限（B-P2-2）：无界 Map 会随打开文件数增长（大文件数百符号对象）；
 *  超限时按插入序驱逐最旧（Map 迭代序 = 插入序，简单 LRU 近似）。 */
const MAX_ENTRIES = 64;

export class SymbolIndex {
  private entries = new Map<string, { version: number; symbols: FlatSymbol[] }>();
  private timers = new Map<string, number>();
  private inflight = new Set<string>();
  /** 复核补丁（2026-09-30）：clear() 只清 timers 不够——in-flight 的 then 回调仍会
   *  向已清空的 entries 写回旧数据（model 若未 dispose，版本比对通过）。用代际计数
   *  作废 clear 之后到达的全部响应。 */
  private generation = 0;

  constructor(private fetchSymbols: (path: string) => Promise<RawSymbol[]>) {}

  /** 取缓存；未取过或版本过期时触发后台刷新（仍返回旧数据） */
  lookup(path: string, model: VersionedModel): FlatSymbol[] | null {
    const key = normKey(path);
    const entry = this.entries.get(key);
    if (!entry || entry.version !== model.getVersionId()) {
      this.scheduleRefresh(key, path, model);
    }
    return entry?.symbols ?? null;
  }

  private scheduleRefresh(key: string, path: string, model: VersionedModel): void {
    if (this.inflight.has(key)) return;
    const prev = this.timers.get(key);
    if (prev !== undefined) window.clearTimeout(prev);
    const gen = this.generation; // 捕获发起时的代际
    this.timers.set(
      key,
      window.setTimeout(() => {
        this.timers.delete(key);
        if (this.inflight.has(key)) return;
        if (gen !== this.generation) return; // 期间已 clear（工作区切换）：放弃本次刷新
        this.inflight.add(key);
        // B-P2-1（2026-09-29 review）：发起前捕获 model 版本——原实现以「响应到达时」
        // 的版本写入缓存，fetch 期间发生编辑（v1→v2）时会把 v1 时刻的符号标记为
        // version 2，下次 lookup 时 2===2 命中缓存**不再刷新**（注释宣称的自愈条件
        // 永不触发），过期符号持续到下一次编辑。改为仅当版本未变才写入；变了则
        // 丢弃（下次 lookup 因版本不匹配重新调度）。
        const versionAtRequest = model.getVersionId();
        this.fetchSymbols(path)
          .then((raw) => {
            if (gen !== this.generation) return; // clear 后到达：丢弃（防写回旧工作区数据）
            if (model.getVersionId() !== versionAtRequest) return; // 期间有编辑：丢弃过期响应
            this.entries.set(key, { version: versionAtRequest, symbols: flattenSymbols(raw) });
            // B-P2-2：超限驱逐最旧。注意这是**插入序驱逐（FIFO）**而非严格 LRU——
            // lookup 命中不做 touch；对「每打开文件一条」的缓存场景足够（重开文件
            // 会重新 set 移到尾部）。
            if (this.entries.size > MAX_ENTRIES) {
              const oldest = this.entries.keys().next().value;
              if (oldest !== undefined && oldest !== key) this.entries.delete(oldest);
            }
          })
          .catch(() => {
            /* LSP 未就绪/请求失败：保持兜底路径 */
          })
          .finally(() => this.inflight.delete(key));
      }, 300),
    );
  }

  clear(): void {
    // B-P2-2：pending timer 与在途请求一并作废（dispose 后 300ms 窗口内的回调会向
    // 已清空的 entries 写回数据）——代际 +1 让 timer 回调与 then 回调全部退出；
    // inflight 一并清（旧请求的 finally delete 对已清集合无害）。
    this.generation++;
    for (const t of this.timers.values()) window.clearTimeout(t);
    this.timers.clear();
    this.inflight.clear();
    this.entries.clear();
  }
}

function normKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}
