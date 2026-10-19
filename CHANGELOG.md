# Changelog

All notable changes to Tether are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/), and versions follow [semantic versioning](https://semver.org/).

## Unreleased

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
