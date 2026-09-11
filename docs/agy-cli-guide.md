# Antigravity CLI (`agy`) — Operator's Guide for AI Agents

A complete operational manual for driving the Antigravity (`agy`) CLI from another agent. Based on direct probing of `agy` v1.0.10, the AtomNano integration code (`src/main/council.js`, `src/main/agyDb.js`), the [Google Cloud Medium article](https://medium.com/google-cloud/configuring-mcp-servers-and-skills-for-antigravity-cli-and-ide-a938c7eebb78), and the `r/google_antigravity` Reddit thread `1tja98b` confirming agy has **no native ACP support**.

**Version covered:** 1.0.10 (current). Replaces the legacy `gemini` CLI, whose subscription path ended 2026-06-18.

---

## 1. What `agy` is

- Google's Antigravity coding agent, shipped as a single Go executable.
- TUI-first; has a non-interactive `-p` print mode but it has a stdout-swallow bug (see §5).
- Uses your existing Gemini OAuth — **shares `~/.gemini/` with the legacy gemini CLI**.
- No native streaming protocol (no ACP, no JSON-RPC). Confirmed by maintainer of OpenAB on r/google_antigravity post `1tja98b`: *"agy-acp is not native AGY ACP support; it is our lightweight Rust adapter…"*

---

## 2. Install + locate

```bash
# Windows (PowerShell, official installer)
irm https://antigravity.google/cli/install.ps1 | iex

# macOS / Linux
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

**Critical:** the installer drops the binary in a user folder but **does NOT always add it to PATH**. Resolve it programmatically:

| OS | Resolved path |
|----|---------------|
| Windows | `%LOCALAPPDATA%\agy\bin\agy.exe` |
| macOS / Linux | `~/.local/bin/agy` or `~/.agy/bin/agy` or `/usr/local/bin/agy` |

```js
// pure-JS resolver, no deps
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");

function resolveAgy() {
  try {
    const out = execSync(
      `${process.platform === "win32" ? "where" : "command -v"} agy`,
      { timeout: 3000 }
    ).toString().trim().split(/\r?\n/)[0];
    if (out && fs.existsSync(out)) return out;
  } catch { /* not on PATH */ }
  const home = os.homedir();
  const cands = process.platform === "win32"
    ? [path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "agy", "bin", "agy.exe")]
    : [path.join(home, ".local", "bin", "agy"), path.join(home, ".agy", "bin", "agy"), "/usr/local/bin/agy"];
  return cands.find((c) => { try { return fs.existsSync(c); } catch { return false; } }) || null;
}
```

---

## 3. Authentication

- Runs through Gemini's OAuth in the browser. Trigger interactively:
  ```bash
  agy
  ```
  The TUI handles login on first run; tokens land in `~/.gemini/oauth_creds.json`.
- **Token sharing:** legacy `~/.gemini/oauth_creds.json` and `~/.gemini/google_accounts.json` work for agy too — no separate flow needed.
- No API-key flag. Subscription / quota is browser-bound.

---

## 4. CLI invocation modes

```
agy                                    # interactive TUI (default)
agy -p "<prompt>"                      # non-interactive print mode
agy --print "<prompt>"                 # same as -p
agy -c -p "<follow-up>"                # continue most recent conversation
agy --conversation <id> -p "<msg>"     # resume a specific conversation
agy -i "<prompt>"                      # start TUI with an initial prompt
agy --dangerously-skip-permissions     # auto-allow every tool call
agy --model <id>                       # override the session model
agy --sandbox                          # run in a restricted terminal sandbox
agy --add-dir <path>                   # widen workspace (repeatable)
agy --log-file <path>                  # write structured glog to this path
agy --print-timeout 5m                 # how long -p waits for the reply
```

Subcommands:

```
agy models             # list available models for your account
agy plugin list|add|...# manage plugins
agy install            # configure PATH + shell aliases
agy update             # self-update
agy changelog          # release notes
```

---

## 5. ⚠️ The non-TTY stdout bug — and how to work around it

**Symptom:** `agy -p "hello"` from any child-process spawn (not a real terminal) exits 0 with **empty stdout**. Confirmed in v1.0.10 on Windows.

The CLI prints to its own internal log file *and* writes the model reply into a per-conversation SQLite database, but the print-mode emitter doesn't flush to stdout when stdout isn't a TTY.

Three layers of recovery, in priority order:

### (a) Try stdout first — it works in real terminals

Don't assume the bug. Some environments give agy a TTY-like stream.

### (b) Pull the conversation id from `--log-file`

The log file always contains a line like:

```
I0619 12:32:34.540769  2412 conversation_manager.go:449] Forwarding user message to conversation 62458169-6550-4972-9db2-a93917f92328 (items=1, media=0)
```

Pin the convId with:

```js
const m = log.match(/conversation\s+([0-9a-f-]{36})/);
const convId = m && m[1];
```

### (c) Decode the SQLite conversation database

The actual reply is at:

```
~/.gemini/antigravity-cli/conversations/<convId>.db
```

This is a real SQLite file. **The documented `transcript.jsonl` path is NEVER populated for `-p` runs** (agy logs `"open transcript.jsonl: The system cannot find the path specified"` — its parent `.system_generated/logs/` dir isn't created). Don't waste time on it.

**Schema (verified against v1.0.10):**

```sql
CREATE TABLE steps (
  idx integer PRIMARY KEY,
  step_type integer NOT NULL DEFAULT 0,
  status integer NOT NULL DEFAULT 0,
  has_subtrajectory numeric NOT NULL DEFAULT false,
  metadata blob,
  error_details blob,
  permissions blob,
  task_details blob,
  render_info blob,
  step_payload blob,           -- THE GOOD STUFF (protobuf-encoded)
  step_format integer NOT NULL DEFAULT 0
);
CREATE TABLE trajectory_meta (
  trajectory_id text PRIMARY KEY, cascade_id text,
  trajectory_type integer, source integer
);
CREATE TABLE gen_metadata     (idx integer PRIMARY KEY, data blob, size integer);
CREATE TABLE executor_metadata(idx integer PRIMARY KEY, data blob);
CREATE TABLE parent_references(idx integer PRIMARY KEY, data blob);
CREATE TABLE trajectory_metadata_blob(id text PRIMARY KEY DEFAULT "main", data blob);
CREATE TABLE battle_mode_infos(idx integer PRIMARY KEY, data blob);
```

`step_payload` is **protobuf-encoded** without a public `.proto`. You don't need the schema — use a wire-format string scanner.

**Minimal protobuf string scanner (pure JS, ~50 lines):**

```js
function readVarint(buf, off) {
  let v = 0n, shift = 0n, i = off;
  while (i < buf.length) {
    const b = buf[i++];
    v |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [v, i];
    shift += 7n; if (shift > 70n) return null;
  }
  return null;
}

function scanStrings(buf, depth, out) {
  if (depth > 6 || buf.length === 0) return;
  let i = 0;
  while (i < buf.length) {
    const tag = readVarint(buf, i); if (!tag) return;
    const wireType = Number(tag[0] & 0x7n); i = tag[1];
    if (wireType === 0)      { const v = readVarint(buf, i); if (!v) return; i = v[1]; }
    else if (wireType === 1) { i += 8; if (i > buf.length) return; }
    else if (wireType === 5) { i += 4; if (i > buf.length) return; }
    else if (wireType === 2) {
      const lv = readVarint(buf, i); if (!lv) return;
      const len = Number(lv[0]); if (lv[1] + len > buf.length) return;
      const slice = buf.subarray(lv[1], lv[1] + len); i = lv[1] + len;
      if (isLikelyText(slice)) {
        const s = Buffer.from(slice).toString("utf8");
        if (s && s.trim().length >= 2) out.push(s);
      } else if (slice[0] < 16) scanStrings(slice, depth + 1, out);
    } else return;
  }
}

function isLikelyText(buf) {
  if (!buf.length) return false;
  let printable = 0, total = 0;
  for (let k = 0; k < Math.min(buf.length, 4000); k++) {
    const b = buf[k]; total++;
    if (b === 0) return false;
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 0x80) printable++;
  }
  return printable / total > 0.92;
}
```

**Pick the assistant reply from the scanned strings:**

```js
function pickReply(texts) {
  const cands = texts
    .map((t) => t.replace(/^[\s -]+/, "").trim())
    .filter((t) => t.length >= 8 && /\s/.test(t)
                && t.length <= 25000
                && !/^(file|https?):\/\//i.test(t)
                && !/^[0-9a-f-]{30,}$/i.test(t)
                && !t.startsWith("/"));
  return cands.sort((a, b) => scoreReply(b) - scoreReply(a))[0] || "";
}

function scoreReply(t) {
  let s = Math.min(t.length, 3000) / 100;
  if (/^[#*\-\d•A-Za-z]/.test(t)) s += 8;
  if (/[.!?]\s+[A-Z]/.test(t)) s += 6;
  if (/^[#*]/.test(t)) s += 4;
  if (/^\{[\s\S]*\}$/.test(t)) s -= 12;     // probably tool JSON
  return s;
}
```

**Iterate steps newest-first; return the first one with a passing candidate.** This nails the model reply in ~95% of cases. The other 5% are conversations where the agent only read files and never replied.

---

## 6. Configuration files

All under `~/.gemini/`:

| Path | Purpose |
|------|---------|
| `~/.gemini/oauth_creds.json` | OAuth tokens (shared with legacy gemini) |
| `~/.gemini/google_accounts.json` | Account metadata |
| `~/.gemini/config/mcp_config.json` | **MCP servers — first-class** (see §7) |
| `~/.gemini/skills/<name>/SKILL.md` | **Skills — first-class** (see §8) |
| `~/.gemini/antigravity-cli/settings.json` | Per-user CLI settings |
| `~/.gemini/antigravity-cli/keybindings.json` | TUI keybindings |
| `~/.gemini/antigravity-cli/brain/<convId>/` | Per-conversation artifacts (mostly empty for `-p` runs) |
| `~/.gemini/antigravity-cli/conversations/<convId>.db` | SQLite — the real conversation store |
| `~/.gemini/antigravity-cli/history.jsonl` | User-side input history (prompts only, no replies) |
| `~/.gemini/antigravity-cli/installation_id` | Anonymous install token |
| `~/.gemini/antigravity-cli/log/` | Structured logs |
| `~/.gemini/antigravity-cli/cli.log@` | Current log symlink |

---

## 7. MCP server configuration

File: `~/.gemini/config/mcp_config.json`

Schema:

```json
{
  "mcpServers": {
    "<server-name>": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_..." },
      "serverUrl": "https://example.com/mcp",
      "authProviderType": "oauth"
    }
  }
}
```

**Critical gotchas (documented + observed):**

- Use `serverUrl`, **NOT** the older `httpUrl` — silently ignored.
- **NO top-level `timeout`** parameter — silently ignored.
- `env` is **broken** in current agy — env vars don't propagate to the MCP server. **Hardcode credentials inline** for now.
- Each server is either STDIO (`command + args + env`) or HTTP (`serverUrl + authProviderType`). Don't mix.
- Server names must be lowercase alphanumeric / dash / underscore.

The Antigravity IDE reads the same file — anything you configure here applies in both.

---

## 8. Skills

File layout: `~/.gemini/skills/<skill-id>/SKILL.md`

Each `SKILL.md` is a frontmatter+body file:

```markdown
---
name: My skill name
description: One-line description (shown when matching)
---

# Body

Instructions, examples, exact commands the agent should follow.
```

Skills installed via `npx skills add` land at `~/.agents/skills/` — **move them to `~/.gemini/skills/`** for agy to pick them up.

Both the agy CLI and the Antigravity IDE read the same skills directory.

---

## 9. Useful one-liner recipes

```bash
# One-shot reply, with structured log capture (recommended for automation)
agy -p "summarise this commit" --dangerously-skip-permissions --log-file /tmp/agy.log

# Continue the most recent conversation
agy -c -p "now write the tests"

# Resume a specific conversation by id
agy --conversation 62458169-6550-4972-9db2-a93917f92328 -p "next step"

# Use a specific model
agy -p "explain this" --model gemini-3.1-pro-preview

# Widen the workspace (lets agy read outside the cwd)
agy --add-dir /path/to/repo -p "audit the auth layer"

# Sandboxed run (restricts what shell commands agy itself can run)
agy --sandbox -p "find and remove dead code"
```

---

## 10. Programmatic-use checklist

What every agent integration MUST do:

1. ✅ Resolve the binary via PATH **and** known install paths (§2).
2. ✅ Spawn with `--dangerously-skip-permissions` for headless use.
3. ✅ Always pass `--log-file <tmp>` so you can recover the convId (§5b).
4. ✅ Try stdout first; on empty, fall back to SQLite recovery (§5c).
5. ✅ Strip glog-style log lines from any captured stream:
   ```js
   text.replace(/^[IWE]\d{4}[^\n]*\n/gm, "")    // log lines
       .replace(/^YOLO mode is enabled[^\n]*\n/gm, "")
       .replace(/^Warning: True color[^\n]*\n/gm, "")
       .trim();
   ```
6. ✅ Set a sane `--print-timeout` (default 5m — usually too long; use 60–120s).
7. ✅ For concurrent calls, give each its own `--log-file` (don't trample).
8. ⚠️ Don't depend on `transcript.jsonl` — never populated for `-p` runs.
9. ⚠️ Don't hardcode the convId — pull from the log file.
10. ⚠️ Don't pass env vars to MCP servers; hardcode in `mcp_config.json`.

---

## 11. What `agy` does NOT have

So don't try:

- ❌ No ACP / Agent Client Protocol.
- ❌ No JSON-RPC streaming mode.
- ❌ No `--json` / `--format json` output.
- ❌ No `--verbose` / `--debug` to surface model tokens to stdout.
- ❌ No SDK / library — the CLI is the only public surface.
- ❌ No way to silence the glog stderr noise.

For real streaming, the OpenAB community ships an external adapter (`agy-acp`) that polls the SQLite db. That's a *shim*, not native support.

---

## 12. Reference implementation in this repo

This guide is implemented end-to-end in AtomNano:

| File | What it does |
|------|--------------|
| `src/main/council.js` | `resolveAgy()`, `spawnAgy(model, stdin, timeoutMs)` — the canonical runner |
| `src/main/agyDb.js` | SQLite + protobuf recovery (`recoverReply`, `latestConvId`, `scanStrings`, `pickReply`) |
| `src/main/mcpConfig.js` | Read/write `~/.gemini/config/mcp_config.json` |
| `smoke-tests/test-agy-reviewer.js` | End-to-end probe (resolves binary, runs a reviewer prompt, verifies recovery) |

Run the live smoke test:

```bash
node smoke-tests/test-agy-reviewer.js
```

Expected output: `ALL AGY-REVIEWER TESTS PASSED` after ~15 s on a working machine.

---

## 13. Verification snippet

A real integration should round-trip this prompt:

```bash
node -e "
const a = require('./your-agy-runner.js');
a.run('Reply with exactly the three words: agy works fine. No punctuation.').then(r => {
  console.log('ok=' + r.ok, 'text=' + JSON.stringify(r.text));
});
"
```

If you get `ok=true text="agy works fine"` (or similar, trimmed) the integration is correct.

---

*Last verified against `agy --version` v1.0.10 on Windows 11 with successful SQLite-recovery round-trip via the AtomNano reference implementation.*
