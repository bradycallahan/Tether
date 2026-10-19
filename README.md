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

**Working with many devices**
- Session tree with nested folders, filter-as-you-type, color tags and notes
- Quick connect box that understands `admin@10.0.0.1:2222`, `ssh -p 2222 host`, `telnet ts1 2003`, `COM3 115200`, `/dev/ttyUSB0@9600`, `[2001:db8::1]:22`
- Broadcast mode: type once, send to every checked tab
- Tile view: see every tab at once
- "Connect to all" on any folder
- Button bars (several named bars) with escapes: `\r`, `\p` pause, `^C`, `\xHH`
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
- Seven color schemes, light/dark/system interface

**Storage**
- Every session is a small TOML file — diff it, grep it, put it in Git
- Passwords and key passphrases live in the OS keychain (Windows Credential Manager, macOS Keychain, Secret Service on Linux), never in Tether's files
- Portable mode: drop a `tether.portable` file next to the executable
- Import from SecureCRT: point it at SecureCRT's `Config/Sessions` folder

## Keyboard

| Action | Windows / Linux | macOS |
| --- | --- | --- |
| Command palette | Ctrl+Shift+P | ⌘⇧P |
| Quick connect | Ctrl+Shift+T | ⌘T |
| New session | Ctrl+Shift+N | ⌘⇧N |
| Local shell | Ctrl+Shift+E | ⌘⇧E |
| Close tab | Ctrl+Shift+W | ⌘W |
| Next / previous tab | Ctrl+Tab, Ctrl+PgDn / PgUp | same |
| Go to tab 1–9 | Alt+1…9 | |
| Reconnect / disconnect | Ctrl+Shift+R | ⌘⇧R |
| Find | Ctrl+Shift+F | ⌘F |
| Toggle logging | Ctrl+Shift+L | ⌘⇧L |
| Send break | Ctrl+Shift+K | ⌘⇧K |
| Broadcast | Ctrl+Shift+B | ⌘⇧B |
| Tile tabs | Ctrl+Shift+G | ⌘⇧G |
| Command bar | Ctrl+Shift+O | ⌘⇧O |
| Copy / paste | Ctrl+Shift+C / V, Shift+Insert | ⌘C / ⌘V |
| Zoom | Ctrl+= / Ctrl+- / Ctrl+0 | ⌘ |
| Settings | Ctrl+, | ⌘, |

## Building

You need [Rust](https://rustup.rs) (1.80+), [Node.js](https://nodejs.org) 20+, and the Tauri system prerequisites for your OS: <https://v2.tauri.app/start/prerequisites/>.

```sh
npm install
npm run tauri dev      # run with hot reload
npm run tauri build    # installers in src-tauri/target/release/bundle/
```

On Windows that produces an `.msi` and an NSIS `.exe` installer; on macOS a `.dmg`; on Linux `.deb`, `.rpm` and `.AppImage`. Pushing a tag like `v0.1.0` to GitHub builds all three platforms through the included workflow and attaches them to a draft release.

**Linux notes:** serial ports need membership in the `dialout` group (`uucp` on some distros). Fedora needs `webkit2gtk4.1-devel`, `libudev-devel` and `openssl-devel` to build.

## Tests

```sh
npm test                                  # quick-connect and send-string parsers
cd src-tauri && cargo test                # storage, logging, telnet, importer, raw TCP
```

The SSH tests run against a real server and are opt-in:

```sh
TETHER_TEST_SSH=127.0.0.1:22 TETHER_TEST_USER=me TETHER_TEST_PASS=... \
TETHER_TEST_KEY=~/.ssh/id_test TETHER_TEST_KEYPASS=... \
cargo test -- --include-ignored
```

They cover first-contact host keys, changed host keys, wrong and missing passwords, keyboard-interactive, encrypted keys, PTY resizing, and keystroke ordering across concurrent sessions.

## Layout

```
src/               UI (TypeScript, no framework)
  main.ts          app shell, shortcuts, palette, bars, status strip
  tabs.ts          a tab = xterm.js + one connection; broadcast/tile manager
  sidebar.ts       session tree and quick connect
  editors.ts       session, settings, button-bar and highlight editors
  highlight.ts     decoration-based keyword highlighting
src-tauri/src/     backend (Rust)
  ssh.rs           russh client, auth, jump hosts, host keys
  telnet.rs        telnet state machine + raw TCP
  serial.rs        serial ports
  local.rs         local PTY shells
  store.rs         TOML session library
  secrets.rs       OS keychain
  logger.rs        session logs
  import.rs        SecureCRT importer
```

Tether is an independent project and isn't affiliated with VanDyke Software. It's a clean-room implementation written from public documentation and ordinary usage; no SecureCRT code or binaries were examined.

## License

MIT
