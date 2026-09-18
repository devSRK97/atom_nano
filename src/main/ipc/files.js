"use strict";
/* IPC: the workspace file system — files:* (tree + watch, read / write / save-as, create / rename /
 * move with import rewrites through the TS service, trash / reveal, search, a terminal at a folder). */
const { dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const platform = require("../platform");
const files = require("../workspace/files");

function register(ctx) {
  const { handle, winFrom, startWatch, tsCall } = ctx;
  // ---- Files ----
  handle("files:list", async (_e, dirPath) => files.listDir(dirPath));
  handle("files:watch", async (e, root) => { startWatch(winFrom(e), root); return { root: root || "" }; });
  handle("files:read", async (_e, filePath) => files.readFile(filePath));
  // Read a (small) binary file as a data: URL — used by the in-editor image preview.
  handle("files:data-url", async (_e, filePath) => {
    const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon", svg: "image/svg+xml", avif: "image/avif" };
    try {
      const st = fs.statSync(filePath);
      if (st.size > 20 * 1024 * 1024) return null;   // refuse very large images
      const ext = (filePath.split(".").pop() || "").toLowerCase();
      const mime = MIME[ext] || "application/octet-stream";
      return { dataUrl: `data:${mime};base64,${fs.readFileSync(filePath).toString("base64")}`, size: st.size, mime };
    } catch { return null; }
  });
  handle("files:write", async (_e, filePath, content) => files.writeFile(filePath, content));
  handle("files:write-checked", async (_e, filePath, content, expected) => files.writeFileChecked(filePath, content, expected));
  /* Where should this buffer live? Asked for a file that has never had a path —
   * a new tab the user typed into — so the OS picker is the right surface: it is
   * the only one that can create folders, overwrite-confirm, and reach outside
   * the project. Returns the chosen path so the editor can reopen it for real. */
  handle("files:save-as", async (e, opts) => {
    const { defaultPath, content } = opts || {};
    const res = await dialog.showSaveDialog(winFrom(e), {
      title: "Save As",
      defaultPath: defaultPath || undefined,
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    await files.writeFile(res.filePath, String(content ?? ""));
    return { path: res.filePath };
  });
  handle("files:reveal", async (_e, p) => files.reveal(p));
  handle("files:open", async (_e, p) => files.openPath(p));
  handle("files:trash", async (_e, p) => files.trash(p));
  /* Renaming a file breaks every import that pointed at it. The language service
   * can rewrite them — including the relative specifiers INSIDE the moved file,
   * which now resolve from a different directory — but only while its program
   * still knows the old path, so the edits are captured first and written after
   * the rename lands. Best-effort throughout: a project with no tsconfig, or a
   * path the service can't map, leaves imports untouched rather than failing the
   * rename the user actually asked for. */
  const fileRenameEdits = async (root, oldPath, newPath) => {
    if (!root) return null;
    try { return await tsCall("request", ["fileRename", root, oldPath, { oldPath, newPath }]); }
    catch { return null; }
  };
  const samePath = (a, b) => String(a || "").replace(/\\/g, "/").toLowerCase() === String(b || "").replace(/\\/g, "/").toLowerCase();
  const applyRenameEdits = async (edits, oldPath, newPath) => {
    const list = (edits && edits.files) || [];
    if (!list.length) return { files: 0, edits: 0 };
    let touched = 0, applied = 0;
    for (const fc of list) {
      // Edits for the moved file itself are addressed to its OLD name; its
      // content is unchanged by the move, so the offsets still line up.
      const target = samePath(fc.fileName, oldPath) ? newPath : fc.fileName;
      let text; try { text = fs.readFileSync(target, "utf8"); } catch { continue; }
      let next = text;
      for (const e of [...(fc.edits || [])].sort((a, b) => b.from - a.from)) next = next.slice(0, e.from) + e.text + next.slice(e.to);
      if (next === text) continue;
      try { fs.writeFileSync(target, next, "utf8"); touched++; applied += (fc.edits || []).length; } catch { /* read-only — report the rest */ }
    }
    return { files: touched, edits: applied };
  };
  // Create / rename / move, and replace-across-files. Each throws on conflict so
  // the renderer can surface the reason instead of silently clobbering.
  handle("files:create-file", async (_e, p, content) => files.createFile(p, content));
  handle("files:create-folder", async (_e, p) => files.createFolder(p));
  handle("files:rename", async (_e, p, newName, root) => {
    const target = path.join(path.dirname(p), String(newName || "").trim());
    // Edits MUST be computed before the move: the language service answers from a
    // program built on the old path, and once the file is gone it can't.
    const edits = await fileRenameEdits(root, p, target);
    const res = await files.renamePath(p, newName);
    const refactor = res.unchanged ? null : await applyRenameEdits(edits, p, res.path);
    return { ...res, refactor };
  });
  handle("files:move", async (_e, from, to, root) => {
    const edits = await fileRenameEdits(root, from, to);
    const res = await files.movePath(from, to);
    const refactor = await applyRenameEdits(edits, from, res.path);
    return { ...res, refactor };
  });
  handle("files:replace-in-files", async (_e, opts) => files.replaceInFiles(opts || {}));
  // Resolve a relative import/require specifier to an on-disk file (for go-to-definition).
  handle("files:resolve-import", async (_e, fromFile, spec) => {
    try {
      if (!fromFile || !spec) return null;
      const target = path.resolve(path.dirname(fromFile), spec);
      const exts = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".py"];
      for (const ext of exts) { const p = target + ext; if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; }
      for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".py"]) { const p = path.join(target, "index" + ext); if (fs.existsSync(p)) return p; }
      if (fs.existsSync(target) && fs.statSync(target).isFile()) return target;
      return null;
    } catch { return null; }
  });
  handle("files:open-terminal", async (_e, p) => {
    let cwd = p;
    try { if (cwd && fs.existsSync(cwd) && !fs.statSync(cwd).isDirectory()) cwd = path.dirname(cwd); } catch { /* use as-is */ }
    if (!cwd || !fs.existsSync(cwd)) throw new Error("Folder no longer exists");
    // The user's terminal at the folder: Windows Terminal, macOS Terminal.app, or the desktop's default.
    platform.openTerminal({ cwd });
    return true;
  });
  handle("files:find-definition", async (_e, root, word, lang) => files.findDefinition({ root, word, lang }));
  handle("files:size", async (_e, p) => files.fileSize(p));
  handle("files:search-names", async (_e, opts) => files.searchNames(opts || {}));
  handle("files:search-content", async (_e, opts) => files.searchContent(opts || {}));
}

module.exports = { register };
