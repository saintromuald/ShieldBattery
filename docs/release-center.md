# HyperShield release center

The desktop client's top-bar version button opens **Updates & versions**. It manages two products independently:

| Product | Canonical release source | Linux package |
| --- | --- | --- |
| Hyperion engine | [`saintromuald/hyperion-public`](https://github.com/saintromuald/hyperion-public) | Public Shield `.tar.gz`, or the raw executable and SDL library from older releases |
| HyperShield client | [`saintromuald/ShieldBattery`](https://github.com/saintromuald/ShieldBattery) | Versioned `HyperShield-*-x86_64.AppImage` (and ARM64 when published) |

No mirror is configured at present. The catalog code accepts multiple release sources; a mirror should be added only when it serves the same public, game-data-free packages and verifiable checksums.

## Channels and switching

- GitHub's **prerelease** flag determines the prerelease channel. A `-beta` suffix alone does not determine the channel, so promoting a release does not change its identity.
- The release browser defaults to **All versions** and paginates through the complete public GitHub release history. Stable/prerelease filters and search do not remove anything from the stored catalog.
- **Update to latest** refreshes the selected channel, installs its newest compatible package, and tracks future updates.
- Installing or switching to a specific release pins it. Automatic updates then pause for that product until **Track latest** is selected.
- Hyperion installs are side-by-side. The version bundled with the client remains available through **Use bundled version** even when it has no corresponding GitHub release.
- New installations stay pinned to the compatibility-tested bundled Hyperion with automatic engine updates disabled. Replacing that engine requires an explicit release installation or **Update to latest**.
- HyperShield AppImages are staged side-by-side and require an explicit **Restart & switch**. The app never restarts itself for an update.
- Releases without a package for the current Linux architecture remain visible with an explanation. Older Hyperion versions can also fail the compatibility probe for current matchmaking.

Downloads are checked against GitHub's published SHA-256 digest when present. Hyperion archives reject links, path traversal, Zero packages, and bundled game data. Preferences, catalogs, and installations live under the client's user-data directory in `release-center/`; cached catalogs remain browsable offline.

## Publish Hyperion

Run **Hyperion Shield release** in `saintromuald/hyperion-public` with a unique `hyperion-shield-vX.Y.Z...` tag and either channel. Attach only public Shield packages. Do not attach Hyperion Zero or any `Game/` directory.

## Publish HyperShield

1. Set the same new version in `package.json` and `app/package.json`.
2. Publish the Hyperion Shield release that the client should bundle.
3. Run **HyperShield Linux release** in `saintromuald/ShieldBattery` with:
   - a unique `hypershield-vX.Y.Z...` tag matching both package versions;
   - the Hyperion tag;
   - the server URL to embed;
   - the stable or prerelease channel.
4. Test the exact AppImage, then switch an installation to it through the release center.

The workflow refuses to replace an existing tag and uploads the AppImage plus a `.sha256` file. This keeps a release ID immutable for clients that already installed it. Publishing a prerelease does not change the stable channel; promoting it later changes only its channel flag.

## Windows builds and updates

Windows Hyperion packages are public Shield ZIPs named `Hyperion-Shield-<version>-windows-x64.zip`, containing `Hyperion.exe`, `SDL3.dll`, public engine data, and release metadata without StarCraft game files. The release center validates their SHA-256 digest and PE32+ AMD64 executables before installation.

Run **HyperShield Windows build** to produce an unsigned NSIS installer and `latest.yml` as unpublished workflow artifacts. The workflow deliberately has no release-publication step. Test the exact installer, native engine launch, matchmaking, results, and replays before publishing it.

Windows client updates use HyperShield's own `public/app/` feed in the `angelicgaming-hypershield-files` bucket, configured by `APP_UPDATE_URL` in `app/branding.ts`. They do not use ShieldBattery's CDN, signing identity, or update service. Upload the tested installer and its matching `latest.yml` to both `public/app/` and the bucket's root `app/` prefix. The client checks the first prefix; the website's `/published_artifacts/win/ShieldBattery.latest.exe` redirect reads the second.

## Platform roadmap

- **Linux x86-64:** shipped and verified.
- **Windows x64:** shipped and independently verified as a prerelease. The NSIS installer and Hyperion ZIP are published with 600-turn, result, replay, per-user install, and live update-feed checks.
- **macOS Apple Silicon and Intel:** planned. Requires a native Hyperion build and the same end-to-end compatibility checks.

Do not publish Windows or macOS packages as if they were simple repackaging tasks. They must only ship after the corresponding engine and native protocol work has been implemented and tested.
