# Roadmap

How Tether 0.1 compares with what SecureCRT offers, and what's planned next. "Done" means it's in this release and tested; the SSH paths are tested end to end against a real OpenSSH server.

## Where things stand

| Area | SecureCRT | Tether 0.1 |
| --- | --- | --- |
| SSH2 (password, keyboard-interactive, public key) | Yes | Done |
| Encrypted private keys | Yes | Done |
| Jump host / proxy through another session | Yes | Done (one hop) |
| Legacy ciphers for old gear | Yes | Done (per-session switch) |
| Host key verification | Yes | Done, OpenSSH-format known_hosts |
| Telnet | Yes | Done (NAWS, TTYPE, break) |
| Raw TCP | Yes | Done |
| Serial (all line settings, break) | Yes | Done, with port auto-detect |
| Local shell | Yes | Done |
| RLogin, TAPI, SSH1 | Yes | Not planned |
| Session tree with folders | Yes | Done, plain TOML files |
| Quick connect | Dialog | Done, typed (`admin@host:port`, `COM3 9600`…) |
| Saved passwords | Encrypted in config | Done, OS keychain |
| Tabs | Yes | Done, drag to reorder |
| Tiling | Yes | Done (grid of all tabs) |
| Free-form split panes | Yes | Planned |
| Send to all sessions / chat window | Yes | Done (broadcast with per-tab opt-out, command bar) |
| Button bars | Yes | Done, multiple named bars |
| Keyword highlighting | Yes | Done, non-destructive, regex, live preview |
| Session logging | Yes | Done, raw or plain, timestamps, templates |
| Find in scrollback | Yes | Done |
| Color schemes / fonts | Yes | Done |
| Login actions (expect/send) | Yes | Done, with templates and keychain-backed tokens |
| Command palette | No | Done |
| Menu bar and toolbar | Yes | Done |
| Auto-reconnect | Yes | Done, with back-off |
| Anti-idle | Yes | Done (send a string after N idle seconds) |
| Clone session | Yes | Done |
| Multi-line paste confirmation | No | Done |
| Import from SecureCRT | n/a | Done (hosts, ports, users, serial, folders) |
| Portable mode | Yes | Done |
| Scripting (Python / VBScript) | Yes | Planned (see below) |
| SFTP tab / file transfer | Yes | Planned |
| Xmodem / Ymodem / Zmodem | Yes | Planned |
| Built-in TFTP server | Yes | Planned |
| Port forwarding (local/remote/dynamic) | Yes | Planned |
| X11 forwarding | Yes | Later |
| SSH agent / agent forwarding | Yes | Planned |
| GSSAPI / Kerberos, smart cards | Yes | Later |
| Keyword-triggered actions | Yes | Planned |
| Restore open tabs on launch | Yes | Done (tabs, titles, tiling, broadcast checkboxes) |
| Settings sync across machines | No | Possible via Git today |

## Next up

1. **SFTP pane** beside an SSH tab, plus drag-and-drop upload. russh-sftp makes this mostly UI work.
2. **Port forwarding** per session (local, remote, SOCKS).
3. **SSH agent** support: Pageant / Windows OpenSSH agent / ssh-agent, and forwarding.
4. **TFTP server** in the status bar for pushing IOS images and pulling configs.
5. **Xmodem/Ymodem** over serial for ROMMON image recovery.
6. **Split panes** that can be dragged and resized.

## Scripting

The plan is a small, sandboxed scripting API over the same connection layer, so a script can open sessions, send, wait for output and read the screen. A JavaScript runtime is the likely choice since the UI already speaks it; a Python bridge for people coming from SecureCRT scripts is worth considering afterwards.

## Known limitations

- RFC 4335 break over SSH isn't exposed by the SSH library yet, so break works on serial and Telnet only.
- Keyword highlighting skips full-screen apps (vim, top) and may leave a stale color if a program rewrites lines in place.
- On Linux, GPU rendering defaults off: some WebKitGTK setups stall repaints of background tabs with it on.
- Jump hosts with password auth need the jump password saved, or entered when prompted on connect.
