# HyperShield release center

The desktop client's top-bar version button opens **Updates & versions**. It manages two products independently:

| Product | Canonical release source | Linux package | Windows package | macOS package |
| --- | --- | --- | --- | --- |
| Hyperion engine | [`saintromuald/hyperion-public`](https://github.com/saintromuald/hyperion-public) | Public Shield `.tar.gz`, or the raw executable and SDL library from older releases | Public Shield x64 ZIP | Public Shield ARM64 ZIP |
| HyperShield client | [`saintromuald/ShieldBattery`](https://github.com/saintromuald/ShieldBattery) | Versioned `HyperShield-*-x86_64.AppImage` (and ARM64 when published) | NSIS through electron-updater | Versioned `HyperShield-*-arm64-mac.zip` |

No mirror is configured at present. The catalog code accepts multiple release sources; a mirror should be added only when it serves the same public, game-data-free packages and verifiable checksums.

## Channels and switching

- GitHub's **prerelease** flag determines the prerelease channel. A `-beta` suffix alone does not determine the channel, so promoting a release does not change its identity.
- The release browser defaults to **All versions** and paginates through the complete public GitHub release history. Stable/prerelease filters and search do not remove anything from the stored catalog.
- **Update to latest** refreshes the selected channel, installs its newest compatible package, and tracks future updates.
- Installing or switching to a specific release pins it. Automatic updates then pause for that product until **Track latest** is selected.
- Hyperion installs are side-by-side. The version bundled with the client remains available through **Use bundled version** even when it has no corresponding GitHub release.
- New installations stay pinned to the compatibility-tested bundled Hyperion with automatic engine updates disabled. Replacing that engine requires an explicit release installation or **Update to latest**.
- HyperShield AppImages and Mac app ZIPs are staged side-by-side and require an explicit **Restart & switch**. The app never restarts itself for an update.
- Releases without a package for the current platform or architecture remain visible with an explanation. Older Hyperion versions can also fail the compatibility probe for current matchmaking.

Downloads require and are checked against GitHub's published SHA-256 digest. Hyperion archives reject links, path traversal, Hyperion Zero Private packages, bundled game data, and native binaries for the wrong platform. The only permitted Pluto integration files are `Data/pluto/pluto-bridge.exe`, `COPYING.BWAPI`, and `SOURCE.BWAPI.txt`; official `pluto.dll`, `pluto_infer.exe`, and `pluto_weights.bin` payloads are rejected by basename anywhere in the package. Preferences, catalogs, and installations live under the client's user-data directory in `release-center/`; cached catalogs remain browsable offline.

## Pluto runtime is a release blocker

Pluto AI must be functional in every HyperShield and Hyperion Shield Zero release and
prerelease. Never ship a selectable Pluto level without the means to start its brain, and never
treat native integration scenarios alone as installed-package verification.

Until Pluto's author grants redistribution permission, do not bundle or mirror the
closed-source DLL, inference executable, or weights. Both applications must offer a prominent
first-run **Download Pluto AI** button and a later repair action. The installer downloads
`https://github.com/tscmoo/pluto/releases/download/v2.0/pluto-v2.0.zip`, verifies the archive and
its three payloads against the official hashes. Standalone Hyperion Shield Zero installs them in
`Data/pluto`; HyperShield installs them in `pluto` under the per-user Hyperion data directory
passed with `--data` (normally `<userData>/hyperion/pluto`, with the session suffix when present),
never in the packaged working directory or an AppImage's ephemeral extraction directory.
Hyperion's own bridge belongs in every package. If redistribution permission is later granted,
include the complete runtime directly instead.

Redistribution permission is tracked at
https://github.com/saintromuald/hyperion-public/issues/1; silence is not permission.

Before publishing either channel, run a real packaged-engine Pluto match and a two-client
multiplayer match with a Pluto slot. Confirm one authoritative inference owner, deterministic
commands on every peer, consistent results, valid replays, and clean shutdown.

## Publish Hyperion

Run **Hyperion Shield Zero release** in `saintromuald/hyperion-public` with a unique `hyperion-shield-zero-vX.Y.Z...` tag and either channel. Attach only public Shield packages. Do not attach Hyperion Zero Private or any `Game/` directory. A HyperShield Mac build requires that exact release's `Hyperion-Shield-Zero-<version>-mac-arm64.zip` asset.

## Publish HyperShield

1. Set the same new version in `package.json` and `app/package.json`.
2. Publish the Hyperion Shield Zero release that the client should bundle, including every target platform's package.
3. Run **HyperShield desktop release** in `saintromuald/ShieldBattery` with:
   - a unique `hypershield-vX.Y.Z...` tag matching both package versions;
   - the Hyperion tag;
   - the server URL to embed;
   - the stable or prerelease channel.
4. Test the exact AppImage, then switch an installation to it through the release center.
5. On Apple Silicon, test the exact DMG and staged ZIP, native engine launch, matchmaking, results, and replays before considering the platform runtime verified.

The workflow refuses to replace an existing tag. Its Linux job creates the release, and its Apple Silicon job attaches the tested DMG, ZIP, and `latest-mac.yml` to that same release without replacing assets. This keeps a release ID immutable for clients that already installed it. Publishing a prerelease does not change the stable channel; promoting it later changes only its channel flag.

## Windows builds and updates

Windows Hyperion packages are public Shield ZIPs named `Hyperion-Shield-Zero-<version>-windows-x64.zip`, containing `Hyperion.exe`, `SDL3.dll`, public engine data, and release metadata without StarCraft game files. The release center validates their SHA-256 digest and PE32+ AMD64 executables before installation.

Run **HyperShield Windows build** to produce an unsigned NSIS installer and `latest.yml` as unpublished workflow artifacts. The workflow deliberately has no release-publication step. Test the exact installer, native engine launch, matchmaking, results, and replays before publishing it.

Windows client updates use HyperShield's own `public/app/` feed in the `angelicgaming-hypershield-files` bucket, configured by `APP_UPDATE_URL` in `app/branding.ts`. They do not use ShieldBattery's CDN, signing identity, or update service. Upload the tested installer and its matching `latest.yml` to both `public/app/` and the bucket's root `app/` prefix. The client checks the first prefix; the website's `/published_artifacts/win/HyperShield-Setup.exe` redirect reads the second. The legacy `/published_artifacts/win/ShieldBattery.latest.exe` URL remains available for previously shared links.

## Apple Silicon macOS packages and updates

The Mac build targets Apple Silicon only and requires macOS 13 or later. The public Hyperion ZIP is extracted from its single wrapper directory without changing the engine layout: `Hyperion.app/Contents/MacOS/Hyperion` and `libSDL3.0.dylib` remain inside the engine app, while `Data`, release metadata, and documentation remain beside `Hyperion.app`. The package checker requires thin ARM64 Mach-O executables and libraries and rejects links and foreign executables in the engine resources.

HyperShield is **ad-hoc signed and not notarized**. No Developer ID identity is configured. The ARM64 fuse update triggers a fresh ad-hoc signature, and the final app, its helpers, and nested Hyperion app are verified during the Mac build. macOS may therefore require an explicit Gatekeeper approval for HyperShield; this is not an Apple-notarized distribution.

Mac HyperShield updates use the release center's verified GitHub ZIP staging and explicit restart flow. `latest-mac.yml` is generated and published alongside the standard Electron Builder ZIP, but the app does not query electron-updater on macOS. The Windows-only NSIS feed is never configured or queried by Mac and Linux builds.

The macOS CI job verifies final ad-hoc signatures and smoke-tests the exact generated release ZIP, including framework links and helper permissions, then repeats startup from an app copied out of the mounted DMG. It covers the native SQLite module, replay-parser WASM loading, replay worker calls, and the packaged Hyperion `--sb-identity` protocol. These checks require the Apple Silicon macOS runner and do not replace live game, matchmaking, result, replay, or Pluto integration testing. Gatekeeper approval still requires testing a quarantined download; locally generated CI artifacts do not reproduce that decision.

## Platform status

- **Linux x86-64:** shipped and verified.
- **Windows x64:** shipped and independently verified as a prerelease. The NSIS installer and Hyperion ZIP are published with 600-turn, result, replay, per-user install, and live update-feed checks.
- **macOS Apple Silicon:** packaging and native installation supported; release workflow smoke checks run on macOS CI. Full gameplay and any Pluto bridge behavior still require Apple Silicon runtime verification.
- **macOS Intel:** not supported by these packages.
