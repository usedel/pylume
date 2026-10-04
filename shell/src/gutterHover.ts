// gutter 悬停预示（可发现性补齐）：把「哪一段可点」画出来。
//
// 背景：断点只认 glyph margin 这一档——Monaco 按 x 坐标把整条 gutter 分成三档
// （glyph margin / 行号 / 行装饰，见 mouseTarget.js::_hitTestMargin），而这一档默认只有
// 一个行高宽（约 21px，editorOptions.js 的 glyphMarginWidth = lineHeight × lane 数）。
// 整条 gutter 视觉上却都是空白，用户常点在行号两侧的空白上（那两档点了不出断点）。
//   · CSS 侧（style.css「gutter 可发现性」段）负责把这一档画出来：进入 gutter 时给底色与
//     右边界线，且只在这一档给指针光标（行号档保持默认光标，两者一眼可区分）；
//   · 本模块做逐行精确提示：在鼠标所指那一行画一个淡化的断点图形。
//
// 三条边界（改动前先读）：
// 1. 只在 GUTTER_GLYPH_MARGIN 档提示。行号档 / 行装饰档点了不会下断点（debugGutter 只认 glyph
//    档），在那里画预示等于骗用户。
// 2. 仅 .py / .pyw（与 debugGutter / runGutter 的生效范围一致）。
// 3. 该行已有真实 glyph（断点 / 运行 ▶ / 快速修复灯泡）时不画。Monaco 会把同一行同一 lane 的
//    多个装饰**合并成一串 class**（glyphMargin.js::prepareRender 的 classNames.join），
//    于是两条 ::after 会在同一个元素上打架、由样式表书写顺序决定谁赢（正是 run ▶ 被断点红点
//    盖掉那次的成因）。这里两道措施：预检「该行是否已有 glyph」直接不画；并给预示装饰
//    zIndex: -1——同位置只渲染 zIndex 最高者，即便预检被绕过，真图标也不会被覆盖。
import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { app, type MonacoModule } from "./state";

/** 预示装饰类名（样式在 style.css：与 .gutter-breakpoint 同形，仅低透明度） */
const HOVER_CLASS = "gutter-hover";

let editorRef: MonacoApi.editor.IStandaloneCodeEditor | null = null;
let monacoRef: MonacoModule | null = null;
let decorations: MonacoApi.editor.IEditorDecorationsCollection | null = null;
/** 已画预示的行号（null = 未画）——mousemove 高频，行未变时不重设装饰 */
let hoverLine: number | null = null;

function isPythonFile(): boolean {
  const path = app.activeTab?.path;
  return !!path && (path.endsWith(".py") || path.endsWith(".pyw"));
}

/** 该行是否已有真实 glyph 装饰（泛化判断：断点 / ▶ / 灯泡，将来新增的也自动覆盖） */
function hasRealGlyph(editor: MonacoApi.editor.IStandaloneCodeEditor, line: number): boolean {
  const lineDecorations = editor.getLineDecorations(line);
  return !!lineDecorations?.some((d) => {
    const cls = d.options.glyphMarginClassName;
    return !!cls && !cls.includes(HOVER_CLASS); // 排除自己
  });
}

function setHoverLine(line: number | null): void {
  if (line === hoverLine) return; // 短路：mousemove 每次移动都会触发
  hoverLine = line;
  decorations?.clear();
  decorations = null;
  if (line === null) return;
  const editor = editorRef;
  const monaco = monacoRef;
  if (!editor || !monaco) return;
  if (!isPythonFile()) return;
  if (hasRealGlyph(editor, line)) return;
  decorations = editor.createDecorationsCollection([
    {
      range: new monaco.Range(line, 1, line, 1),
      options: { glyphMarginClassName: HOVER_CLASS, zIndex: -1 },
    },
  ]);
}

/** 清除预示（鼠标离开编辑器 / 换 model 时调用） */
export function clearGutterHover(): void {
  hoverLine = null;
  decorations?.clear();
  decorations = null;
}

export function wireGutterHover(editor: MonacoApi.editor.IStandaloneCodeEditor, monaco: MonacoModule): void {
  editorRef = editor;
  monacoRef = monaco;
  // 只读坐标、不消费事件：与 runGutter / debugGutter 的 onMouseDown、lsp 的 Ctrl+点击互不干扰
  editor.onMouseMove((e) => {
    const onGlyph = e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN;
    setHoverLine(onGlyph ? (e.target.position?.lineNumber ?? null) : null);
  });
  editor.onMouseLeave(() => clearGutterHover());
  // 切 / 关 tab 后旧行号已无意义：自接线清理，不额外占用 main.ts 的刷新链路
  editor.onDidChangeModel(() => clearGutterHover());
}
