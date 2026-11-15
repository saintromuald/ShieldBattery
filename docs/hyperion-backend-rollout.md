# Hyperion backend selection and rollout

This document describes the implemented server-selected gameplay backend policy and the evidence
required to enable each production stage. Hyperion-first is the requested policy for newly formed
live games. The production rollout default is currently `canonical`, not `default`, because the full
multi-platform/rehome/full-stack acceptance evidence is not yet complete.

## Selection model

Every new formation resolves one versioned `ResolvedGameplayRouting` before game registration and
before any coordinator/relay session is created. The object is stored in the server-owned `games.config`
JSONB record and distributed unchanged in each participant's `GameSetup`. Formation fingerprints include
capability inputs and any already-resolved routing, so a same-ID retry cannot silently change engine,
rules, profile, transport, simulation, or replay identity.

The model distinguishes:

- requested policy: `hyperionFirst` or whole-formation `scrCompatibility`;
- actual backend: `hyperion` or `scr`;
- exact rules/mutators: Classic, Hyperion QoL, or Hyperion QoL with `antiMeta: 1`;
- native adapter/capability profile and machine-readable selection reason;
- transport: `localOnly` or `netcodeV2`;
- simulation: `lockstep` or `rollback`;
- recording format/playback backend: SC:R/SC:R, native Classic `reRS`/Hyperion, or `hxRS`/Hyperion;
- optional diagnostic `shadowBackend`, used only by shadow rollout.

Historical records are not rewritten. Missing routing means Hyperion only for the legacy Hyperion
matchmaking variants; every other legacy game remains SC:R. GraphQL exposes the stored routing and an
`effectiveBackend` resolver with the same historical rule.

## Capability and fallback matrix

| Formation                                                                                                                                                                          | Required selection                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Hyperion Rule 1/Rule 2 supported formats                                                                                                                                           | Hyperion is mandatory with exact QoL/anti-meta semantics. Rule 3 remains disabled.                                                        |
| Ordinary matchmaking with a canonical shape and matching capabilities                                                                                                              | Hyperion preferred with explicitly resolved **Classic** rules. Matchmaking IDs, MMR, divisions, map pools, and preferences are unchanged. |
| Custom lobby with the same canonical shape and no unsupported options                                                                                                              | Hyperion preferred with the lobby's resolved rules/options preserved.                                                                     |
| Custom Melee/FFA with at least two humans and exactly one explicit Pluto computer, locked alliances, and `plutoComputer` on every participant | Hyperion is required. The authoritative host alone needs the verified runtime; guests receive the same AI-owned commands without installing Pluto. |
| UMS, Classic computers, observers, unsupported Melee/FFA or team layouts, unlocked alliances, arbitrary/open slots, EUD or unsupported maps/mods, rollback-only, or local-only games | Whole-session SC:R compatibility while native support is absent, provided every participant can use SC:R. |
| Hyperion-only rules/mutators when native play is unavailable or incompatible                                                                                                       | Reject/requeue before registration with `hyperionOnly`; never fall back to different gameplay.                                            |
| No backend capable of preserving semantics for every participant                                                                                                                   | Reject/requeue before registration with an actionable reason.                                                                             |
| Replay playback                                                                                                                                                                    | Selected from exact recording magic and compatibility. Unmarked historical recordings remain SC:R; `hxRS` never routes to SC:R.           |

Canonical native formations currently require all-human 1v1, 2v2, or 3v3; subtype 0 or 2/3; exactly
2/4/6 participants; locked alliances; canonical host/team mapping; authenticated SCM/SCX map bytes;
Fastest; lockstep; and Classic without mutators, Hyperion QoL without mutators, or Hyperion QoL with
exactly `antiMeta: 1`. Unsupported configurations are routed before process launch rather than
partially translated by the C++ parser.

A Pluto custom formation is the deliberate exception to the all-human canonical shape. Its human
relay roster stays authenticated, while one AI slot uses the first free native player ID, carries no
user ID or credentials, and records `userId: null` in results. The launch fixes one human inference
owner and rejects extra Pluto slots. Open/closed map seats that are not participants do not enter the
manifest. Adding Pluto explicitly locks Melee alliances and must not silently downgrade to Classic
when the map or layout changes.

### Participant compatibility requirements

The following must match exactly across all native participants:

- client capability protocol and native adapter protocol;
- engine build and simulation revision;
- rules-relevant mod ID and mod/data fingerprints;
- every native feature required by the resolved rules.

Platform/architecture and executable SHA-256 may differ in a supported Windows/Linux mixed session.
Each seat independently retains the exact executable snapshot advertised at queue/join time. Launch
revalidation compares that snapshot and the formation profile; an update, corrupted pinned install,
or identity drift fails the whole load with a requeueable error rather than substituting an engine.

Legacy clients without capability records may use SC:R for ordinary formations. Hyperion-only
formations reject them before registration. New clients must declare SC:R availability independently;
valid Hyperion CASC/MPQ data does not prove SC:R compatibility, and SC:R health does not prove native
compatibility.

## Protocol, schema, and generated artifacts

- `games.config` stores `requestedBackendPolicy`, `requestedRules`, and `gameplay` in JSONB. No SQL
  migration is needed for these optional fields; old rows keep their meaning.
- Queue/lobby network metadata carries bounded, versioned, non-secret capabilities. They never enter
  peer-editable lobby slots or the Rust matchmaker's queue/MMR models.
- `GameSetup.gameplay` is the explicit Electron routing input. Old-server behavior is retained for
  legacy Hyperion variants and unmarked SC:R recordings.
- `server-rs/src/games.rs` defines the typed routing objects and historical effective-backend resolver.
  `schema.graphql`, `client/gql/`, and `client/gql/schema.json` are generated, not hand-edited.
- The local replay index is at SQLite schema version 10 with `replay_format` defaulting to `scr`.
  Existing bookmarks/playlists are retained; parse-error rows are reparsed for native metadata.
- Native launch/probe environments remove inherited result/development/control credentials. Only an
  eligible tracked human seat receives its result code and the non-secret server URL used for rehome.

## Rollout controls

`SB_HYPERION_ROLLOUT` accepts:

| Stage           | Behavior                                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `compatibility` | Negotiate capabilities while preserving ordinary SC:R routing. Existing Hyperion-branded modes remain native.                      |
| `shadow`        | Record `shadowBackend: hyperion` for eligible ordinary formations but still launch SC:R.                                           |
| `canonical`     | Run only the existing Hyperion-branded canonical modes natively. This is the production-safe default while evidence is incomplete. |
| `matchmaking`   | Also prefer Hyperion for supported ordinary matchmaking.                                                                           |
| `default`       | Prefer Hyperion for every supported live formation, including supported custom lobbies.                                            |

Two independent kill switches are evaluated per formation:

- `SB_HYPERION_FIRST_ENABLED=false` prevents new Hyperion-first expansion.
- `SB_HYPERION_SCR_COMPATIBILITY_ENABLED=false` prevents compatibility fallback and produces an
  actionable failure when Hyperion cannot be used.

`/config` advertises `hyperionRollout` and `hyperionFirstEnabled`. Clients use these values to keep
native-only ordinary matchmaking behind `matchmaking`/`default`, and native-only custom-lobby
creation/joining behind `default`; older servers without these fields retain SC:R gating. Restart the
backend and reconnect/reload clients when changing rollout controls so formation policy and the UI
advertisement agree.

Hyperion remains lockstep even when `SB_RP2_ROLLBACK=true`.

### Operator rollout sequence

1. Deploy backend-aware clients with pinned engines and automatic engine updates disabled. Do not
   change queue/MMR policy.
2. Use `compatibility` to exercise negotiation with old clients and confirm historical records.
3. Use `shadow`; inspect persisted `backend`, `shadowBackend`, `reason`, `rules`, and `nativeProfile`.
4. Enable `canonical` for Rule 1/Rule 2 modes and verify raw-v2 results, ratings, departures, replay
   files, reconnect, and rehome on real relays.
5. Enable `matchmaking` for validated ordinary canonical matchmaking.
6. Enable `default` for supported custom lobbies after the complete packaged-artifact acceptance
   matrix passes on Windows x64, Linux x64, and a mixed Windows/Linux session.
7. Roll back one stage at a time. For an immediate stop, set `SB_HYPERION_ROLLOUT=compatibility` and
   `SB_HYPERION_FIRST_ENABLED=false`. Compatibility fallback remains available unless separately
   disabled. Do not change a formation's backend after registration; cancel/requeue instead.

## Replay and network recovery policy

Native QoL/anti-meta recordings use `hxRS`; native Classic recordings use classic `reRS` with
Hyperion playback. Both are preserved locally under an immutable game-ID filename with a non-secret
sidecar carrying backend, rules/profile, seed, and map identity. Native playback validates
compatibility in Hyperion and never receives live-game result credentials or development controls.
Upload remains disabled for both formats: local BroodRep compatibility parsing is not server
attestation and does not prove map/roster/rules/simulation identity or server-confirmed linkage.
Existing SC:R recording, playback, upload, and seed-mismatch behavior is unchanged.

The native bridge has a ShieldBattery-mediated rehome provider using the same authenticated endpoint
as SC:R, with bounded requests and replacement-certificate pinning. Same-relay reconnect remains a
separate case. Production default-on requires a real multi-relay rehome acceptance run; provider unit
and loopback tests alone are not sufficient evidence.

## Acceptance and release evidence

Use authorized player-owned game data only in private/manual test infrastructure. Do not publish Hyperion Zero Private,
launch files, tokens, private keys, result codes, credentials, or acceptance artifacts. Exact commands
and hashes belong in a private evidence record; public reports should contain only versions, digests,
and outcomes.

The release checks require published SHA-256 digests on every asset, native `Data` on Linux and
Windows, immutable release identities, and digest verification before extraction in build workflows.
Current `Hyperion-Shield-Zero-*`, former `Hyperion-Shield-*`, and historical
`HyperShield-Shield-*` names are accepted without rewriting old releases.

### Acceptance evidence recorded on 2026-11-14

All gameplay used isolated local services and authorized player-owned game data. These results do not
change production routing or publish an artifact; production remains `canonical`.

- HyperShield: 5,810 unit tests, lint, formatting, typecheck, and GraphQL generation passed.
  Server-rs passed 141 tests. Rally Point passed 958 tests with 2 intentionally ignored, and Clippy
  passed with warnings denied. Hyperion's notes, catalog, HUD, map, and mod checks passed.
- Fixed native Windows and Linux engines passed Classic and Rule 1/Rule 2 1v1, 2v2, and 3v3. Every
  seat read 600 identical meaningful-input turns, produced validated raw-v2 results and clean
  departures, and wrote a valid per-seat recording. Hard-drop recovery and all five parser negatives
  also passed on both platforms. A separate 6,000-turn Rule 1 soak passed.
- Windows/Linux mixed sessions passed in both host directions, with 600 identical turns, reconciled
  results, clean departures, and per-seat Classic recordings in each direction. The canonical lobby
  provider retains the remote host seed and emits keepalives until native lobby state 8, so a slow
  guest cannot consume and lose the record before native can accept it.
- An isolated full-stack Rule 1 match recorded reconciled win/loss and rating changes of +162.3109
  and -162.3109. Matchmaking IDs, rating policy, and queue structures were not changed.
- The final local AppImage completed a Classic game with a real relay-7-to-relay-8 replacement,
  resumed identical gameplay, recorded win/loss and clean departures, persisted both recordings and
  sidecars, and played the immutable recording locally without live-game or development credentials.
  AppImage SHA-256: `0ffa0039dfce097f6de63302da55abc173692a00c47e2af6d8494af8585075d5`.
- The unsigned local Windows installer passed update-metadata, blockmap, resource, and architecture
  checks, including both x86 and x64 game DLLs. Installer SHA-256:
  `b90255fcb77d7a10cdc45ce141c39d392cd8beaeb5470deafa4818708387aad3`.
- Fixed public Shield packages contain no game data. Windows ZIP SHA-256:
  `ffedbdecdc1039c79affa2fd08ea5019019558b49c4e58cb20eb3f7b152ca29e`; Linux tar.gz SHA-256:
  `54c422a78a6f619e6cca8d57b8136fde04bfdf96473ac4d08db68713f69ae5f2`. The corresponding native
  engine SHA-256 values are `cfd58b822eb28f150a052ba34df9561751e3ded220be4c28e2881b5a1ffa1567`
  (Windows) and `673952b85c4319bdd2ebce29d8df4135d627544b0690765240861edb77adda06` (Linux).

Before enabling `default`, record:

- ordinary 1v1 and Rule 1/Rule 2 1v1/2v2/3v3 on Windows and Linux, including mixed OS;
- every seat reaching the target with every other seat's deterministic trace for 600 meaningful turns
  and a longer soak, using real wide selection/order input;
- real HyperShield registration, raw-v2 results, reconciliation, ratings, departures, drops,
  reconnect, and a real multi-relay rehome;
- per-seat replay files and playback validation before any upload consideration;
- SC:R compatibility categories on Windows, including both DLL architectures;
- exact public Hyperion Shield Zero and HyperShield installer/AppImage versions/hashes, with no proprietary
  game data or secrets in logs/packages.

The production rollout must remain at `canonical` while any of those checks is missing or failing.
