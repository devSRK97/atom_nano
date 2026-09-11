# AtomNano CLI (`atomnano`)

Headless command-line access to the **same** AI providers, models, custom API
endpoints, keys and run options you configured in the AtomNano app. It runs the
app in a windowless mode and reads the exact same settings — so anything you set
up in **Settings → Providers** just works from the terminal and from scripts.

---

## 1. Install / enable

**Option A — from the app (recommended)**
Settings → Integrations → **Command-line interface (atomnano)** → toggle **On**.
This runs `npm link` and puts `atomnano` on your PATH.

**Option B — manually**
```bash
cd <path-to-AtomNano>
npm link          # global `atomnano` command
# remove later with: npm rm -g atomnano
```

**Option C — no install (run in place)**
```bash
node bin/atomnano.js <args>
```

Verify:
```bash
atomnano version
atomnano providers
```

---

## 2. Command summary

```
atomnano run [options] [prompt]      Run one turn (prompt from args or stdin)
atomnano ask [options] [prompt]      Alias of run
atomnano chat [options] [prompt]     Alias of run
atomnano providers                   List providers + authorization state
atomnano models [-P provider]        List available models (incl. custom endpoints)
atomnano endpoints                   List configured custom API endpoints
atomnano version   |  --version      Print version
atomnano help      |  --help         Print help
```

If you pass no subcommand but pipe text in, it's treated as `run` with that text.

---

## 3. `run` options

| Flag | Alias | Argument | Description |
|------|-------|----------|-------------|
| `--provider` | `-P` | `anthropic` \| `openai` \| `google` \| `custom` | Which provider to use. Default: your configured **primary**. |
| `--model` | `-m` | model id | Model id, **or a custom endpoint id/name**. Default: your configured default model. |
| `--thinking` | `-t` | level | Reasoning depth (Claude/Gemini): `off` \| `think` \| `think-hard` \| `think-harder` \| `ultrathink`. |
| `--effort` | | level | Alias of `--thinking`. For OpenAI use `minimal` \| `low` \| `medium` \| `high` \| `xhigh`. |
| `--1m` | | — | Use the **1,000,000-token** context window (Claude Opus 4.6+/Sonnet 4.6+). |
| `--system` | `-s` | text | Extra system instructions prepended to the turn. |
| `--agent` | | — | **Allow tool use** (edit files, run bash, etc.). Default is text-only. |
| `--cwd` | | dir | Working directory for the run (default: current directory). |
| `--json` | | — | Emit `{"provider","model","text"}` as one JSON line (implies no streaming). |
| `--no-stream` | | — | Buffer the whole reply and print at the end (default streams for Claude). |

The **prompt** is everything after the options, or piped via stdin.

### Reading files / code as context (works for every provider)

| Flag | Alias | Description |
|------|-------|-------------|
| `--file` | `-f` | Include a file's contents (repeatable) |
| `--dir` | `-d` | Include code/text files from a directory, recursively (repeatable) |
| `@path` | | Mention a path in the prompt to include it — e.g. `"explain @src/app.js"` |
| `--max-tokens` | | Input context budget in **tokens** (default 24000; ~4 chars/token) |
| `--max-bytes` | | Hard byte cap for inlined context (overrides `--max-tokens`) |
| `--context-window` | | Total token window assumed when sizing context (default 32000) |

Files are inlined into the request as context, so even raw custom endpoints (which
can't use tools) can "see" your code. The amount is **bounded so it can't explode
the model**: for a custom endpoint the output `max_tokens` set in your payload JSON
is subtracted from the window, and oversized files/dirs are truncated to fit.
Directory reads skip `node_modules`, `.git`, `dist`, build output, dotfolders, and
binaries.

```bash
atomnano run -f src/auth.js "explain this file"
atomnano run -f a.ts -f b.ts "how do these two interact?"
atomnano run -d ./src "find potential bugs"
atomnano run "summarize @README.md and @package.json"
atomnano run -d ./src --max-tokens 8000 "high-level overview"   # tighter budget
```

---

## 4. Providers — how each runs

| Provider | Backend | Streaming | Notes |
|----------|---------|-----------|-------|
| `anthropic` | Claude Agent SDK (`query`) | yes (token by token) | Honors `--1m`, `--thinking`, `--agent`. Uses your Claude login or API key. |
| `custom` | Raw HTTP to your endpoint | no (batch) | Uses the selected endpoint's URL/key/model/payload. Pick with `-m <endpoint-id>`. |
| `openai` | Codex CLI (`codex exec`) | no (batch) | `--effort` maps to OpenAI reasoning effort. Needs OpenAI authorized. |
| `google` | Antigravity CLI (`agy`) | no (batch) | Needs Antigravity authorized. |

Authorization/keys come from the app (or the underlying CLI logins on disk). The
CLI never asks you to log in — set it up once in the app.

---

## 5. Examples

### Basic
```bash
atomnano run "write a haiku about the ocean"
atomnano run "summarize the README in 3 bullets"
```

### Choose provider / model
```bash
atomnano run -P anthropic "refactor ideas for auth.js"
atomnano run -P custom -m glm-5.2 "hello"          # a named custom endpoint
atomnano run -P openai -m gpt-5.5 "review this function"
atomnano run -P google "explain async/await"
```

### Reasoning + big context (Claude)
```bash
atomnano run -t ultrathink "design a distributed rate limiter"
atomnano run --1m -s "You are a code reviewer" "audit this large file ..."
```

### Agent mode (can edit files / run commands)
```bash
cd my-project
atomnano run --agent "add a Dockerfile and a .dockerignore"
atomnano run --agent --cwd ./service "fix the failing test"
```
> Without `--agent` the CLI only answers (no file changes) — safe for piping.

### JSON output (for scripts)
```bash
atomnano run --json "say hello in french, one word"
# {"provider":"custom","model":"...","text":"Bonjour"}
```

### Piping / composition
```bash
echo "Reply with one word: ok" | atomnano run
git diff | atomnano run -s "Review this diff for bugs"
cat error.log | atomnano run "what's causing this?"
atomnano run --json "..." | jq -r .text
```

### Inspect configuration
```bash
atomnano providers          # * marks the primary; shows authorized/api key/not set
atomnano models             # models for the primary provider (* = default model)
atomnano models -P custom   # your custom endpoints as models
atomnano endpoints          # full details of each custom endpoint
```

---

## 6. Sample outputs

```text
$ atomnano providers
Providers:
    anthropic  Anthropic (Claude)       authorized
    openai     OpenAI (Codex/GPT)       authorized
  * google     Antigravity (Google)     authorized
    custom     Custom (any API)         configured
* = current primary.

$ atomnano endpoints
Custom endpoints:
  custom-default
    name:     GLM 5.2
    endpoint: https://inference-api.nvidia.com/v1/chat/completions
    model:    (in payload)

$ atomnano run -P custom "What is 2+2? Reply with just the number."
4
```

---

## 7. Behavior & conventions

- **Streaming**: Claude streams tokens to stdout as they arrive. Custom/OpenAI/
  Google print the full reply when done. `--json` and `--no-stream` always buffer.
- **stdout vs stderr**: only the model's answer goes to **stdout**; errors and
  diagnostics go to **stderr** — so `atomnano run ... | something` stays clean.
- **Exit codes**: `0` success, `1` error (bad prompt, provider failure, etc.).
- **Config source**: everything is read from the AtomNano app's settings
  (`%APPDATA%/atomnano` on Windows). Change provider/model/keys/endpoints in the
  app and the CLI picks them up immediately.
- **Custom endpoints & `{{prompt}}`**: each turn substitutes your real prompt into
  the endpoint's payload template. If the template has no `{{prompt}}` placeholder,
  the CLI injects the prompt into the message body automatically.

---

## 8. Troubleshooting

| Symptom | Fix |
|--------|-----|
| `atomnano: command not found` | Enable the toggle in Settings, or `npm link`; open a **new** terminal so PATH refreshes. |
| `No prompt` | Pass a prompt as an argument or pipe via stdin. |
| Custom returns the same answer | Your payload had no `{{prompt}}` — open the endpoint, click **Insert {{prompt}} automatically** (the CLI also auto-injects). |
| `no custom endpoint configured` | Add one in Settings → Providers → Custom, or pass `-m <endpoint-id>`. |
| OpenAI/Google errors | Make sure that provider is authorized in the app (`atomnano providers`). |
| Hangs on stdin | Only pipe when you mean to; interactive terminals are detected and skipped. |

---

## 9. Quick reference card

```
atomnano run "PROMPT"                         # primary provider
atomnano run -P custom -m ENDPOINT "PROMPT"   # specific custom API
atomnano run -t ultrathink --1m "PROMPT"      # deep reasoning + 1M ctx (Claude)
atomnano run --agent "TASK"                   # let it edit files / run commands
echo "PROMPT" | atomnano run                  # from stdin
atomnano run --json "PROMPT" | jq -r .text    # scriptable
atomnano providers | models | endpoints       # inspect config
atomnano help                                 # full help
```
