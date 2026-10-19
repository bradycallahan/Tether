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
  main.ts                App shell: layout, keyboard shortcuts, palette, button/command bars, status strip
  tabs.ts                Tab = one xterm.js terminal + one backend connection. TabManager: broadcast, tiling, drag-reorder
  sidebar.ts             Session tree, filter, quick connect
  editors.ts             Session editor, settings, button-bar editor, highlight editor
  dialogs.ts             modal(), confirm/prompt/host-key/paste dialogs, context menus, toasts
  highlight.ts           Keyword highlighting via xterm decorations (never alters the stream)
  quickconnect.ts        Parses typed targets (admin@host:22, COM3 9600, telnet ts 2003)
  escapes.ts             Send-string escapes for buttons/scripts (\r \p ^C \xHH)
  schemes.ts             Terminal color schemes
  state.ts               Loaded library (sessions, bars, highlights, settings) + change events
  api.ts / types.ts      Typed wrappers for Tauri commands; mirror of the Rust model
  styles.css             All styling, design tokens at the top

src-tauri/src/           Backend — Rust, Tauri 2
  lib.rs                 Tauri commands and app setup. Thin: validate, delegate, map errors
  conn.rs                Connection manager, Ctl messages, Output sink, CmdError (structured errors)
  ssh.rs                 russh client: auth, keyboard-interactive, jump hosts, legacy algorithms, known_hosts
  telnet.rs              Telnet state machine (pure, unit tested) + raw TCP transport
  serial.rs              serialport transport, port listing, break
  local.rs               portable-pty local shells
  store.rs               On-disk library: one TOML per session, settings, bars, highlights, defaults
  secrets.rs             OS keychain via `keyring`
  logger.rs              Session logs (raw or ANSI-stripped, timestamps, templates)
  import.rs              SecureCRT .ini session importer
  model.rs               Serde model shared with the UI (camelCase on the wire and on disk)
src-tauri/tests/         Transport integration tests (SSH ones need a real server, opt-in)
tests/                   Vitest unit tests for TS parsers
```

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

## Design

The visual language is called **Patch Bay**: graphite rack panels, console-cable blue for focus and selection, and switch-port LEDs as the one signature element (every tab and pane has a port LED: green = link up, amber flicker = traffic, red = down, blinking amber = connecting). Keep the LEDs the loudest thing in the chrome; everything else stays quiet.

- **Tokens** live at the top of `styles.css` (`--rack`, `--panel`, `--panel-2/3`, `--rule`, `--text`, `--text-dim`, `--cable`, `--link`, `--activity`, `--fault`). Use them; never hard-code colors in components. Every token has a light-theme value — check both themes.
- **Type:** the system UI font for chrome, the user's monospace font for terminals. 13 px base. Sentence case everywhere. No all-caps labels, no decorative eyebrows.
- **Color carries meaning,** not decoration: blue = focus/selection/primary action, green = connected, amber = activity or "this affects many tabs" (broadcast), red = failure or destructive.
- **Copy:** plain, specific, active voice. Buttons say what happens ("Save and connect", "Trust and connect", "Paste 12 lines"). Errors explain what went wrong and how to fix it, without apologizing. Empty states invite an action.
- **Motion** only answers user actions or signals state (the LEDs). No decorative animation. Respect `prefers-reduced-motion`.
- **Layout:** sidebar | tab strip + panes | button bar | status strip. Dialogs are for focused edits only; don't bury everyday actions in them.
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

## Priorities

Work the roadmap in this order unless the owner says otherwise. Each item should land complete and polished.

1. **Expect/send login scripts** — wait for a prompt pattern, then send; timeouts; works with enable passwords and console-server hops.
2. **Restore workspace** — reopen last session's tabs, tiling and broadcast state.
3. **SFTP pane** for SSH tabs with drag-and-drop upload/download.
4. **Port forwarding** (local, remote, dynamic/SOCKS) per session.
5. **SSH agent** support (Windows OpenSSH agent / Pageant, ssh-agent) and agent forwarding.
6. **Built-in TFTP server** in the status strip for IOS images and config backups.
7. **Xmodem/Ymodem** over serial for ROMMON recovery.
8. **Split panes** (resizable, beyond the tile grid).
9. **Auto-update** via the Tauri updater plugin, signed, fed from GitHub Releases.
10. **Scripting API** (sandboxed JS first) over the connection layer.

Smaller polish items worth picking up between features: session drag-and-drop between folders, multi-select in the tree, keyboard-only navigation audit, keymap editor, per-session color scheme, a "copy as plain text / copy with colors" option, and a first-run welcome that offers the SecureCRT import.

## Releasing

Versions follow semver. One command bumps every place a version lives:

```sh
node scripts/bump-version.mjs 0.2.0
```

Then move the "Unreleased" changelog entries under the new version, commit, tag `v0.2.0` and push the tag. GitHub Actions builds Windows, macOS and Linux installers and attaches them to a draft release; the owner reviews and publishes it. Don't push tags unless asked.

## Legal

Tether is a clean-room implementation. Don't decompile, disassemble or copy anything from SecureCRT or other proprietary software. Public documentation, file formats the user owns (like their exported session files), and ordinary observation of behavior are fine. Don't use VanDyke's trademarks in the UI beyond describing the importer.
