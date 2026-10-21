# Tether

An open-source terminal for network admins. SSH, Telnet, serial consoles and local shells in one fast, native app for Windows, macOS and Linux, built with Rust and Tauri.

Tether covers the SecureCRT features people actually use day to day — saved session trees, serial consoles, button bars, sending commands to many devices at once, keyword highlighting, logging, saved credentials — and adds a few things SecureCRT doesn't: plain-text session files you can keep in Git, a command palette, typed-in quick connect, tiled tabs, and paste protection.

## Features

**Connections**
- SSH with password, keyboard-interactive (what most Cisco, Aruba and Juniper gear asks for) and public-key auth, including encrypted keys
- Jump hosts: tunnel through any saved SSH session
- Legacy algorithm switch per session (SHA-1 key exchange, CBC/3DES ciphers) for old IOS and ASA boxes
- Strict host-key checking with a fingerprint prompt on first contact and a hard stop if a key changes
- Telnet with proper option negotiation (window size, terminal type) — works with Opengear, Lantronix and Cisco terminal servers
- Raw TCP
- Serial: any baud rate, data bits, parity, stop bits, XON/XOFF or RTS/CTS, port auto-detection with adapter names, and a real break signal for ROMMON / password recovery
- Local shells (PowerShell, cmd, bash, zsh, WSL…)

**Finding your way around**
- A real menu bar (File, Edit, View, Session, Tools, Window, Help) and a labeled toolbar, with every shortcut shown where you'd look for it
- A "Connect to…" box in the toolbar that suggests saved sessions as you type and understands `admin@10.0.0.1:2222`, `ssh -p 2222 host`, `telnet ts1 2003`, `COM3 115200`, `/dev/ttyUSB0@9600`, `[2001:db8::1]:22`
- A quick connect dialog for people who'd rather fill in a form, with an option to save the session
- A welcome screen with recent sessions and the serial adapters plugged in right now, one click from a console
- Command palette for every session, tab and command; a keyboard shortcuts sheet (F1)

**Working with many devices**
- Session manager with nested folders (including empty ones), filter-as-you-type, multi-select, drag-and-drop between folders, inline rename (F2), color tags and notes, and a port LED on every session that's open
- Login actions: wait for a prompt, send a reply — log in on a console server, enter enable mode, turn off paging. Templates for Cisco, Juniper and Aruba; the login and enable passwords come from the OS keychain and never pass through the UI
- Reopen last time's tabs on startup, with their titles, tiling and broadcast checkboxes; recent sessions in the File menu
- Reconnect automatically when a connection drops, and keep idle-timeout devices awake by sending a keystroke after a quiet spell
- Broadcast mode: type once, send to every checked tab
- Tile view: see every tab at once
- "Connect to all" on any folder
- Button bars (several named bars) with escapes: `\r`, `\p` pause, `^C`, `\xHH`; right-click a button to edit, move or delete it, or press + to add one
- Clone a tab to open a second session to the same device
- Command bar with history for composing a line before sending it
- Login scripts: commands sent automatically after connecting

**Terminal**
- xterm.js with GPU rendering, 256/true color, Unicode 11, clickable links (Ctrl+click)
- Keyword highlighting that colors matches as they arrive without altering the stream — colored prompts and logs stay intact. Ships with a "Network gear" set for interface names, up/down states, syslog severities, IPs and MACs
- Find in scrollback with match count
- Copy on select, right-click paste (PuTTY style), Ctrl+C copies when text is selected
- Confirmation before pasting multiple lines, with a preview
- Per-session logging, plain text or raw, optional per-line timestamps, file name templates
- Press Enter to reconnect a dropped tab
- Seven color schemes (per session if you like), light/dark/system interface
- Every connection state is spelled out in the tab: connecting, failed with the reason and a Try again button, dropped with Reconnect

**Storage**
- Every session is a small TOML file — diff it, grep it, put it in Git
- Passwords and key passphrases live in the OS keychain (Windows Credential Manager, macOS Keychain, Secret Service on Linux), never in Tether's files
- Portable mode: drop a `tether.portable` file next to the executable
- Import from SecureCRT: point it at SecureCRT's `Config/Sessions` folder

## Keyboard

App shortcuts use Ctrl+Shift so plain Ctrl keys (^C, ^Z, ^Q…) always reach the device.

| Action | Windows / Linux | macOS |
| --- | --- | --- |
| Command palette | Ctrl+Shift+P | ⇧⌘P |
| Connect to address | Ctrl+Shift+T | ⌘T |
| New session | Ctrl+Shift+N | ⇧⌘N |
| Local shell | Ctrl+Shift+E | ⇧⌘E |
| Session options | Alt+Enter | ⌥↩ |
| Clone tab | Ctrl+Shift+D | ⇧⌘D |
| Close tab | Ctrl+Shift+W | ⌘W |
| Next / previous tab | Ctrl+Tab, Ctrl+PgDn / PgUp | ⌃⇥, ⇧⌘] / [ |
| Go to tab 1–9 | Alt+1…9 | ⌘1…9 |
| Reconnect / disconnect | Ctrl+Shift+R | ⇧⌘R |
| Find in scrollback | Ctrl+Shift+F | ⌘F |
| Toggle logging | Ctrl+Shift+L | ⇧⌘L |
| Send break | Ctrl+Shift+K | ⇧⌘K |
| Broadcast | Ctrl+Shift+B | ⇧⌘B |
| Tile tabs | Ctrl+Shift+G | ⇧⌘G |
| Command window | Ctrl+Shift+O | ⇧⌘O |
| Session manager / find a session | Ctrl+Shift+M / Ctrl+Shift+S | ⇧⌘M / ⇧⌘S |
| Copy / paste | Ctrl+Shift+C / V, Shift+Insert | ⌘C / ⌘V |
| Zoom | Ctrl+= / Ctrl+- / Ctrl+0 | ⌘= / ⌘- / ⌘0 |
| Settings | Ctrl+, | ⌘, |
| Menu bar | F10 | F10 |
| Keyboard shortcuts | F1 | F1 |
| Full screen | F11 | ⌃⌘F |

In the session manager: arrows move, Right/Left open and close folders, Enter connects (to everything selected), F2 renames, Delete deletes, and typing starts a filter.

## Building

You need [Rust](https://rustup.rs) (1.80+), [Node.js](https://nodejs.org) 20+, and the Tauri system prerequisites for your OS: <https://v2.tauri.app/start/prerequisites/>.

```sh
npm install
npm run tauri dev      # run with hot reload
npm run tauri build    # installers in src-tauri/target/release/bundle/
```

On Windows that produces an `.msi` and an NSIS `.exe` installer; on macOS a `.dmg`; on Linux `.deb`, `.rpm` and `.AppImage`. Pushing a tag like `v0.1.0` to GitHub builds all three platforms through the included workflow and attaches them to a draft release.

**Windows notes:** install the Visual Studio 2022 Build Tools with the "Desktop development with C++" workload, Rust's `stable-x86_64-pc-windows-msvc` toolchain, and [NASM](https://www.nasm.us) (`winget install NASM.NASM`, then reopen the terminal) — the SSH library's crypto backend assembles with it. Without NASM, set `AWS_LC_SYS_PREBUILT_NASM=1` to use its prebuilt objects.

**Linux notes:** serial ports need membership in the `dialout` group (`uucp` on some distros). Fedora needs `webkit2gtk4.1-devel`, `libudev-devel` and `openssl-devel` to build.

## Tests

```sh
npm test                                  # quick connect, send strings, shortcuts, session ranking
cd src-tauri && cargo test                # storage, logging, telnet, login actions, importer, raw TCP
npm run preview:ui                        # the UI in a browser with a fake backend (no Rust build needed)
```

The SSH tests run against a real server and are opt-in:

```sh
TETHER_TEST_SSH=127.0.0.1:22 TETHER_TEST_USER=me TETHER_TEST_PASS=... \
TETHER_TEST_KEY=~/.ssh/id_test TETHER_TEST_KEYPASS=... \
cargo test -- --include-ignored
```

They cover first-contact host keys, changed host keys, wrong and missing passwords, keyboard-interactive, encrypted keys, PTY resizing, and keystroke ordering across concurrent sessions.

## Layout

See [CLAUDE.md](CLAUDE.md) for the full map of the code and how it fits together.

```
src/               UI (TypeScript, no framework)
  main.ts          app shell: commands, menus, toolbar, bars, status strip, workspace
  commands.ts      command registry behind menus, toolbar, palette and shortcuts
  tabs.ts          a tab = xterm.js + one connection; broadcast/tile manager
  sidebar.ts       session manager tree
  editors.ts       session options, settings, quick connect, button-bar and highlight editors
  highlight.ts     decoration-based keyword highlighting
src-tauri/src/     backend (Rust)
  ssh.rs           russh client, auth, jump hosts, host keys
  telnet.rs        telnet state machine + raw TCP
  serial.rs        serial ports
  local.rs         local PTY shells
  expect.rs        login actions (expect/send)
  store.rs         TOML session library, folders, workspace
  secrets.rs       OS keychain
  logger.rs        session logs
  import.rs        SecureCRT importer
preview/           browser preview with a fake backend
```

Tether is an independent project and isn't affiliated with VanDyke Software. It's a clean-room implementation written from public documentation and ordinary usage; no SecureCRT code or binaries were examined.

## License

MIT
