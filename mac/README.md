# AtomNano on macOS

Everything macOS-specific lives in this folder: the entitlements, the scripts that build the
app, and this guide. The build configuration itself is the `mac:` / `dmg:` sections of
`../electron-builder.yml`; the app code is shared (`src/main/platform.js` holds the few
places where Windows and macOS differ).

This is a **dev build: ad-hoc signed, not notarized, no Apple account needed.** (Apple Silicon
refuses a completely unsigned app with "AtomNano is damaged and can't be opened" — the ad-hoc
signature avoids that.) On first launch macOS still says the developer cannot be verified:
right-click the app → **Open** (once). On macOS 15+ use System Settings → Privacy & Security →
**Open Anyway**. Or from Terminal:

```sh
xattr -dr com.apple.quarantine /Applications/AtomNano.app
```

If you ever see "damaged" with an older build, repair it in Terminal:

```sh
xattr -cr /Applications/AtomNano.app && codesign --force --deep --sign - /Applications/AtomNano.app
```

## Requirements on the Mac that runs it

- macOS 12 Monterey or newer, Apple Silicon (arm64) or Intel (x64 build).
- [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) installed and logged in —
  `curl -fsSL https://claude.ai/install.sh | bash`, then `claude` → `/login`.
  AtomNano drives your installed CLI and reuses its login (`~/.local/bin/claude` is found
  first, then Homebrew / npm-global / PATH).
- Optional: Codex CLI (`npm i -g @openai/codex` or `brew install codex`) for the OpenAI provider.

Apps launched from Finder get a minimal PATH; AtomNano merges your login shell's PATH
(Homebrew, nvm, volta, `~/.local/bin`) at startup, so the tools your Terminal sees are found.

## Build it FROM WINDOWS (no Mac needed)

electron-builder refuses macOS targets on a Windows host, and the native modules (terminal,
SQLite) have to be compiled on macOS. The build therefore runs on a free GitHub Actions
macOS runner; the script below drives it end to end and downloads the DMG.

One-time setup:

1. A GitHub account and the repository (this project uses `https://github.com/devSRK97/atom_nano.git`).
2. GitHub CLI on the PC: `winget install GitHub.cli`, then `gh auth login`.
3. Actions enabled for the repository (GitHub → Settings → Actions → "Allow all actions").

Then, from the project folder:

```bat
mac\build-mac.bat            :: commits (asks), pushes, runs the workflow, downloads dist\mac\*.dmg
mac\build-mac.ps1 -Yes       :: same without prompts
mac\build-mac.ps1 -NoPush    :: re-run the workflow for what is already pushed
mac\build-mac.ps1 -Arch x64  :: Intel build (needs an Intel runner label on your plan)
```

The workflow is `.github/workflows/build-mac.yml`; it can also be started from the repo's
Actions tab. Public repositories get unlimited free macOS minutes; private ones have a free
monthly allowance (macOS minutes count 10×, a build is ~10 minutes ≈ 100 minutes of quota).

## Build it ON a Mac

```sh
xcode-select --install          # once: compilers for the native modules
brew install node               # Node 20+
mac/build.sh                    # → dist/AtomNano-<version>-mac-<arch>.dmg (+ .zip)
mac/dev.sh                      # run from source with DevTools
```

`mac/build.sh --both` also builds the other architecture; note the native modules are only
compiled for the host, so the cross-arch app runs its terminal in pipe mode and without the
SQLite driver. Build each architecture on its own machine (or runner) for a full app.

## What the port changed

- `src/main/platform.js`: shell/CLI invocation (`cmd.exe` vs direct), `which`, the login
  shell for the integrated terminal (zsh, login mode), opening Terminal.app for CLI sign-in
  and "open terminal here", process-tree kill, the frameless-window chrome, and the PATH fix.
- Window: native traffic lights inset in the title bar (`titleBarStyle: hiddenInset`); the
  custom min/max/close buttons hide on macOS. Standard application menu (⌘Q, ⌘C/⌘V, Window),
  File → New Window (⇧⌘N) and a Dock menu entry mirror the Windows jump list.
- Dock: the per-project tile (Settings → Appearance) is the Dock icon of the focused window.
- The app stays open with no windows (macOS convention); the Dock / ⇧⌘N reopens one.
- Shortcuts accept ⌘ where Windows uses Ctrl.

## Signing later (only if you distribute to others)

Join the Apple Developer Program, then in `electron-builder.yml` replace `identity: "-"` with
your Developer ID name (or remove it so CSC_LINK supplies the certificate), set
`hardenedRuntime: true`, and give the workflow these repository secrets:
`CSC_LINK` (base64 .p12), `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
`APPLE_TEAM_ID`. electron-builder signs with the entitlements in this folder and notarizes.
