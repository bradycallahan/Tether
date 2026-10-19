#!/usr/bin/env node
// Set Tether's version everywhere it lives: package.json, src-tauri/Cargo.toml,
// src-tauri/tauri.conf.json (and Cargo.lock / package-lock.json if present).
// Usage: node scripts/bump-version.mjs 0.2.0

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
  console.error("Usage: node scripts/bump-version.mjs <major.minor.patch>");
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const edit = (rel, fn) => {
  const path = join(root, rel);
  if (!existsSync(path)) return;
  const before = readFileSync(path, "utf8");
  const after = fn(before);
  if (after === before) throw new Error(`${rel}: version field not found`);
  writeFileSync(path, after);
  console.log(`updated ${rel}`);
};

edit("package.json", (t) => t.replace(/"version":\s*"[^"]+"/, `"version": "${version}"`));
edit("package-lock.json", (t) => t.replace(/("name":\s*"tether",\s*"version":\s*)"[^"]+"/g, `$1"${version}"`));
edit("src-tauri/tauri.conf.json", (t) => t.replace(/"version":\s*"[^"]+"/, `"version": "${version}"`));
edit("src-tauri/Cargo.toml", (t) => t.replace(/^version = "[^"]+"/m, `version = "${version}"`));
edit("src-tauri/Cargo.lock", (t) => t.replace(/(name = "tether"\nversion = )"[^"]+"/, `$1"${version}"`));

console.log(`\nTether is now ${version}. Next: update CHANGELOG.md, commit, then:\n  git tag v${version} && git push origin main v${version}`);
