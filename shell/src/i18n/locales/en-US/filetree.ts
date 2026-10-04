// English (US) 语言包「filetree 域」：key 与 zh-CN/filetree.ts 一一对应，Record<FiletreeKey, string> 在编译期强校验漏译。
import type { FiletreeKey } from "../zh-CN/filetree";

export const filetree: Record<FiletreeKey, string> = {
  // ---- filetree.btn ----
  "filetree.btn.followOff": "Auto-reveal on file switch (off)",
  "filetree.btn.followOn": "Auto-reveal on file switch (on)",
  "filetree.btn.hideHidden": "Hide dot-files",
  "filetree.btn.showHidden": "Show dot-files",
  // ---- filetree.delete ----
  "filetree.delete.confirmMany.one": "Are you sure you want to delete 1 selected item?",
  "filetree.delete.confirmMany.other": "Are you sure you want to delete {count} selected items?",
  "filetree.delete.confirmOne": "Are you sure you want to delete \"{path}\"?",
  "filetree.delete.recycleHint": "The items will be moved to the system trash (recoverable).",
  // ---- filetree.inline ----
  "filetree.inline.title": "Enter to confirm · Esc to cancel",
  // ---- filetree.menu ----
  "filetree.menu.blame": "Blame (line history)",
  "filetree.menu.copy": "Copy",
  "filetree.menu.copyAbsPath": "Copy Absolute Path",
  "filetree.menu.copyMany.one": "Copy 1 item",
  "filetree.menu.copyMany.other": "Copy {count} items",
  "filetree.menu.copyName": "Copy Name",
  "filetree.menu.copyRelPath": "Copy Relative Path",
  "filetree.menu.cut": "Cut",
  "filetree.menu.cutMany.one": "Cut 1 item",
  "filetree.menu.cutMany.other": "Cut {count} items",
  "filetree.menu.delete": "Delete",
  "filetree.menu.deleteMany.one": "Delete 1 item",
  "filetree.menu.deleteMany.other": "Delete {count} items",
  "filetree.menu.diffClipboard": "Compare with Clipboard",
  "filetree.menu.gitFileHistory": "Git File History",
  "filetree.menu.localHistory": "Local History",
  "filetree.menu.newFile": "New File",
  "filetree.menu.newFolder": "New Folder",
  "filetree.menu.newPyFile": "New Python File",
  "filetree.menu.newPyPackage": "New Python Package",
  "filetree.menu.openDiff": "Open Diff",
  "filetree.menu.openPreview": "Open Preview",
  "filetree.menu.openTerminal": "Open in Terminal",
  "filetree.menu.paste": "Paste",
  "filetree.menu.rename": "Rename",
  "filetree.menu.revealInExplorer": "Reveal in File Explorer",
  "filetree.menu.runScript": "Run Script",
  "filetree.menu.stageChanges": "Stage Changes",
  "filetree.menu.stageNew": "Stage New File",
  // ---- filetree.op ----
  "filetree.op.copyPath": "Copy path",
  "filetree.op.deleteFailed.one": "Failed to delete 1 item: {names}",
  "filetree.op.deleteFailed.other": "Failed to delete {count} items: {names}",
  "filetree.op.dropMove": "Drag-and-drop move",
  "filetree.op.moveExists": "The target folder already contains \"{name}\"; move cancelled (overwrite is not supported)",
  "filetree.op.moveIntoSelf": "Cannot move a folder into its own subfolder",
  "filetree.op.pasteFailed.one": "Failed to paste 1 item: {names}",
  "filetree.op.pasteFailed.other": "Failed to paste {count} items: {names}",
  "filetree.op.pasteSkipped": "The target folder already contains items with the same name, skipped: {names} (move does not overwrite)",
  "filetree.op.revealExplorer": "Reveal in File Explorer",
  // ---- filetree.reveal ----
  "filetree.reveal.noActiveFile": "No active file to reveal",
  // ---- filetree.tree ----
  "filetree.tree.empty": "(empty)",
};
