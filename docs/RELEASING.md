# Releasing Tether

Releases are built by GitHub Actions. You never build installers by hand.

## Every release

1. Make sure `main` is green on the Actions tab.
2. Bump the version everywhere at once:
   ```sh
   node scripts/bump-version.mjs 0.2.0
   ```
3. In `CHANGELOG.md`, rename `## Unreleased` to `## 0.2.0 — YYYY-MM-DD` and add a fresh empty `## Unreleased` above it.
4. Commit and tag:
   ```sh
   git add -A
   git commit -m "Release 0.2.0"
   git tag v0.2.0
   git push origin main v0.2.0
   ```
5. Watch **Actions → Build**. In about 15–20 minutes it creates a **draft** release named "Tether v0.2.0" with installers for Windows, macOS and Linux attached.
6. Open **Releases**, check the draft, paste the changelog section into the notes, and click **Publish release**.

People download from `https://github.com/<you>/tether/releases/latest`.

## Version numbers

- `0.x.y` while things are still moving. Bump the minor (`0.2.0`) for features, the patch (`0.2.1`) for fixes.
- Go to `1.0.0` when it can fully replace SecureCRT for daily work.

## If a release build fails

Open the failed job in Actions and read the first red error. Fix it on `main`, then move the tag:

```sh
git tag -d v0.2.0
git push origin :refs/tags/v0.2.0
git tag v0.2.0
git push origin v0.2.0
```

Delete the half-made draft release first if one was created.

## Unsigned builds

Installers are not code-signed yet, so:
- **Windows** SmartScreen says "Windows protected your PC". Click *More info → Run anyway*.
- **macOS** says the app can't be opened. Right-click it → *Open*, or run `xattr -dr com.apple.quarantine /Applications/Tether.app`.

Signing (a Windows code-signing certificate and an Apple Developer ID) removes these warnings and is needed for auto-update; it's on the roadmap.
