# Changelog

All notable changes to Tether are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/), and versions follow [semantic versioning](https://semver.org/).

## Unreleased

### Added
- Files pane for SSH tabs (Session > Files (SFTP), Ctrl+Shift+X, or Files on the toolbar): browse the device's folders beside the terminal, upload with the Upload button or by dropping files and folders from your desktop onto the pane (or onto a folder in it), download with Enter or a double-click, and create, rename (F2) and delete (Del) files and folders. It uses the tab's own connection, so there's no second login, and transfers show progress and speed and can be cancelled. Tether asks before replacing a file, never leaves half-downloaded files behind, and reopens the pane at the same folder next time

## 0.3.0 — 2026-10-21

### Added
- Tether reopens at the size and place it was closed, maximized if it was; a window left on a monitor that's no longer plugged in opens centered instead
- The taskbar button flashes when a background tab rings the bell or drops its connection
- Ctrl+Insert copies and Shift+Insert pastes everywhere, the Windows convention
- Tap Alt to reach the menu bar, then a menu's underlined letter to open it (Alt, F for File), as in other Windows apps. Alt with a letter still goes to the device as Meta
- The Menu key and Shift+F10 open the context menu of whatever has focus: the terminal, a tab, a session or folder in the tree. In the terminal the Menu key always opens the menu, even with right-click paste on
- Windows High Contrast themes: selection and focus use the system colors, and the port LEDs keep their colors
- Shift+click a button-bar button to send it to every connected tab, after a confirmation naming how many
- A second tab to the same device is titled "core-sw1 (2)"
- Ctrl+F4 closes the tab, as in other Windows apps
- The command window takes several lines: Ctrl+Enter adds a line, and each line is sent with its own Enter
- View > Always on top
- Windows: right-click Tether on the taskbar for your recent sessions
- Windows installer: shows the license and Tether's own artwork, and installs for the current user without an admin prompt
- Opening Tether again brings the running window forward instead of starting a second copy
- `tether --session "Folder/name"` opens a saved session, and `tether ssh://admin@10.0.0.1` opens an address (in the running window if Tether is already open)
- Settings > Files can offer Tether for ssh:// and telnet:// links, so links in browsers and tickets open a tab. A link to a saved device uses that session. On Windows, Tether registers itself the standard way, so it appears in Default apps and the "Select an app" picker, and other apps' link settings are left alone. The uninstaller removes the registration
- Windows taskbar jump list: Quick connect, Local shell and your recent sessions (recent sessions follow Windows' "Show recently opened items" privacy setting)
- Optional master passphrase: saved passwords, key passphrases and enable passwords are encrypted with a passphrase only you know (Argon2id and AES-256-GCM, in `vault.toml`), and Tether asks for it at startup. It's offered once on first run, and can be set, changed or removed under Settings > Security (changing or removing it asks for the current passphrase, even while unlocked). Without one, saved passwords stay in the system credential store as before
- Session options, New session, Quick connect, Settings, button bar and keyword highlighting editors open in their own windows, which stay above the main window like SecureCRT's dialogs
- The window title says when the tab in front isn't connected ("core-sw1 (Not connected) - Tether"), so it shows on the taskbar and in Alt+Tab
- Windows 11: the title bar takes the app's own chrome color in both themes, so it no longer looks like a separate strip
- A shell picker for local-shell sessions and an "Other shells" menu, listing the shells found on this computer: PowerShell 7, Windows PowerShell, Command Prompt, each WSL distribution and Git Bash on Windows; the shells in /etc/shells elsewhere. Local tabs are named after their shell

### Fixed
- Closing Tether while maximized no longer makes the maximized size its normal size; un-maximizing after a restart goes back to the size you had
- Dragging the last session out of a folder no longer makes the folder disappear
- At narrow window sizes the session manager gives up width so the terminal stays usable
- Windows: dragging sessions between folders, reordering tabs and dragging a session onto the tab area work (they did nothing before)
- Windows: F5, Ctrl+R and other browser keys no longer reload the window, which dropped every connection; Ctrl+P, Ctrl+F and F7 no longer open browser features
- Right-clicking anywhere without a menu of its own no longer shows the web engine's Back/Reload/Print menu
- Dropping a file on the window no longer replaces Tether with the file
- Local shells whose path has spaces in it (`C:\Program Files\Git\bin\bash.exe`) start; quote the path, or paste it bare

### Changed
- Connection failures say what happened in plain words ("Nothing answered on 10.0.0.1 port 2222…", "Couldn't find sw1…") instead of the raw operating-system message
- Windows: the title bar follows Tether's light or dark theme, scrollbars are the thin Windows 11 overlay kind, and the browser's form suggestions no longer drop down under host and user fields
- The button bar starts hidden on new installs; turn it on from View > Button bar
- Windows: menus use Windows 11 proportions
- The window appears once it's drawn, instead of flashing white on launch
- The installer lists a publisher, copyright and homepage

## 0.2.0 — 2026-10-20

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

### Changed
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
