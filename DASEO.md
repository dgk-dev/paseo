# Daseo

**Daseo** (= _Do all, seek eternal only_ · initials **dgk** + Paseo) is David-Daniel Kang's
personal fork of [Paseo](https://github.com/getpaseo/paseo), built and shipped as his own
Mac app and Android APK. Logo: **DΛ**.

This file is the fork's source of truth. Daseo is an independent product, not a tracking
fork: since 2026-09-06 it no longer merges upstream `main` wholesale. When asked to "apply
Paseo updates to Daseo", review upstream commits individually and adopt only those that
solve a real Daseo problem without a trade-off (see "Upstream adoption policy" below), keep
every delta listed below working, rebuild each changed platform from the task commit, and
update this file if the delta set or the adoption log changes.

## Identity

|              | Paseo (upstream)                 | Daseo (this fork)                                                       |
| ------------ | -------------------------------- | ----------------------------------------------------------------------- |
| Repo         | `getpaseo/paseo`                 | `dgk-dev/daseo`, branch `main`                                          |
| Mac app      | Paseo.app (App Store / releases) | `/Applications/Daseo.app`, stable locally signed Daseo SemVer build     |
| Android      | `sh.paseo` (Play)                | `sh.paseo.dgk` ("Daseo"), matching product SemVer, parallel-installable |
| Display name | Paseo                            | Daseo (display only)                                                    |

**Deliberately unchanged** to stay upstream-compatible and preserve state: internal
identifiers (`productName`, Electron userData path, `~/.paseo`, `paseo` CLI, Mac bundle IDs,
URL scheme `paseo://`), all i18n strings, and the design-system structure. The Android
personal variant is the deliberate exception: it uses `sh.paseo.dgk` for parallel install.

## Fork deltas (must survive upstream merges)

1. **Remote browser streaming to mobile** — daemon `BrowserStreamHub` fans CDP screencast
   frames (binary opcode `0x20`) from the Electron browser host to mobile watchers over the
   relay; tap/two-axis-scroll/text/key/navigate inputs map back through trusted CDP. CDP ACKs
   cap the producer at the mobile-requested frame interval, server backpressure preserves only
   the latest frame, and static/navigation fallback captures prevent a blank or stale first
   paint. Each pane has an independent viewer ID and workspace-scoped control path; hidden or
   backgrounded panes unsubscribe, frame sequence rejects stale delivery, and failed startup
   uses bounded backoff before exposing a manual Retry control while retaining the last frame.
   Feature flag `serverInfo.features.browserRemoteStream`. Key files:
   `packages/protocol/src/binary-frames/browser-stream.ts`,
   `packages/server/src/server/browser-tools/stream-hub.ts`,
   `packages/desktop/src/features/browser-automation/{screencast,stream-input}.ts`,
   `packages/app/src/desktop/browser/pane/index.tsx` and `remote-stream-retry.ts` (native viewer).
2. **Bidirectional browser workspace sync** — `browser.remote.open/list/close` RPCs let
   phones open real desktop tabs, continuously discover tabs created by Mac UI or agent
   browser tools, refresh URL/title/navigation/loading state, and close the authoritative
   Mac tab. The desktop workspace layout—not only currently mounted webviews—is the tab-list
   SSOT; listing materializes every persisted browser guest without parking the visible guest.
   Newly discovered browsers sit directly after the current mobile tab in host order. Desktop
   active-browser state seeds an otherwise empty mobile selection, but subsequent mobile tab
   choices remain local so background refresh cannot pull an open agent back to a browser. Mobile
   viewers reconcile on focus and every two seconds; transient disconnects or host hydration
   preserve local viewers. Workspace
   header ⋯ menu, tabs-row ∨ menu, and pinned globe launcher expose `New browser` when the feature
   flag is on. Key files: `packages/app/src/screens/workspace/workspace-screen.tsx`,
   `packages/app/src/desktop/browser/automation/handler.ts`, `resident-webviews.ts`, and
   `remote-tabs-sync.ts`.
3. **Rebranding (display-only)** — the sole DΛ geometry source is
   `packages/app/assets/brand/daseo-mark.svg`; `npm run brand:generate` deterministically owns
   the generated React Native path module plus native, PWA/status, notification, splash, macOS,
   Linux, and Windows image derivatives. `npm run brand:check`, the pre-commit hook, and desktop
   build reject manual drift. Android personal variant name "Daseo" (`packages/app/app.config.js`),
   Mac window-title display
   name (`packages/desktop/src/main.ts`), quiet theme-derived project fallback icons in
   `packages/app/src/components/project-icon-view.tsx` that reserve color for operational
   status, square graphite user prompt panels in `packages/app/src/components/message.tsx`, and
   a matching square Composer with a compact monochrome stop control in `packages/app/src/composer/`
   that preserves shared layout, touch targets, and readability. Packaging uses the safe post-build Info.plist patch at
   `packages/desktop/scripts/daseo-app-package.mjs` plus the outer `Daseo.app` rename. The patch
   keeps `CFBundleName=Paseo`; Electron uses that internal product name to locate the
   unchanged `Paseo Helper.app` bundles.
4. **Daseo theme** — monotone graphite dark variant registered in
   `packages/app/src/styles/theme.ts` (`darkDaseoTheme`) and selectable in appearance
   settings on desktop and mobile.
5. **Provider-neutral completed-turn disclosure** — completed turns show the user prompt and
   every provider-authored `final_answer`, while thought/tool/todo/activity/compaction and explicit
   `commentary` fold behind one expandable "Worked for …" row. The optional phase follows Codex's
   official `commentary | final_answer` contract through Pi/Codex live events, history, coalescing,
   protocol validation, canonical projection, replica cache, and rendering. Providers that never
   sign a phase (Claude through the Pi bridge) get `final_answer` derived from Pi's `stop`
   reason on the completed message, so an answer the model finished on its own stays visible
   when a queued follow-up (background fetch notification, steer) wakes it again in the same
   turn; `toolUse` narration stays phase-less and folds. Fully phase-less streams retain the
   legacy final-suffix fallback. Expansion restores the original stream items and order
   losslessly. Claude, Codex/ChatGPT, Grok-through-Pi, OpenCode, and other providers share the same
   UI contract; `blockGroupId` is used when available but never required. Active,
   partial/detached, permission-blocked, failed, and canceled turns stay open, while error and
   failed/canceled tool rows remain visible. Terminal outcomes survive canonical hydration, and
   provider message identity preserves manual expansion across renderer-row changes. A summary row
   never hides more of the answer than it leaves visible: a folded assistant message that is
   substantive on its own and longer than everything still on screen is revealed. That guard exists
   because phase metadata is only as good as its source — codex gets commentary/final_answer from
   the model, while pi derives it from stopReason, so an answer written just before one last tool
   call is untagged and would otherwise fold behind a two-line sign-off. The projection
   also spans the settled/live buffer boundary. Key files: `packages/protocol/src/agent-types.ts`,
   `packages/server/src/server/agent/providers/{codex-app-server-agent,pi/agent}.ts`,
   `packages/app/src/agent-stream/collapsed-work.ts`, `view.tsx`, `collapsed-work-row.tsx`, and
   `packages/app/src/types/stream.ts`.
6. **Independent Android push notifications** — the personal Android variant gets a native
   FCM device token instead of depending on upstream's Expo project; the Mac daemon sends
   agent-finished and permission-request notifications through FCM HTTP v1. Key files:
   `packages/app/src/push-notifications/internal/subscriptions.ts`,
   `packages/server/src/server/push/fcm-service.ts`, and `packages/app/app.config.js`.
   Runtime credentials are intentionally outside git: Android config at
   `packages/app/.secrets/google-services.personal.json`; sender service account at
   `~/.paseo/daseo-fcm-service-account.json` (mode 0600). Firebase project: `daseo-push`.
7. **Model/abort robustness patches** — replacement-model catalog probe skip, aborted-turn
   cancellation normalization (`packages/server/src/server/agent/provider-registry.ts`,
   `providers/pi/agent.ts`), send-gate fix and native combobox placement
   (`packages/app/src/provider-selection/provider-selection.ts`,
   `components/ui/combobox.tsx`).
8. **Fold- and CJK-safe mobile UX** — unfolded Fold/tablet sidebar controls stay above the
   Android navigation inset (`packages/app/src/components/left-sidebar.tsx`), while Markdown
   headings use token-proportional line heights plus full-width wrapping containers and a CJK
   keep-all leaf policy, so multi-line Korean and large-font text measures its complete height
   instead of clipping (`packages/app/src/styles/markdown-styles.ts` and
   `components/markdown/heading-style.ts`).
9. **Project-scoped empty workspace auto-create** — `/new` launched from a project creates an
   empty local workspace immediately, allowing browser/terminal use before an agent starts;
   global, worktree, unsupported-daemon, and failure paths retain the intro fallback. Archiving
   the active workspace never enters this creation path: Daseo selects an existing workspace in
   the same project or leaves the main pane empty when none remains. Key files:
   `packages/app/src/screens/new-workspace-auto-create.ts`, `new-workspace-screen.tsx`, and
   `packages/app/src/utils/workspace-archive-navigation.ts`.
10. **MCP era-negotiation compatibility** — MCP 2.x Pi clients probe with the forward-dated
    `server/discover` method before falling back to the bundled MCP 1.x SDK. Daseo recognizes
    that exact probe and returns the expected legacy signal without logging it as a daemon error;
    forward-dated `initialize` requests can still negotiate the daemon's latest supported version,
    while unknown established requests remain strict. Key files:
    `packages/server/src/server/agent-mcp-protocol.ts` and `bootstrap.ts`.
11. **Relay close-race hardening** — when a superseded mobile relay socket enters `CLOSING`
    between the send readiness check and callback, its final frame is dropped as normal disconnect
    control flow instead of surfacing a false daemon `Client error`. Failures on sockets that are
    still open remain strict. Key file: `packages/server/src/server/relay-transport.ts`.
12. **Provider-native active-turn steering** — ordinary prompts sent while a supported agent is
    running join that exact turn instead of canceling and replacing it. Codex uses `turn/steer`
    with the native expected turn id, Pi uses RPC `streamingBehavior: "steer"` and waits for
    `agent_settled`, and Claude pushes a priority-`next` SDK user message. Capability negotiation
    keeps unsupported or older providers on the queue/replacement fallback without model-specific
    branches. An active-turn command is durably admitted before the daemon waits for native steering,
    so Pi compaction never holds the client RPC open. Desktop and mobile keep every durably admitted
    prompt visible even if client liveness misclassified it as non-steering, reconcile receipts with
    bounded backoff, and reject interrupted receipts after daemon restart unless canonical history
    proves delivery. Pi cannot settle a turn while native steering acknowledgement is pending, and a
    terminal event racing after provider acknowledgement cannot discard the accepted prompt. Explicit
    queued messages and terminal rejections retain their recovery controls. Steering identity survives
    optimistic UI, canonical echo, cache, history, and completed-work folding, with a subtle
    user-message marker. Key files:
    `packages/server/src/server/{session,agent/agent-prompt,agent/agent-manager}.ts`,
    `packages/server/src/server/agent/providers/{codex-app-server-agent,claude/agent,pi/agent}.ts`,
    `packages/app/src/composer/`, `packages/app/src/runtime/host-runtime.ts`, and
    `packages/app/src/types/stream.ts`.
13. **Stable local macOS signing** — Mac builds must be signed with the login-keychain identity
    `Daseo Local Code Signing`, whose stable designated requirement preserves Accessibility,
    Screen Recording, and Full Disk Access grants across local rebuilds. The private key and trust
    record stay outside git. `packages/desktop/scripts/daseo-code-sign.mjs` fails closed when the
    identity is absent; never substitute ad-hoc (`codesign --sign -`) signing because its changing
    cdhash makes macOS treat every Daseo update as a new privacy subject.
14. **Workspace-owned in-browser popups** — Electron adopts Chromium's original popup
    `WebContents` into a workspace/browser target graph instead of showing an OS child window.
    OAuth, POST, named-window reuse, direct opener relationships, recursive popups,
    `postMessage`, and `window.close()` retain browser semantics. Background and agent-created
    targets stay in non-focusable native parking windows with paintable viewports; users see them
    inside the opener browser, while agents and mobile clients can snapshot, input, debug, stream,
    resize, or close each target by its own browser id. User focus is authoritative: Chromium
    navigation autofocus is disabled for embedded targets, inactive workspaces cannot advertise an
    active browser, only a trusted pointer in the visible interactive pane may claim physical browser
    focus, and hidden retained overlays neither trap nor restore focus over a newer input. Browser
    automation treats physical focus as a main-process lease: CDP pointer presses are allowed only
    when the target is both the workspace's active browser and Electron's focused `WebContents`.
    Background clicks and drags use page-local semantic input, text uses the target
    `WebContents.insertText`, and keys use contained target input, so another workspace cannot blur
    or write into the host Composer. Popup visibility is double-gated: the renderer reports the
    foreground workspace through `setWorkspaceActiveBrowser` (`isForeground`), and the main process
    owns a per-window `unknown | none | workspace` state. Unknown remains fail-open for old renderers;
    explicit none parks every popup; a workspace owner parks all other workspaces. Denied presentation
    intent is retained and reconciled when its workspace becomes foreground, so IPC ordering cannot
    leave a selected popup blank after a workspace switch. Stale false reports cannot override a newer
    owner, and route teardown reports explicit none even when no final background render occurs. Key files:
    `packages/desktop/src/features/browser-webviews/{popup-targets,focus-policy}.ts`,
    `packages/desktop/src/features/browser-automation/{service,focus-isolated-input}.ts`,
    `packages/app/src/desktop/browser/{popup-targets,remote-popup-targets,focus-policy}.ts`, and
    `packages/desktop/e2e/browser-tabs.e2e.mjs`.
15. **Image-safe composer delivery** — Mac paste reads Electron's native clipboard image as a
    canonical PNG instead of trusting one Chromium pasteboard flavor, while browser-file fallback
    and native mobile paste remain available. The composer stays non-sendable until asynchronous
    persistence finishes; multi-image persistence rolls back atomically; unreadable, empty, or
    provider-incompatible image bytes fail the send and restore the draft instead of silently
    reaching an agent as text-only. Canonical user rows retain structured context attachments and
    image counts, so authoritative reloads keep attachment-only prompts visible; image bytes remain
    client-local and hydrate as an unavailable-preview placeholder. Desktop selection offers the four
    portable provider formats, and native pick/paste converts other raster formats to PNG. Key files:
    `packages/app/src/{attachments,composer,utils/image-attachments-from-files.ts}` and
    `packages/desktop/src/features/clipboard-image.ts`.
16. **Fork-owned update provenance** — Daseo never follows official Paseo npm or GitHub update
    channels. The Mac packaging step writes `daseo-distribution.json` with the exact source commit,
    product version, and Mac build number, removes `app-update.yml`, and the packaged runtime disables
    Electron auto-update and quit-time installation. The marker is propagated to the bundled daemon,
    which rejects live npm self-update. Daseo upgrades use the stable local signing identity, external
    artifact hashes, an idle gate, and explicit activation approval.

17. **Pi extension-turn lifecycle** — Pi extensions may wake the agent without a Paseo prompt
    (background web-fetch completions send `triggerTurn` messages) and may keep working after
    `agent_end` (auto-compaction, queued continuations). Every run, including an autonomous one,
    receives a stable provider turn id, so steering, process exit, cancellation, usage, and terminal
    events stay correlated. `agent_settled` is accepted only after the same run's `agent_end` and an
    idle runtime state; the legacy/lost-event fallback also verifies runtime idleness, compaction,
    pending messages, and a quiescence window instead of trusting a timer. Compaction end resumes the
    fallback, and unrelated custom messages cannot complete a user prompt preflight. Key file:
    `packages/server/src/server/agent/providers/pi/agent.ts`.
18. **Native-owned Composer replacement** — Android keeps the IME-friendly uncontrolled Composer,
    but application replacements use the PasteInput Fabric component's event-count-aware native
    command rather than raw `setNativeProps`. Sends, queue clears, autocomplete, restore, and draft
    hydration advance a replacement revision; an exact late pre-replacement IME event is rejected and
    retried after the native event count commits. Composer editing remains disabled until Zustand's
    global draft hydration merge finishes, preventing a cold-start persisted draft from restoring
    stale sent text. Key files: `packages/app/src/components/ui/text-input/`,
    `packages/app/src/composer/`, `packages/app/src/stores/draft-store/`, and
    `patches/@mattermost+react-native-paste-input+2.0.1.patch`.
19. **Provider-gated fast mode control** — the Composer renders a direct lightning toggle on desktop
    and mobile whenever the selected provider/model advertises `fast_mode`; enabled uses a filled
    bolt and disabled uses a slashed bolt in the same monochrome treatment, so state never depends
    on color alone. Native Codex and Claude keep their provider-owned
    implementations. Pi discovers optional model features through the generated integration bridge,
    so Pi Codex can control its request-local priority tier without exposing a false toggle for Fable,
    Grok, DeepSeek, or other models that do not support it. Key files:
    `packages/app/src/{agent-controls,composer/agent-controls}/`,
    `packages/server/src/server/agent/providers/pi/agent.ts`, and the local Pi feature host.
20. **Pi model-selection SSOT plus Daseo launch policy** — Pi runtime discovery remains the model
    capability SSOT, while `~/.pi/agent/settings.json` `enabledModels` is the single visibility,
    ordering, and per-model thinking-default source shared by standalone Pi and Daseo. A temporary
    catalog extension publishes Pi's effective `ctx.scopedModels` after global/project settings and
    trust are resolved; Daseo projects that exact scope onto runtime-discovered capability metadata,
    filters each model to provider-native effort values, removes duplicate aliases, and uses Pi's
    active runtime model as the default. Daseo no longer carries a duplicate model list, model
    default, or thinking map. Generic `selectionPolicy` remains only for product behavior
    such as ignoring sticky preferences, applying each selected model's default effort in new and
    live sessions, and starting Sol Fast off; explicit drafts, resume data, and profiles still win.
    Key files:
    `packages/server/src/server/agent/providers/pi/agent.ts`,
    `packages/app/src/provider-selection/{provider-selection-policy,resolve-agent-form}.ts`, and
    `packages/app/src/hooks/use-draft-agent-features.ts`.
21. **PC-keyboard-aware Composer focus** — macOS uses `Cmd+L` as the primary shortcut, so a PC
    keyboard's physical `Win+L` focuses the Composer when Daseo is frontmost; the local Karabiner
    lock-screen rule explicitly exempts Daseo. `Ctrl+L` remains a Mac/Windows fallback, and both
    chords are disabled while a terminal owns focus to preserve terminal clear-screen behavior.
    The legacy binding id stays stable so existing user overrides survive the migration. Key file:
    `packages/app/src/keyboard/keyboard-shortcuts.ts`.
22. **Model-scoped acknowledged features** — feature preferences are stored by model rather than as
    provider-wide flat state. Live toggles render an optimistic value, reject repeated input while
    pending, persist only after the daemon accepts the runtime mutation, and roll back to canonical
    agent state on failure. Model changes prune unavailable session features; Pi resets Sol Fast to
    its policy default before entering Claude, so no latent Fast value crosses that capability
    boundary. Key files: `packages/app/src/{create-agent-preferences,hooks}/`,
    `packages/app/src/composer/agent-controls/`, and
    `packages/server/src/server/agent/{agent-manager,providers/pi/agent}.ts`.

## Local reliability contracts

- The generated WS outbound validator must accept every `AgentAttachmentSchema` branch, including
  the `.transform()`-wrapped text attachment. zod-aot 0.20.4 dropped transformed members from the
  generated discriminator dispatch, so any timeline page holding a browser-element, workspace-file,
  PR-context or chat-history attachment failed validation and took the whole page with it. The pin
  stays at or above 0.20.5 and `packages/protocol/tests/validation/ws-outbound.test.ts` covers both
  the compiler behaviour and every attachment branch on real timeline messages.
- A page of older history that fails to load is remembered by its cursor. Returning to the history
  start does not silently re-request it; the history-start slot offers an explicit Retry instead,
  and the block clears as soon as the start cursor moves or a retry succeeds. Key files:
  `packages/app/src/hooks/use-load-older-agent-history.ts` and
  `packages/app/src/agent-stream/older-history-error-row.tsx`.
- Advisor, committee and handoff skills are manual-only in the bundled source. Startup skill
  synchronization must retain `disable-model-invocation: true`; editing installed mirrors is not
  a durable customization.
- Transient catalog startup failures (SQLite lock, connection reset/refused, RPC deadline) get
  one read-triggered recovery after a one-second cooldown. Auth/model errors do not auto-retry;
  healthy catalogs and running agents are not reset.
- Daily retry schedules can use the daemon-local `schedule-retry-policies.json` sidecar:
  `{ "version": 1, "retries": { "bbbbbbbb": { "sourceScheduleId": "aaaaaaaa", "timezone": "Asia/Seoul" } } }`.
  The source must be a daily fixed-time cron. The daemon checks the local calendar day before
  starting a model: successful output, a running/inactive source, a not-yet-due source or an
  already-attempted retry skips execution with a recorded reason. Failed/empty/missed due runs
  permit one retry. Missing sources or malformed policy fail visibly without starting a model.
  Existing schedules without a policy keep their behavior; this is not a workflow engine.

## Upstream adoption policy

The last full upstream merge was 2026-08-16 (`4748aad10`). Daseo's timeline, replica cache,
Explorer, mobile keyboard/composer, and popup ownership have since diverged on purpose, so a
whole-branch merge is no longer possible without discarding fork deltas. Judge each upstream
commit by, in order: does it fix a problem Daseo actually has; has Daseo already solved it its
own way; is the root cause the same, not just the symptom; does it keep Daseo's current
workspace, browser, composer, and model-selection behavior; can the needed part be taken
without dragging in a new platform. Prefer `git cherry-pick -x` when the commit applies; hand-port
with the upstream hash in the commit body when it does not. Never resolve a conflict by taking
upstream wholesale.

Adopted since the last merge (upstream PR → Daseo commit subject):

- #4208 disable repository `core.fsmonitor` in daemon git commands (cherry-pick).
- #3909 forward-compatible `desktop-settings.json` (cherry-pick).
- #4283 reject pending Codex app-server requests on dispose (cherry-pick).
- #4068 stop reporting new agent work as "reopened" (cherry-pick).
- #4008 Pi RPC deadline 30s → 60s, `params.rpcTimeoutMs`, phase-attributed timeout errors
  (hand-port, Pi + JSONL transport only; OMP part not carried).
- 11e76f665 resume agents cleanly after a failed turn (hand-port).
- #4332 preserve unchanged provider registry/client/catalog state across config reloads
  (hand-port without plugin providers).
- #4170 completion timestamps for turns without a visible prompt (hand-port adapted to
  Daseo's user-message turn boundaries).
- #4228 react-native-unistyles web registry leak patch (patch + postinstall entry only).
- #4066 readable Paseo tool-call details (cherry-pick; real-Codex e2e not carried).
- #4032, #4049, #4064, #4161 zoomable image previews, Android lightbox gestures, gesture
  stabilization, Escape-first overlay dismissal (cherry-picks; Daseo-local
  `components/ui/icon-button-chrome.ts` provides the small toolbar chrome).
- #4107 fullscreen Mermaid viewer on web (cherry-pick).

Reviewed and deliberately not adopted: #4353 (reload ordering change targets Codex's exclusive
session writer; Daseo reloads only on user refresh and voice mode), #4190 / 140b0bb71 / #3907
/ #3975 / #4210 / #4033 (assume upstream's timeline, replica-cache, and navigation
architecture), #4044 / #4051 / #4090 / #4275 (overlap delta 18's native composer replacement
and need device QA), #3411 and #4277 (depend on the plugin timeline/tool platform), #4166
(32k-character answer cap conflicts with delta 5), #3826 Explorer pane host, #4214 tab
tooltips, #3945 / #3825 / #4025 GitHub polling changes (no observed rate-limit pressure).

## Product version policy

- Mac and Android share one Daseo product SemVer. Any shipped platform change advances it.
- Cut versions with `npm run version:all:patch` (or the other version:all scripts), not bare npm
  version. Preparation requires a clean main, validates version-only manifest/lock changes,
  commits explicit release paths and tags the resulting commit; it never stages the whole tree.
- Do not rebuild an unchanged platform only to match a number. Its next real release jumps to the
  current product version.
- Platform build numbers remain independent: Android `versionCode` and macOS `CFBundleVersion`
  increase only when that platform ships.
- `0.4.0-local.23` was the final `local.N` artifact. New releases use ordinary SemVer.

## Build & ship (Mac mini)

- Before either platform build, run `npm run brand:check`; generated DΛ assets must match the
  canonical mark and manifest. Mac: build with `npm run build:desktop -- --publish never --mac --arm64 --dir`, then run
  `node packages/desktop/scripts/daseo-app-package.mjs packages/desktop/release/mac-arm64/Paseo.app <product-version> <mac-build-version> $(git rev-parse HEAD)`
  followed by
  `node packages/desktop/scripts/daseo-code-sign.mjs packages/desktop/release/mac-arm64/Paseo.app`.
  Verify `Contents/Resources/daseo-distribution.json` exists and `app-update.yml` does not before
  signing or activation.
  The signer requires the stable `Daseo Local Code Signing` identity and intentionally refuses an
  ad-hoc fallback. Stage the signed bundle to `~/Applications/Paseo Local Patch.app`, rename only
  the outer installed directory to `/Applications/Daseo.app`. Run the idle-gated activation script
  through
  `node packages/desktop/scripts/daseo-activate-once.mjs /absolute/path/to/activate-daseo-<version>.sh`.
  The launcher removes any ambient `FORCE_NOW` inherited through an older Daseo process; pass the
  explicit `--force-now` flag only after immediate restart approval. It detaches one unsupervised
  process so it survives the current daemon stopping and
  exits permanently with the script. Never use `launchctl submit` or `KeepAlive` for activation;
  either one can relaunch a successful finalizer into an endless app/daemon replacement loop.
  Never change `CFBundleName`, `CFBundleExecutable`, helper names, bundle IDs, or the user-data
  path. **The `Paseo Daemon` process survives app swaps — always restart it too** (see
  `~/.paseo/restart-daemon-local5.sh` pattern).
- Android: verify the ignored personal Firebase config exists, use JDK 17 and the Android 36
  SDK (`JAVA_HOME=$(/usr/libexec/java_home -v 17)`,
  `ANDROID_HOME=/opt/homebrew/share/android-commandlinetools`), then run
  `npm run build:daseo:android` from the repository root for the Fold arm64 download.
  This carries APP_VARIANT and source commit through both prebuild and Gradle: expo-constants
  regenerates embedded config during Gradle, so setting the variant only for prebuild is unsafe.
  The command checks native and embedded package/version/name, direct FCM, source commit and
  the stable APK signer before accepting the artifact. `npm run test:daseo:release` covers these
  contracts and real repeated skill installation. Artifacts live in
  `~/paseo-builds/`, served at `https://mac.tail29eaf5.ts.net/`; install over Wi-Fi ADB
  (`phone install`) when available.
- The Mac bundle embeds its exact source commit; the release manifest records source commits and
  hashes for both Mac and Android artifacts. When both platforms change together, build both from
  the same commit. Push with the `dgk-dev` GitHub account, then switch `gh` back to `ax-dfcorp`.
