# CLAUDE.md — working on Tether

Read this whole file before changing anything. It tells you what Tether is, what "good" means here, how the code is laid out, and how to make decisions when the task doesn't spell everything out. When this file and your instincts disagree, this file wins; when this file is silent, apply its principles.

## What Tether is

Tether is an open-source terminal for network and systems administrators: SSH, Telnet, raw TCP, serial consoles and local shells, with a saved-session library. It exists to be **a better SecureCRT** — everything SecureCRT is good at, done with more care, in a smaller, faster, more modern app that's free and open.

The owner is a network administrator. Picture the user as someone who lives in console sessions all day: consoling into a switch with a USB-serial cable, SSHing through a jump host into thirty access switches, pushing the same change to a stack of devices, grepping a log of last night's maintenance window. Every decision should make that person faster, safer or calmer.

## The bar

This must not feel vibe-coded. Concretely, that means:

- **Polished.** No half-finished features behind buttons. No placeholder text, no "TODO" in the UI, no dead menu items. Every state is designed: empty, loading, connecting, error, disconnected. Error messages say what happened and what to do next, in plain language.
- **Fast.** The app opens in well under a second, a tab opens instantly, keystrokes feel native, and 10 MB of `show tech` scrolls without stutter. Don't add work to the keystroke or output path without measuring.
- **Lightweight.** Small binary (currently ~6–7 MB installed), low idle memory, no background polling. Prefer the platform and a few good dependencies over frameworks.
- **Modern and attractive.** A coherent visual language (see Design), sensible defaults, keyboard-first, works in light and dark.
- **Trustworthy.** It handles credentials and touches production gear. Security and correctness beat convenience every time.

If you can't meet the bar for a feature in the time you have, ship a smaller feature that meets it rather than a bigger one that doesn't. Say so in your summary.

## Decision rules

Use these, in order, when choosing between options:

1. **Safety of the user's devices and credentials.** Never weaken host-key checking, never write secrets to disk or logs, never send input to a tab the user didn't intend. When in doubt, confirm (the multi-line paste dialog is the model).
2. **Correctness of the byte stream.** What the device sends is what the user sees and what gets logged. Features like highlighting must decorate, not rewrite (see `highlight.ts` for why).
3. **Speed of the common path.** Connecting to a saved session, typing, reading output, switching tabs. Optimize these over rare flows.
4. **Familiarity for SecureCRT users.** When SecureCRT has a well-loved convention (button bars, send-to-all, Enter to reconnect, session folders), match it. When its UX is dated (dialog-heavy, nested option trees), improve it — but keep the concept recognizable.
5. **Simplicity of the code.** Fewer dependencies, fewer layers, fewer files. Clever is worse than clear.

Further guidance:

- **Defaults matter more than options.** Add a setting only when reasonable users genuinely need different behavior. If you add one, give it a good default and put it on the right settings tab.
- **Don't break existing session files.** Model changes must be backward compatible: new fields get `#[serde(default)]` and a sensible default. If a breaking change is unavoidable, write a migration in `store.rs` and a test for it.
- **Don't add a frontend framework.** The UI is deliberately framework-free TypeScript (`h()` helper in `dom.ts`). It's fast, small, and has no churn. If a part becomes hard to manage, refactor it into a clearer module, don't introduce React/Vue/Svelte.
- **Prefer Rust for anything touching sockets, files, ports or secrets.** The webview is the presentation layer.
- **Ask before** adding a dependency over ~200 KB, changing the license, renaming the product, changing the on-disk format, or removing a feature. Otherwise make the call and explain it.

## Architecture

```
src/                     UI — TypeScript, Vite, no framework
  main.ts                App shell: registers every command, builds menus/toolbar/tab strip/bars/status, workspace restore, close guard
  commands.ts            Command registry: id, label, shortcut, enabled/checked, run. Chord parsing/matching/formatting
  menu.ts                Drop-down/context menus (submenus, check marks, disabled, keyboard). `cmd(id)` turns a command into a menu item
  menubar.ts             MenuBar (File/Edit/View/Session/Tools/Window/Help) and Toolbar (buttons bound to command ids)
  omnibox.ts             The toolbar's "Connect to…" box: typed targets + saved-session suggestions + recents
  tabs.ts                Tab = one xterm.js terminal + one backend connection, state banner, auto-reconnect, anti-idle.
                         TabManager: broadcast, tiling, drag-reorder. Credential prompts are queued one at a time
  sidebar.ts             Session manager: folder tree, filter, multi-select, drag-and-drop, inline rename, live LEDs
  welcome.ts             No-tabs screen: recent sessions, detected serial ports, start actions (first run offers the importer)
  editors.ts             Session options and Settings (category-list dialogs), protocol form, login-action steps,
                         quick connect dialog, button editors, highlight editor
  help.ts                Keyboard shortcuts sheet (generated from the registry), quick reference, about
  dialogs.ts             modal(), confirm/prompt/host-key/paste dialogs, toasts (with optional Undo-style action)
  highlight.ts           Keyword highlighting via xterm decorations (never alters the stream)
  quickconnect.ts        Parses typed targets (admin@host:22, COM3 9600, telnet ts 2003) and ranks saved sessions
  escapes.ts             Send-string escapes for buttons/command window (\r \p ^C \xHH) — mirrored in expect.rs
  schemes.ts             Terminal color schemes
  state.ts               Loaded library (sessions, folders, bars, highlights, settings, workspace/recents) + change events
  api.ts / types.ts      Typed wrappers for Tauri commands; mirror of the Rust model
  styles.css             All styling, design tokens at the top

src-tauri/src/           Backend — Rust, Tauri 2
  lib.rs                 Tauri commands and app setup. Thin: validate, delegate, map errors. Starts login actions on connect
  conn.rs                Connection manager, Ctl messages, Output sink (+ login-action tap), CmdError (structured errors)
  expect.rs              Login actions: send-string parser, {username}/{password}/{enable} tokens, prompt matcher, runner
  ssh.rs                 russh client: auth, keyboard-interactive, jump hosts, legacy algorithms, known_hosts
  telnet.rs              Telnet state machine (pure, unit tested) + raw TCP transport
  serial.rs              serialport transport, port listing, break
  local.rs               portable-pty local shells
  store.rs               On-disk library: one TOML per session, settings, bars, highlights, folders, workspace, defaults
  secrets.rs             OS keychain via `keyring` (password, passphrase, enable)
  logger.rs              Session logs (raw or ANSI-stripped, timestamps, templates)
  import.rs              SecureCRT .ini session importer
  model.rs               Serde model shared with the UI (camelCase on the wire and on disk)
src-tauri/tests/         Transport integration tests (SSH ones need a real server, opt-in)
tests/                   Vitest unit tests for TS parsers, shortcut handling and session ranking
preview/                 Browser preview: fake Tauri APIs + a fake Cisco-ish device (see "Seeing the UI without Tauri")
```

### How the UI is put together

- **Every user-facing action is a `Command`** registered in `App.registerCommands()` (`main.ts`). Menus (`menus()`), the toolbar, the command palette, context menus (`cmd(id)` in `menu.ts`) and keyboard handling all read from the registry. To add an action: register it once, then place it in the menu it belongs to (and the toolbar or a context menu if it's everyday). Never wire a shortcut by hand.
- **Shortcut rules:** app shortcuts are `Mod+Shift+letter` (Ctrl+Shift on Windows/Linux, ⌘ on macOS), F-keys, `Alt+Enter`, `Alt+1…9`. Never bind plain `Ctrl+letter` or `Alt+letter` — those belong to the device (^C, ^Z, ^Q flow control, Meta keys in shells). Two commands may share a chord when only one can be enabled at a time (Reconnect/Disconnect); the registry picks the enabled one. `Tab.keyFilter` keeps any registered chord away from xterm.
- **Layout:** menu bar | toolbar (omnibox + command buttons) | session manager · splitter · workspace (tab strip, panes, command window, button bar) | status strip. Toolbar, session manager, button bar, command window and status bar can each be hidden from View (stored in Settings).
- **Connection states are designed:** each pane has a banner (connecting after 600 ms, failed with Try again/Edit session, dropped with Reconnect, waiting-to-reconnect with Reconnect now/Stop). Messages also land in the terminal with a timestamp for the scrollback record.
- **Session tree LEDs** mirror open tabs (best state wins when a session is open twice). The tree's selection model uses keys `s:<id>` / `f:<path>`.
- **Folders** can be empty: explicit folders live in `folders.toml`; folders that only exist because sessions are in them are derived. Renames/moves go through `store.renameFolder()`.
- **Workspace** (`workspace.toml`): open tabs (session snapshot, saved flag, custom title, broadcast membership), active tab, tiling, and recent session ids. Written debounced on change and on close. Restored at startup when `restoreWorkspace` is on. **Broadcast mode is never restored** — typing into many devices must always be a deliberate act.
- **Prompts are queued:** when many tabs connect at once, password/host-key prompts appear one at a time and bring their tab to the front.

### Login actions (expect/send)

Stored per session as `loginSteps: [{expect, send, regex}]` plus `loginTimeoutSecs`. They run **in Rust** (`expect.rs`): `lib.rs` installs a tap on `Output` *before* the transport starts so the first prompt can't be missed, then spawns `expect::run`, which matches ANSI-stripped output (case-insensitive substring, or regex), sends the reply through the same `Ctl` channel as keystrokes, and removes the tap when done. Tokens `{username}`, `{password}`, `{enable}` are filled in from the session and the OS keychain *after* escape parsing, so secrets never reach the webview and are sent literally. An empty `expect` means "send once output has been quiet for 300 ms". The legacy `loginScript` (one command per line) still runs when `loginSteps` is empty; the editor converts it to steps on save. The send-string grammar exists twice (TS `escapes.ts`, Rust `expect::parse_send`) — change both and their tests together.

### How a connection works

1. The UI creates a `Tab` with its own `connId` and calls `connect` with the session, terminal size and any typed secrets, plus two Tauri `Channel`s (data as base64 strings, status as JSON).
2. `lib.rs` resolves saved secrets from the keychain, opens a logger if needed, and starts the right transport. Transports share one shape: bytes out via `Output`, control in via an mpsc of `Ctl::{Write, Resize, Break, Close}`.
3. Errors come back as `CmdError { code, message, detail }`. The UI reacts to codes — `NEED_PASSWORD`, `AUTH_FAILED`, `NEED_PASSPHRASE`, `NEED_USERNAME`, `HOSTKEY_UNKNOWN`, `HOSTKEY_CHANGED` — by prompting and retrying. Add new codes the same way rather than parsing message text.
4. Keystrokes go through `TabManager.input()` (which handles broadcast) into `Tab.send()`, which serializes writes per tab. **Keep that serialization**: concurrent IPC calls can arrive out of order.

### Lessons already learned (don't relearn them)

- **Raw-bytes Tauri channels** delayed the last chunk when several tabs were busy. Data is sent as base64 strings over the JSON path; keep it that way unless you prove a replacement under concurrent load.
- **WebGL in background terminals on WebKitGTK** stopped repainting until focused. GPU rendering defaults off on Linux (`Settings.gpu_rendering`).
- **A `<label>` wrapping buttons** forwards every click to the first button. `field()` only uses `<label>` for a single input/select/textarea; use `div.field` for anything else.
- **Elements with `display` set in CSS ignore the `hidden` attribute** unless the global `[hidden] { display: none !important }` rule stays.
- **Menus handle their own keys.** The menu container swallows navigation keys but must let Enter/Space through, or the focused item never clicks.
- **Don't read app state while building chrome.** The toolbar and menus call command `enabled()/checked()` lazily; anything that runs during construction (before `TabManager` exists) must not call `refresh()`.
- **`#[serde(rename)]` changes the JSON the UI sees, not just the TOML.** A rename meant to make `workspace.toml` read nicer broke startup in the real app while the preview (which fakes the JSON) looked fine. Model field names must match `types.ts`; `model.rs` has a test pinning the workspace's JSON names.
- **The browser preview fakes the backend.** When you add or change a Tauri command, update `preview/core.ts` too, or the preview throws "doesn't fake … yet".

## Design

The visual language is called **Patch Bay**: graphite rack panels, console-cable blue for focus and selection, and switch-port LEDs as the one signature element (every tab and pane has a port LED: green = link up, amber flicker = traffic, red = down, blinking amber = connecting). Keep the LEDs the loudest thing in the chrome; everything else stays quiet.

- **Tokens** live at the top of `styles.css` (`--rack`, `--panel`, `--panel-2/3`, `--rule`, `--text`, `--text-dim`, `--cable`, `--link`, `--activity`, `--fault`). Use them; never hard-code colors in components. Every token has a light-theme value — check both themes.
- **Type:** the system UI font for chrome, the user's monospace font for terminals. 13 px base. Sentence case everywhere. No all-caps labels, no decorative eyebrows.
- **Color carries meaning,** not decoration: blue = focus/selection/primary action, green = connected, amber = activity or "this affects many tabs" (broadcast), red = failure or destructive.
- **Copy:** plain, specific, active voice. Buttons say what happens ("Save and connect", "Trust and connect", "Paste 12 lines"). Errors explain what went wrong and how to fix it, without apologizing. Empty states invite an action.
- **Motion** only answers user actions or signals state (the LEDs). No decorative animation. Respect `prefers-reduced-motion`.
- **Layout:** menu bar | toolbar | session manager | tab strip + panes | command window | button bar | status strip. Dialogs are for focused edits only; don't bury everyday actions in them. Options dialogs use a category list on the left (`categories()` in `editors.ts`), never nested trees.
- Before shipping UI, look at it in light and dark, at the minimum window size (720×420), and with a long session name.

## Code conventions

**Rust**
- `cargo fmt` and `cargo clippy` clean (allow a lint only with a reason).
- No `unwrap()`/`expect()` on anything that can fail at runtime, except in `run()` startup and tests.
- Commands return `CmdResult<T>`; use specific `CmdError` codes for anything the UI should react to.
- Never log or `format!` a password, passphrase or key material, even in debug builds.
- Keep transports I/O-free where possible so logic is unit-testable (the Telnet state machine is the model).

**TypeScript**
- `strict` mode, no `any`, no unused code. `npx tsc --noEmit` must pass.
- Build DOM with `h()`; keep components as small classes or functions that own their element.
- Keep `types.ts` in sync with `model.rs` (camelCase field names).
- No new runtime dependencies without a strong reason; xterm.js addons are fine.

**General**
- Match the style of the surrounding code. Small, focused commits with clear messages.
- Comments explain *why*, not *what*.

## Testing — definition of done

A change is done when:

1. `npx tsc --noEmit`, `npm test`, `cargo clippy` and `cargo test` (in `src-tauri`) all pass.
2. New logic has tests: parsers and state machines in unit tests, transport behavior in `src-tauri/tests/transports.rs`.
3. Anything touching SSH has been run against a real server via the opt-in tests (see README for the env vars). A throwaway local `sshd` on a high port is fine.
4. UI changes were actually looked at in the running app (`npm run tauri dev`), in both themes.
5. `CHANGELOG.md` has an entry under "Unreleased" for anything user-visible.
6. `ROADMAP.md` is updated if a roadmap item changed status.

## Developing and seeing your work

**Toolchain.** The owner's machine is Fedora (immutable-style: no compiler on the host). Build inside the `fedora-toolbox-44` toolbox. One-time setup, which needs the owner's sudo password:

```sh
toolbox run -c fedora-toolbox-44 sudo dnf install -y gcc gcc-c++ webkit2gtk4.1-devel openssl-devel libudev-devel systemd-devel libsoup3-devel javascript-coregtk4.1-devel gtk3-devel librsvg2-devel libappindicator-gtk3-devel
```

Node 22 lives per-user at `~/.local/opt/node-v22.20.0-linux-x64/bin` and Rust via rustup in `~/.cargo/bin` (neither is on the default PATH; prefix commands with `export PATH=~/.local/opt/node-v22.20.0-linux-x64/bin:~/.cargo/bin:$PATH`). Cargo builds go through `toolbox run -c fedora-toolbox-44 …` once the packages above are installed.

**Testing Rust before those packages exist.** Without a C compiler nothing links. A stopgap that works without root: download Zig into a scratch directory and put a `cc` wrapper on PATH that runs `zig cc -target x86_64-linux-gnu.2.34`, then build a scratch crate that symlinks the Tauri-free modules (`conn`, `expect`, `logger`, `model`, `store`, `telnet`) with the same dependency versions and `Cargo.lock`. That runs their unit tests and clippy. It can't build `lib.rs`, `ssh.rs`, `serial.rs`, `local.rs` or `secrets.rs` (they need Tauri, libudev or D-Bus), so review those by eye and say so.

**Formatting.** `src-tauri/rustfmt.toml` sets 120 columns with `use_small_heuristics = "Max"` to keep the dense style; run `cargo fmt` (or `rustfmt --edition 2021 src/*.rs tests/*.rs`) before finishing.

**Seeing the real app.** GNOME blocks screenshot tools on Wayland, but the app can run under XWayland: launch with `GDK_BACKEND=x11 TETHER_HOME=<scratch dir> ./src-tauri/target/release/tether`, find the window with `xprop -root _NET_CLIENT_LIST` + `xprop -id <id> WM_NAME`, and capture it with ImageMagick's `import -window <id> out.png` (host tools). Seed `<scratch dir>/sessions/*.toml` and `workspace.toml` to exercise restore and connections without clicking — a local-shell session with a login step (`expect = "$"`) proves the login engine end to end. For SSH tests, a non-root `/usr/sbin/sshd -f <config>` on 127.0.0.1:2222 with `UsePAM no`, `StrictModes no` and its own host key supports the key-based opt-in tests; the password tests need a real account password.

**Seeing the UI without Tauri.** `npm run preview:ui` serves the real UI on http://localhost:1421 with the Tauri APIs swapped for in-memory fakes (`preview/`). It seeds a realistic session library, fakes a Cisco-ish device (echo, `show ip int brief`, `show interfaces status`, `show logging`…) and a few scripted situations: `edge-fw1` asks for a password, `lab-router (new key)` shows the host-key prompt, `lab-unreachable` fails to connect. Add `?empty` for a first-run library and `?theme=light` for the light theme. Use it to look at every UI change; screenshot it headlessly with Playwright (keep Playwright in your scratch directory, not in the repo). The preview never exercises Rust — login actions, logging and real transports still need `npm run tauri dev` and the Rust tests.

## Status

Keep this current: it's how the next worker knows where things stand. Newest first. **Update it as you go, not only at the end** — any worker (or subagent) may be interrupted, and the next one should be able to pick up from this section alone.

- **2026-10-21 — Windows polish, in progress (branch `claude/project-thread-ky4ci3`, PR #1).** Owner's priority: Windows first, deep native feel; macOS/Linux must keep building but get their own polish later. Plan and SecureCRT feature map: https://claude.ai/artifact/79docbmL8eW2TvsjxJwEk7. SecureCRT walkthrough notes: project file `notes/securecrt-review.md`.
  - **Done on the branch:** `dragDropEnabled: false` (HTML5 DnD was dead on Windows); WebView2 browser accelerators off in release (`window.rs`) plus a JS guard (`platform.ts`); engine context menu suppressed outside text fields; file drops can't navigate; window placement in `window.toml` with off-screen protection; hidden-until-painted start (`window_ready` command, 4 s fallback); title bar follows theme (`setTheme`); Fluent overlay scrollbars (custom scrollbar CSS scoped to non-Windows via `data-platform`); autofill off; taskbar flash on bell/drop; Ctrl+Insert/Shift+Insert; installer metadata; local shell picker (`list_shells`: pwsh, powershell, cmd, WSL distros, Git Bash; quoted command lines); Alt-tap to menu bar with access keys (Alt+letter stays Meta); Menu key / Shift+F10 context menus (never paste in the terminal); Windows 11 menu proportions; forced-colors pass. Linux: clippy, tests, tsc, vitest all pass; preview checked with a Windows UA.
  - **In progress:** real Windows 11 build and test on the owner's machine ATLAS (worktree `D:\Tether-ky4ci3`; needs VS 2022 Build Tools, Rust MSVC, NASM — all installed now). CI run on the PR.
  - **Next (Windows quick wins from the feature map):** Ctrl+F4 and Ctrl+Shift+Tab, Shift+click a button to send to all tabs, Ctrl+Enter multi-line command window, "(2)" suffix for duplicate tab titles, always on top, `tether.exe --session` + taskbar jump list. Then roadmap item 3 (SFTP).
  - **Decisions:** keep the HTML menu bar (Win32 menus can't go dark) and the native title bar (keeps Snap Layouts); Alt+letter stays with the device; no new crates (`webview2-com`/`windows-core` are already in Tauri's tree).

- **2026-10-20 (later) — built and verified on the owner's machine.** Full `cargo clippy --all-targets` clean (fixed two older warnings in `import.rs`/`ssh.rs`), `cargo fmt --check` clean, `cargo test` 28 passed, release build OK. Added a size-focused `[profile.release]` (LTO, strip): binary 28 MB → 10.4 MB. Running the real app found a startup crash (workspace JSON field renamed by serde) — fixed with a regression test. Verified in the real app: workspace restore, local-shell connection, login action sent by the Rust engine. Opt-in SSH tests `ssh_encrypted_key` and `ssh_changed_host_key_is_blocked` pass against a local sshd. **Still unverified:** the password-based SSH tests (need a real account password), login actions against real network gear, Windows and macOS.
- **2026-10-20 — UI overhaul + roadmap items 1 and 2 (uncommitted until the owner pushes).** Command registry, menu bar, toolbar with quick-connect box, rebuilt session manager (folders incl. empty ones, multi-select, drag-and-drop, inline rename, LEDs), state banners, welcome screen, category-list Session options and Settings, quick connect dialog, button-bar inline editing, palette ranking, shortcuts sheet, quick reference, about. Expect/send login actions (Rust engine, templates, enable password in keychain, non-SSH login username). Restore workspace and recent sessions. Auto-reconnect and anti-idle per session. Per-session color scheme. Confirm before quitting with live tabs. `tsc`, Vitest (14 tests) and a production `vite build` pass; the UI was reviewed in the browser preview in dark, light, at 720×420 and with long names. Rust: the Tauri-free modules (expect, model, store, conn, logger, telnet) compile clippy-clean and their 22 unit tests pass via the Zig stopgap; the crate was formatted with the new `rustfmt.toml`. **Not yet verified:** a full `cargo clippy`/`cargo test` of the whole crate (`lib.rs` and the SSH/serial/local transports were reviewed by eye only), a real `npm run tauri dev` session, login actions against real gear, and the opt-in SSH tests.

## Priorities

Work the roadmap in this order unless the owner says otherwise. Each item should land complete and polished.

1. ~~Expect/send login scripts~~ — built (see Status); verify against real gear.
2. ~~Restore workspace~~ — built: tabs, titles, tiling, broadcast membership (broadcast mode itself deliberately starts off).
3. **SFTP pane** for SSH tabs with drag-and-drop upload/download.
4. **Port forwarding** (local, remote, dynamic/SOCKS) per session.
5. **SSH agent** support (Windows OpenSSH agent / Pageant, ssh-agent) and agent forwarding.
6. **Built-in TFTP server** in the status strip for IOS images and config backups.
7. **Xmodem/Ymodem** over serial for ROMMON recovery.
8. **Split panes** (resizable, beyond the tile grid).
9. **Auto-update** via the Tauri updater plugin, signed, fed from GitHub Releases.
10. **Scripting API** (sandboxed JS first) over the connection layer.

Smaller polish items worth picking up between features: keyboard-only navigation audit, keymap editor (the command registry makes this straightforward), a "copy as plain text / copy with colors" option, session import/export as a zip, a per-tab "lock" that ignores typing, and keyword-triggered actions. Done already: drag-and-drop between folders, multi-select, per-session color scheme, first-run welcome with the SecureCRT import.

## Releasing

Versions follow semver. One command bumps every place a version lives:

```sh
node scripts/bump-version.mjs 0.2.0
```

Then move the "Unreleased" changelog entries under the new version, commit, tag `v0.2.0` and push the tag. GitHub Actions builds Windows, macOS and Linux installers and attaches them to a draft release; the owner reviews and publishes it. Don't push tags unless asked.

## Handing work back to the owner

The owner pushes to GitHub himself. At the end of every task that changes files, finish your summary with a short **"Push this update"** section containing the exact commands to run, tailored to what you did. Don't make him work them out.

- Always give the commands as a copy-pasteable block, run from the repo root:
  ```sh
  git add -A
  git commit -m "<a real message describing this change>"
  git push
  ```
  Write the commit message for him — specific, imperative, under ~70 characters (e.g. "Add expect/send login scripts with prompt timeouts").
- If you already committed (because he asked you to), say so and give only `git push`.
- If the change is ready to ship as a release, say so and add the release steps from "Releasing" with the next version number filled in (a feature bumps the minor, a fix bumps the patch), and remind him to move the changelog entries and publish the draft release afterwards.
- If the change is not ready to ship, say what's left so he knows not to tag yet.
- If something needs doing on GitHub itself (a secret, a setting, a failed Actions run to check), spell out where to click.
- Mention anything he should test by hand before pushing — especially things you couldn't test yourself (Windows, macOS, real serial hardware, real network gear).

Don't run `git push` or create tags yourself unless he explicitly asks.

## Legal

Tether is a clean-room implementation. Don't decompile, disassemble or copy anything from SecureCRT or other proprietary software. Public documentation, file formats the user owns (like their exported session files), and ordinary observation of behavior are fine. Don't use VanDyke's trademarks in the UI beyond describing the importer.
