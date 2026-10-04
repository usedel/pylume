// 冲突块级合并（阶段 3）：纯函数，零依赖，供 git.ts 调用、可独立单测。
// 此处禁止 import Monaco / DOM / invoke（遵循「纯函数」规范）。

/** 一个冲突块的内容（已去除 `<<<<<<<` / `=======` / `>>>>>>>` 标记） */
export interface ConflictBlock {
  current: string;
  incoming: string;
}

/** 把冲突文件内容按顺序切分为「普通段 + 冲突块段」，供块级选择后重组 */
export type MergeSegment = { kind: "text"; text: string } | { kind: "conflict"; block: ConflictBlock };

/** 冲突块的选择：保留当前 / 保留传入 / 保留两者 */
export type MergeChoice = "current" | "incoming" | "both";

/** 解析 `<<<<<<<` / `=======` / `>>>>>>>` 冲突标记，产出顺序段 */
export function parseMergeSegments(content: string): MergeSegment[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  const segments: MergeSegment[] = [];
  let textBuf: string[] = [];
  const flushText = () => {
    if (textBuf.length > 0) {
      segments.push({ kind: "text", text: textBuf.join("\n") });
      textBuf = [];
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("<<<<<<<")) {
      const ours: string[] = [];
      let j = i + 1;
      while (j < lines.length && !lines[j].startsWith("=======")) {
        ours.push(lines[j]);
        j++;
      }
      // 未闭合（缺 ======= 或 >>>>>>>）：把剩余整段按普通文本保留，避免丢数据
      if (j >= lines.length) {
        for (let k = i; k < lines.length; k++) textBuf.push(lines[k]);
        break;
      }
      const theirs: string[] = [];
      j++; // 跳过 =======
      while (j < lines.length && !lines[j].startsWith(">>>>>>>")) {
        theirs.push(lines[j]);
        j++;
      }
      if (j >= lines.length) {
        for (let k = i; k < lines.length; k++) textBuf.push(lines[k]);
        break;
      }
      flushText();
      segments.push({
        kind: "conflict",
        block: { current: ours.join("\n"), incoming: theirs.join("\n") },
      });
      i = j + 1;
    } else {
      textBuf.push(line);
      i++;
    }
  }
  flushText();
  return segments;
}

/** 根据每块选择重组最终内容 */
export function buildMergedContent(segments: MergeSegment[], selections: Map<number, MergeChoice>): string {
  let conflictIdx = 0;
  const out: string[] = [];
  for (const seg of segments) {
    if (seg.kind === "text") {
      out.push(seg.text);
    } else {
      const sel = selections.get(conflictIdx) ?? "current";
      if (sel === "incoming") out.push(seg.block.incoming);
      else if (sel === "both") out.push(`${seg.block.current}\n${seg.block.incoming}`);
      else out.push(seg.block.current);
      conflictIdx++;
    }
  }
  return out.join("\n");
}