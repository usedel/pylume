// Pydantic 字段声明识别（阶段 2 · 显式化短板，docs/pyrefly_pydantic_support_plan.md §3.2）：
// pyrefly 不传播 Pydantic 字段的构造调用处引用（F0 实测 references=0，rename 只改声明处），
// 重命名 BaseModel 子类字段前给出提示，避免用户「静默漏改」。
//
// 定位：纯函数（无 DOM / 无 Monaco 依赖），供 renameWidget（阶段 2 提示）与后续阶段 4
// 自研语义层复用。识别为轻量文本启发式（非 AST）——误报代价仅是多弹一次 toast，
// 不追求完整 Python 语法覆盖。

/** anchor 行是否为字段注解形态：`name: type`（允许尾随 `= 默认值` / `= Field(...)`） */
const FIELD_DECL_RE = /^\s*([A-Za-z_]\w*)\s*:\s*\w/;

/** 类声明行：`class X(BaseModel, ...)`（基类列表文本包含 BaseModel 即认，不验证 import 来源） */
const CLASS_DECL_RE = /^(\s*)class\s+[A-Za-z_]\w*\s*\((.*)\)\s*:/;

/** anchor 所在行是否为方法定义（顶格或任意缩进的 def——启发式里统一视为类体边界） */
const DEF_DECL_RE = /^\s*(async\s+)?def\s+/;

/** 从 anchor 行向上搜索最近类声明的最大行数（防大文件病态扫描；BaseModel 子类字段距类头 ≤ 200 行足够） */
const CLASS_SEARCH_MAX_LINES = 200;

/** 光标 anchor 是否落在 `BaseModel` 子类的字段声明上（轻量文本启发式）。
 *
 * 规则（docs/pyrefly_pydantic_support_plan.md §3.2）：
 * a. anchor 行匹配字段注解形态 `name: type`（含尾随默认值 / Field(...)）；
 * b. 从该行向上找最近的 `class X(...)` 行（遇顶格 def / class 截断，最多 200 行），
 *    基类列表文本含 `BaseModel` 即命中（不验证 import 来源——第一版接受误报）。
 *
 * @param lines  文本行数组（0 基）
 * @param line   anchor 所在行（0 基）
 * @param col    anchor 列（0 基；仅用于早期校验，不参与判定）
 */
export function isPydanticFieldDecl(lines: string[], line: number, col: number): boolean {
  if (line < 0 || line >= lines.length || col < 0) return false;
  const declLine = lines[line];
  if (!FIELD_DECL_RE.test(declLine)) return false;
  // 字段行不可能再是类声明（`class X(...)` 不匹配字段注解形态），直接向上找类头
  for (let i = line - 1; i >= 0 && i >= line - CLASS_SEARCH_MAX_LINES; i--) {
    const m = CLASS_DECL_RE.exec(lines[i]);
    if (m) {
      // 基类列表文本含 BaseModel 即认（含 `BaseModel, MyBase` / `pydantic.BaseModel` 等写法）
      return m[2].includes("BaseModel");
    }
    // 顶格 def / 顶格 class 视为类体边界：字段不可能隔着一个函数还属于上面的类
    const t = lines[i];
    if (DEF_DECL_RE.test(t) && !t.startsWith(" ") && !t.startsWith("\t")) break;
  }
  return false;
}
