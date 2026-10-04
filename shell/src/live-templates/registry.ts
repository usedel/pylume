// Registry：三层来源合并（内置 → 用户全局 → 工作区）→ 生效模板集（方案 §5.2）
// 键 = scope + kind + abbreviation（M3：kind 分域，同缩写可分属插入/环绕/后缀三范式）；
// 窄层覆盖宽层；enabled:false 为墓碑（禁用内置）

import { DEFAULT_POSITIONS, type PositionKind, type TemplateDef, type TemplateKind, type TemplatesFile } from "./schema";
import type { SyntaxContext } from "./scope";
import { BUILTIN_TEMPLATES, BUILTIN_ORDERING } from "./builtin";

const SEP = "\u0000";

export type TemplateLayer = "builtin" | "user" | "workspace";

/** 层序（B-P2-3）：数值越大层越窄（builtin=0 < user=1 < workspace=2）。
 *  listEffective 判定「最窄生效层」用此序，而非 Map 遍历序。 */
const LAYER_RANK: Record<TemplateLayer, number> = { builtin: 0, user: 1, workspace: 2 };

interface Slot {
  tpl: TemplateDef;
  origin: TemplateLayer;
}

/** 管理面板视图：按 (kind, abbreviation) 聚合的生效状态 */
export interface EffectiveEntry {
  kind: TemplateKind;
  abbreviation: string;
  description: string;
  postfixKey?: string;
  /** 领域分组（如 "crawler"）；未分组为 undefined */
  group?: string;
  tabExpand: boolean;
  /** 启用的 scope 列表（墓碑 scope 不在内） */
  scopes: string[];
  /** 生效定义的适用位置（缺省填充；管理面板展示用） */
  positions: PositionKind[];
  /** 最窄提供方的来源层 */
  origin: TemplateLayer;
  enabled: boolean;
  /** 最窄层的完整定义（启用定义优先，否则墓碑条目） */
  tpl: TemplateDef;
}

/** 模板适用位置（缺省 DEFAULT_POSITIONS） */
function positionsOf(tpl: TemplateDef): PositionKind[] {
  return tpl.positions && tpl.positions.length > 0 ? tpl.positions : DEFAULT_POSITIONS;
}

function keyOf(scope: string, kind: TemplateKind, abbr: string): string {
  return scope + SEP + kind + SEP + abbr;
}

interface ParsedKey {
  scope: string;
  kind: TemplateKind;
  abbr: string;
}

function parseKey(key: string): ParsedKey {
  const first = key.indexOf(SEP);
  const second = key.indexOf(SEP, first + 1);
  return {
    scope: key.slice(0, first),
    kind: key.slice(first + 1, second) as TemplateKind,
    abbr: key.slice(second + 1),
  };
}

export class TemplateRegistry {
  private slots = new Map<string, Slot>();
  private ordering: Record<string, string[]> = {};

  rebuild(user: TemplatesFile | null, workspace: TemplatesFile | null): void {
    this.slots.clear();
    this.ordering = {};
    this.applyTemplates(BUILTIN_TEMPLATES, "builtin");
    this.applyOrdering(BUILTIN_ORDERING);
    if (user) {
      this.applyTemplates(user.templates, "user");
      if (user.ordering) this.applyOrdering(user.ordering);
    }
    if (workspace) {
      this.applyTemplates(workspace.templates, "workspace");
      if (workspace.ordering) this.applyOrdering(workspace.ordering);
    }
  }

  private applyTemplates(list: TemplateDef[], origin: TemplateLayer): void {
    for (const tpl of list) {
      for (const scope of tpl.scopes) {
        this.slots.set(keyOf(scope, tpl.kind, tpl.abbreviation), { tpl, origin });
      }
    }
  }

  /** ordering 按 scope 键整段替换（窄层优先，沿用 v1 priority 语义） */
  private applyOrdering(ordering: Record<string, string[]>): void {
    for (const [scope, list] of Object.entries(ordering)) {
      this.ordering[scope] = [...list];
    }
  }

  /** scope 内全部启用的插入模板（补全弹窗），按 ordering 排序（未列出者按缩写序排后） */
  templatesForScope(scope: string): TemplateDef[] {
    const all: TemplateDef[] = [];
    for (const [key, slot] of this.slots) {
      if (!slot.tpl.enabled || slot.tpl.kind !== "normal") continue;
      if (parseKey(key).scope === scope) all.push(slot.tpl);
    }
    const rank = new Map<string, number>((this.ordering[scope] ?? []).map((abbr, i) => [abbr, i]));
    return all.sort((a, b) => {
      const ra = rank.get(a.abbreviation) ?? Number.MAX_SAFE_INTEGER;
      const rb = rank.get(b.abbreviation) ?? Number.MAX_SAFE_INTEGER;
      return ra - rb || a.abbreviation.localeCompare(b.abbreviation);
    });
  }

  /** 按完整上下文（容器 + 位置）过滤插入模板（位置轴，上下文位置轴修订稿 §4） */
  templatesForContext(ctx: SyntaxContext): TemplateDef[] {
    const scope = `python:${ctx.syntax}`;
    return this.templatesForScope(scope).filter((tpl) => positionsOf(tpl).includes(ctx.position));
  }

  /** 缩写精确匹配（Tab 直接展开，仅插入模板）；未启用、墓碑或位置不符返回 null */
  findByAbbreviation(abbr: string, ctx: SyntaxContext): TemplateDef | null {
    const slot = this.slots.get(keyOf(`python:${ctx.syntax}`, "normal", abbr));
    if (!slot || !slot.tpl.enabled) return null;
    return positionsOf(slot.tpl).includes(ctx.position) ? slot.tpl : null;
  }

  /** scope 内启用的环绕模板（Ctrl+Alt+T 选择器，M3） */
  findSurround(scope: string): TemplateDef[] {
    const out: TemplateDef[] = [];
    for (const [key, slot] of this.slots) {
      if (!slot.tpl.enabled || slot.tpl.kind !== "surround") continue;
      if (parseKey(key).scope === scope) out.push(slot.tpl);
    }
    return out.sort((a, b) => a.abbreviation.localeCompare(b.abbreviation));
  }

  /** scope 内启用的后缀模板，按已键入前缀过滤（M3；空前缀返回全部） */
  findPostfixByPrefix(scope: string, typed: string): TemplateDef[] {
    const out: TemplateDef[] = [];
    for (const [key, slot] of this.slots) {
      if (!slot.tpl.enabled || slot.tpl.kind !== "postfix") continue;
      if (parseKey(key).scope !== scope) continue;
      const pk = slot.tpl.postfixKey ?? "";
      if (pk.startsWith(typed)) out.push(slot.tpl);
    }
    return out.sort((a, b) => (a.postfixKey ?? "").localeCompare(b.postfixKey ?? ""));
  }

  /** 管理面板（M2/M3）：按 (kind, abbreviation) 聚合全部生效/禁用状态 */
  listEffective(): EffectiveEntry[] {
    const byIdentity = new Map<string, Map<string, Slot>>();
    for (const [key, slot] of this.slots) {
      const { scope, kind, abbr } = parseKey(key);
      const identity = kind + SEP + abbr;
      let m = byIdentity.get(identity);
      if (!m) {
        m = new Map();
        byIdentity.set(identity, m);
      }
      m.set(scope, slot);
    }
    const out: EffectiveEntry[] = [];
    for (const [identity, scopeMap] of byIdentity) {
      const kind = identity.slice(0, identity.indexOf(SEP)) as TemplateKind;
      const abbr = identity.slice(identity.indexOf(SEP) + 1);
      const enabledScopes: string[] = [];
      let narrowestEnabled: Slot | null = null;
      let narrowestTombstone: Slot | null = null;
      for (const [scope, slot] of scopeMap) {
        if (slot.tpl.enabled) {
          enabledScopes.push(scope);
          // B-P2-3（2026-09-29 review）：原注释「遍历序即应用序（后者更窄）」不成立——
          // scopeMap 以 scope 为键，遍历序由 scope 键在 slots 中的首次插入序决定，
          // 与层序无关；「取最后遍历到的启用槽」在部分覆盖场景会拿到错误层的定义
          //（如 user 层窄化覆盖了 module scope，builtin 层仍占 class/function scope 时，
          // 原逻辑可能把 builtin 条目当最窄层）。改按 LAYER_RANK 数值判定。
          if (!narrowestEnabled || LAYER_RANK[slot.origin] >= LAYER_RANK[narrowestEnabled.origin]) {
            narrowestEnabled = slot;
          }
        } else {
          if (!narrowestTombstone || LAYER_RANK[slot.origin] >= LAYER_RANK[narrowestTombstone.origin]) {
            narrowestTombstone = slot;
          }
        }
      }
      const ref = narrowestEnabled ?? narrowestTombstone;
      if (!ref) continue;
      out.push({
        kind,
        abbreviation: abbr,
        description: ref.tpl.description,
        postfixKey: ref.tpl.postfixKey,
        group: ref.tpl.group,
        tabExpand: ref.tpl.tabExpand,
        scopes: enabledScopes.sort(),
        positions: positionsOf(ref.tpl),
        origin: ref.origin,
        enabled: enabledScopes.length > 0,
        tpl: ref.tpl,
      });
    }
    return out.sort(
      (a, b) => a.kind.localeCompare(b.kind) || a.abbreviation.localeCompare(b.abbreviation),
    );
  }
}
