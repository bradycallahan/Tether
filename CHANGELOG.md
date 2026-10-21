# Changelog

All notable changes to Tether are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/), and versions follow [semantic versioning](https://semver.org/).

## Unreleased

### Added
- Menu bar (File, Edit, View, Session, Tools, Window, Help) and a labeled toolbar; every action shows its shortcut where you'd look for it
- "Connect to…" box in the toolbar that suggests saved sessions as you type and shows recent ones when empty
- Quick connect dialog, with the option to save the session
- Welcome screen with recent sessions, detected serial adapters (connect in one click) and, on first run, the SecureCRT importer
- Login actions: expect/send steps with templates for Cisco, Juniper and Aruba gear, a per-step timeout, and `{username}`, `{password}` and `{enable}` filled in from the session and the system keychain
- Enable password and a login user name per session, saved in the system keychain / session file
- Reopen last time's tabs on startup, with titles, tiling and broadcast checkboxes (broadcast itself always starts off)
- Recent sessions in the File menu, the new-tab menu and the welcome screen
- Automatic reconnect when a connection drops, with back-off and a Stop button
- Anti-idle: send a keystroke after a quiet spell so devices with exec-timeouts don't log you out
- Session manager: new folders (including empty ones), multi-select, drag-and-drop between folders, inline rename (F2), Move to, Copy address, Connect all in tiles, and a port LED on every open session
- Drag sessions from the tree onto the tab area to open them
- Per-session terminal color scheme, with a live preview
- Clone tab (Ctrl+Shift+D), Close tabs to the right, Disconnect all, Reconnect all closed tabs, Reset terminal
- Button bar: right-click a button to edit, move or delete it (with Undo), or add one with +
- Keyboard shortcuts sheet (F1), quick reference for address formats and send-string escapes, About
- Confirmation before quitting with connected tabs
- Full screen (F11) and F10 to reach the menu bar
- Tether reopens at the size and place it was closed, maximized if it was; a window left on a monitor that's no longer plugged in opens centered instead
- The taskbar button flashes when a background tab rings the bell or drops its connection
- Ctrl+Insert copies and Shift+Insert pastes everywhere, the Windows convention
- Tap Alt to reach the menu bar, then a menu's underlined letter to open it (Alt, F for File), as in other Windows apps. Alt with a letter still goes to the device as Meta
- The Menu key and Shift+F10 open the context menu of whatever has focus: the terminal, a tab, a session or folder in the tree. In the terminal the Menu key always opens the menu, even with right-click paste on
- Windows High Contrast themes: selection and focus use the system colors, and the port LEDs keep their colors
- A shell picker for local-shell sessions and an "Other shells" menu, listing the shells found on this computer: PowerShell 7, Windows PowerShell, Command Prompt, each WSL distribution and Git Bash on Windows; the shells in /etc/shells elsewhere. Local tabs are named after their shell

### Fixed
- Windows: dragging sessions between folders, reordering tabs and dragging a session onto the tab area work (they did nothing before)
- Windows: F5, Ctrl+R and other browser keys no longer reload the window, which dropped every connection; Ctrl+P, Ctrl+F and F7 no longer open browser features
- Right-clicking anywhere without a menu of its own no longer shows the web engine's Back/Reload/Print menu
- Dropping a file on the window no longer replaces Tether with the file
- Local shells whose path has spaces in it (`C:\Program Files\Git\bin\bash.exe`) start; quote the path, or paste it bare

### Changed
- Windows: the title bar follows Tether's light or dark theme, scrollbars are the thin Windows 11 overlay kind, and the browser's form suggestions no longer drop down under host and user fields
- Windows: menus use Windows 11 proportions
- The window appears once it's drawn, instead of flashing white on launch
- The installer lists a publisher, copyright and homepage
- Session options and Settings use a category list instead of tabs, and gained Appearance, Logging and Advanced pages
- Every connection state is shown in a banner above the terminal: connecting, failed (with Try again and Edit session), dropped (with Reconnect) and waiting to reconnect
- The multi-line paste dialog says which device or how many tabs the paste is going to, and warns in amber while broadcasting
- While broadcasting, every pane that receives typing is outlined in amber
- Credential prompts appear one at a time and bring their tab forward when many tabs connect at once
- The command window shows where it sends and can switch to broadcasting with a click
- A session's button bar now switches in when its tab comes to the front
- Command palette results are ranked, so close matches come first
- Release builds are optimized for size (link-time optimization, stripped symbols): the app binary is about a third of its former size

## 0.1.0 — 2026-10-19

First release.

- SSH with password, keyboard-interactive and public-key auth (including encrypted keys), jump hosts, a per-session legacy algorithm switch, and strict host-key checking
- Telnet with window-size and terminal-type negotiation, raw TCP, serial consoles with port detection and break, and local shells
- Session tree with folders, filter, color tags and notes; sessions stored as one TOML file each
- Quick connect for typed targets such as `admin@10.0.0.1:2222`, `COM3 9600` and `telnet ts1 2003`
- Broadcast typing to checked tabs, tiled view, button bars, command bar, and login commands
- Keyword highlighting that decorates output without altering it, with a network-gear rule set
- Session logging (plain or raw, timestamps, file name templates), find in scrollback, multi-line paste confirmation
- Passwords stored in the OS keychain
- Command palette, light/dark interface, seven terminal color schemes
- SecureCRT session importer
