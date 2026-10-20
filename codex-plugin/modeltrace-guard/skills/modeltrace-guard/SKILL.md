---
name: modeltrace-guard
description: Set up ModelTrace Guard Autoswitch for ordinary codex and use it in the current conversation. Connect future conversations once, enable monitoring per thread, and ask for consent to each target before verification or switching. Installation and setup do not enable monitoring for every conversation or authorize switches.
---

# ModelTrace Guard Autoswitch

This is the independent `modeltrace-guard-autoswitch` plugin, marketplace `modeltrace-autoswitch`, based on xqy2006/ModelTrace with fork work by ChenCJ-io. The retained source/skill directory name is `modeltrace-guard`. Version 0.4 uses ordinary `codex` after one-time setup and preserves consent for **each incident**. The old preauthorized recovery workflow does not apply.

Resolve `../../scripts/autoswitch.mjs` and `../../scripts/guard.mjs` relative to this skill. Ordinary monitoring needs Node.js 18+ and a compatible native Codex app-server runtime. The complete gateway workflow requires both zstd and native HTTPS `proxyEnv` support: use Node.js 24.5+ or at least 22.21 on the 22.x line; Node.js 25+ is also supported. Configuration checks need a `sqlite3` CLI with `sha3()`. Probe generation consumes inference usage; scoring uses the bundled offline bank.

## Original task and disposable sampling forks

These management instructions apply to the original task. In a runner-created fork whose new input begins `[ModelTrace Guard: disposable sampling fork]`, answer the requested integer-array task exactly once. Do not run tools, manage monitoring, continue the inherited goal or report status. This exception permits probe generation only inside the runner's sampling fork; the original task's messages and goal remain unchanged.

## Use in an ordinary Codex conversation

When the user says “使用 modeltrace-guard-autoswitch” in a normal `codex` conversation, execute `node <autoswitch> use --session <actual-thread-id>`. Use `CODEX_THREAD_ID` or the trusted native session ID; never invent an ID or monitor another task. Do not ask the user to type a special launcher or start another CLI on their behalf. `use` enables monitoring only after this thread has a successful primary-route gateway receipt; it never grants switch approval.

Interpret the result truthfully. `monitoring_enabled` or `alreadyEnabled` applies only to this thread. `personal_route_unmonitored` leaves the initial or selected Official route without automatic probes. `existing_policy` preserves its route, disabled policy and halt; repeated use does not re-arm it. Explicit ordinary personal diagnostics can use `guard start`, but never start those merely to make `use` appear successful.

If gateway configuration is missing or `use` returns `connection_setup_required`, complete the one-time preparation below within the user's setup/use request. Announce its scope: it changes this Codex home's future conversation defaults, not the current running thread or monitoring of all conversations. Do not add a redundant permission question when the user already requested this setup/use; this authorization never covers a later incident switch. If the intended primary/backup is genuinely missing or ambiguous, resolve those preferences first.

After `connect`, inspect `connection-status`. If setup is ready but this thread has no successful gateway request, or `use` returns `new_conversation_required`, explain that the first old conversation cannot be hot-attached and ask the user to create a fresh ordinary Codex conversation once, then say “使用 modeltrace-guard-autoswitch” there. Finish the authorized setup before this handoff. Do not report the old thread as monitored, loop `use` to manufacture a receipt, restart the daemon, or substitute `launch --resume` as though it reroutes the original window.

## One-time setup and configuration

For installation before this skill is available, use the user-supplied repository URL or local directory and read that checkout's root `INSTALL.md`. Do not invent a published fork URL or use the upstream repository as this fork. The installation helper installs a local marketplace/plugin and optionally saves explicitly named preferences; it never calls `connect`, starts monitoring, reads authentication files or changes hook trust. Installation alone does not authorize changing native defaults.

Interpret natural language directly; no keyword parser is needed. “主用 API2 copy，备用 Doro” maps to `configure --primary-name "API2 copy" --backup-name "Doro"`. These are preferences, **not switch approval**. Use `inspect` to obtain actual candidates. Resolve an exact name first; only when none matches may a unique case-insensitive match be used. If the matching level is ambiguous, show its candidates and obtain the intended ID. The advanced form is `configure --primary-provider <ID> --backup-provider <ID>`; do not supply name and ID modes together or invent IDs. Optional settings are `--cc-switch-dir <path>` (default `~/.cc-switch`) and `--port <number>` (default `15722`).

The primary and third-party targets use CCSwitch 4.0.15 Stack and must be added through its interface. Preserve the company default configuration. Official targets only support the current CLI's native ChatGPT login with no managed account; the gateway uses a fixed official HTTPS endpoint for that target. Do not edit the CCSwitch database, inspect credential stores, change the global default or restart the whole Codex application to implement routing. Read-only SQL returns identity flags and hashes computed inside SQLite, not credential values. The HTTP gateway receives native authentication headers and forwards them on the selected local-CCSwitch or fixed-official path; do not parse or save login tokens, or claim the gateway never receives them.

Configuration updates require a stopped gateway and generate a new configuration ID; existing routed threads are not silently migrated. `connect` requires a valid gateway configuration, native ChatGPT login in the current Codex home and the trusted synchronous startup hook. Authentication checks explicitly select `openai` for their own app-server process because CCSwitch's global provider may be `custom`; this check does not sign the user in. If it returns `account: null`, report what this process observed and verify the active home/provider; do not infer the user has never signed in. Never read or copy another profile's credentials, or treat company API-key availability, installation or offline tests as proof of native readiness.

Run `connect` for authorized one-time setup. It starts the gateway and uses compare-and-swap checks to write only `model_provider="openai"` and `openai_base_url` in the current Codex home's base user config, saving their original values. These are defaults for future new conversations. It does not modify auth, another home such as `.codex-personal`, CCSwitch's default card, the daemon or a running thread. The changed defaults route new conversations through the gateway with the selected primary; monitoring remains off until that thread opts in. On `conflict`, `overridden` or stale configuration, report the actual limitation instead of bypassing ownership checks or changing unrelated defaults.

Setup and ordinary startup must discover the same data directory. `connect` rejects a command-only `--data-dir` that differs from ordinary startup's lookup; use this home's default, or ensure both setup and ordinary `codex` inherit the same `MODELTRACE_AUTOSWITCH_DATA`. Do not solve a path mismatch by silently modifying unrelated shell profiles.

CCSwitch exit, restart or a user card change can rewrite the two defaults; setup does not permanently own them. On a renewed user setup/use request, explicit `connect` may restore gateway defaults only while CCSwitch still selects the configured primary and each current key equals its saved original or old owned value. Any other value remains a conflict. Report the actual result; never bypass these checks or perform background reconnection. This restores future defaults, not a running thread or incident approval.

The synchronous `SessionStart` handler in `startup.mjs` ensures the gateway is started only when this plugin's owned integration is ready. It never enables monitoring, rewrites native defaults or repairs CCSwitch drift automatically. Respect native hook trust; a newly added or changed startup hook needs the user's review in `/hooks`. `gateway-start` alone starts a service and does not connect ordinary Codex defaults.

`connection-status` reports `readyForNewThreads` and the future-default integration state. Actual routing for the current thread requires its successful gateway receipt and route state. Account identity, quota UI, a healthy gateway, config-file contents or a successful write are not current-route evidence. Keep these scopes separate in reports.

On an explicit disconnect request, run `disconnect`; it restores only the two defaults still owned by this integration, and refuses to overwrite outside changes. It does not stop existing gateway sessions, monitoring or the gateway. Use their respective commands when the user requests those actions.

`enable --session <UUID>` remains the lower-level command for an already-connected primary thread. `launch`, `launch --provider-name <NAME>` and `launch --resume <UUID>` remain advanced diagnostic compatibility commands, not the ordinary entry flow. They do not hot-modify the original window or guarantee portability of old authentication/encrypted history. Keep user task names; for ordinary `guard start --name`, use a verified task title, never a shared workspace name. Keep this fork separate from the upstream monitor on the same thread and from other Codex homes.

## First mismatch: report and ask

For the main gateway workflow, the **first valid fingerprint mismatch** pauses work and creates an `awaiting_approval` request. Strong difference signals and weak ranking disagreements both require a report; explain which occurred. Missing metadata, an unlisted model, invalid output, timeout, compaction, interruption or absent route evidence are coverage gaps, not valid mismatches.

Before another work tool or a final result, report the expected model, fingerprint candidate, checkpoint time, signal strength and proposed target. Say “fingerprint candidate,” never a verified backend identity or proof of reduced reasoning effort. Do not secretly add retries, contact a backup, or run a target canary while awaiting approval. Pause edits, commands, delegation and ordinary task work while asking the user whether to switch to the proposed target, choose another target, or keep the current route.

Only after visibly reporting pending notifications may you run the returned `guard acknowledge --alert <ids>` for the alerts actually described. **Acknowledgement means the agent has reported the alert; it is not user consent.** Do not acknowledge silently or equate an acknowledgement with independent delivery proof. Installation, connect, selecting default primary/backup, use/enable, a previous incident's approval, silence and timeout do not approve this incident. Do not convert a broad earlier assignment into standing permission to switch.

Use the current request ID from status. Run all four incident commands through `node <guard>` (`guard.mjs`). `propose-switch --request <ID>` creates a new pending proposal for the default backup without sending target requests; it is not a read-only status command. To select another target, use `--target-name <NAME>` or `--target-provider <ID>`, not both. Resolve names with `inspect` using exact-first, then unique case-insensitive matching; duplicate names require choosing an ID. If the default backup is already the current route or no target is proposed, ask the user to choose another actual configuration; never infer a return to primary. Merely proposing a target never approves it. Every proposal creates a new `switchRequest.id`: use the returned ID for approval, waiting or decline, never the superseded ID.

“同意切到 Doro” is an explicit selection and approval for the current incident: resolve its unique target, prepare that proposal and execute `approve-switch --request <ID> --target-provider <ID>` without asking again. A clear “同意” may approve the unambiguous target just shown for that request. If the target identity or configuration changes, select it again and obtain new consent; approval of an old ID/configuration cannot transfer to a different target. If the user's reply is genuinely ambiguous about switching or target, clarify while leaving the task paused.

When the user declines switching and asks to continue the current route, execute `decline-switch --request <ID>`. This keeps the route, resumes task work and restores ordinary third-party monitoring intervals; it does not disable future incident reports. Do not silently reinterpret “continue” as approval to switch.

## Approved verification and continuation

After explicit approval, use `wait-switch --request <ID>` to observe the native canary. Never call it as a substitute for obtaining consent, and never turn elapsed waiting time into approval. The target canary needs a real `completed` receipt tied to the approved route/configuration **and** a compatible fingerprint. A queued job, HTTP success, fabricated receipt or classifier candidate alone is insufficient.

Keep original work paused until the recorded successful verification commits the target route and releases this request's halt. On failure or changed conditions, keep the halt, explain the returned diagnostic and do not call ordinary `resume` to bypass verification. Once failure cleanup has settled, an explicit user choice of a new target may create a fresh proposal from the current failed request; it has a new ID and no inherited approval, so record consent for that selected target before verification. Do not retry or choose another target automatically. Report the successful route change before continuing the still-requested task; the user's incident-specific approval already authorizes completing that verified switch, so no repeated permission question is needed.

A successful Official switch stops probes so further automatic monitoring does not spend the personal subscription. A successful third-party switch keeps monitoring this thread; its next mismatch creates a new request and requires new consent. Never automatically return to the primary. Earlier approvals do not cover later anomalies or targets.

`disable --session <UUID>` stops monitoring and cancels pending probes while preserving the selected route, evidence and any halt. `gateway-stop` stops the proxy; sessions relying on it cannot send subsequent requests until it restarts. Do not confuse stopping monitoring with stopping the gateway or releasing a halt.

## Native sampling and evidence boundaries

Normal checkpoints run in background native hooks and save normal results silently. Do not execute `probe`, poll status, wait or narrate each normal check. A foreground `probe` is only for a diagnostic explicitly requested by the user. External-terminal enable/start cannot wake an idle task; its next loaded trusted hook handles queued work.

**Never generate, type, copy or submit probe numbers in the monitored task.** Direct `submit --numbers` is unsupported. Do not substitute an ordinary fork tool, a subagent, another model or a hand-written provider request when the runner fails. Report recorded coverage gaps and diagnostic code/stage honestly; a queued follow-up is not a completed check.

The runner creates a native persisted frozen baseline without starting a model turn in it. Sampling forks are ephemeral, text-only and limited to one requested response; trusted hooks block their tools. Their model/provider and route bindings must come from the source task and verified route metadata, not the classifier's prediction. Raw arrays remain in local sample storage, not parent tool results. Native forks use saved history, not unseen in-flight memory; a mid-turn snapshot may include an interruption marker.

The baseline is cleaned up after its checkpoint or standalone retry batch. Never use or edit it if it briefly appears in the task list. Cleanup refuses original tasks, altered baselines and baselines with persisted descendants, including archived ones; report pending or blocked cleanup rather than calling archiving deletion. Do not delete unrelated tasks to fix cleanup. A turn-boundary hash is not a transcript-content hash.

Probe arrays do not become parent history. Language variation and fixed prefixes do not guarantee an invisible test or cache hit; report actual cached-token counts when available, and treat null as unavailable. A fork samples its own continuation, not proof of the backend used by an earlier parent request. Same-context and multilingual false-positive rates are not independently calibrated; correlated probes cannot justify multiplying independent error probabilities.

Async alerts arrive at the next safe Codex boundary and do not wake an idle task. Trusted synchronous `PreToolUse` blocks supported subsequent work tools, not all hosted paths or already-running commands. Never promise immediate cancellation of every action or that the plugin killed Codex. At most one checkpoint runs per task; expiry, changed comparison conditions, interruption and late results do not become mismatch votes.

## Optional standalone upstream monitoring

Use `guard.mjs start` when the user separately requests ordinary upstream monitoring. This is distinct from the gateway consent workflow: it keeps the upstream same-baseline retry batch and never grants route-switch permission. Do not start it to evade an awaiting-approval request or restart stopped personal monitoring without a new explicit diagnostic request.

Run `start` with only requested overrides:

- `--expected <exact-label>` chooses a bank label; `auto` follows native metadata. `models` lists labels. Missing metadata and an unlisted label are separate non-mismatch outcomes.
- `--tool-min 16 --tool-max 32` gives the default random interval of observed work-tool completions; equal bounds give a fixed interval. No elapsed-time schedule or turn/task count caps.
- `--retry-count 3` means 3 additional retries after the first standalone mismatch; range 1–100. “复测改成 5 次” maps to `guard configure --retry-count 5`, not to hidden retries in the consent workflow.
- `--pending-seconds 180` is the issuance-to-completion deadline, not sampling frequency.
- `--languages zh,en,ja,ko,fr,de,es,pt,ru,ar` selects the pool; defaults are zh,en and a single language fixes it.

`guard configure` preserves evidence and counters. An active standalone batch keeps its original target, language, count, model comparison, bank and frozen context. The initial mismatch is not one of N retries. After visibly notifying and acknowledging, use the returned `guard wait --confirmation <ID>` only during the anomaly; each wait observes progress, returns within 30 seconds and does not generate probes. Pause original work until all N complete, even if one matches. Every retry forks the same initial baseline and boundary, never a prior child or the extended parent; do not nest batches or capture a replacement baseline.

In standalone mode, matching retries advance automatically and mismatching retries require notification and acknowledgement. All N valid mismatches preserve `taskHalt` and deny supported subsequent work tools. Stop original work and wait for an explicit user resumption request. Only then read the current halt ID and run `guard resume --halt <ID>`. Acknowledgement, configuration, model changes and stop/start do not clear it. Do not use standalone `resume` in place of the gateway approve/decline workflow.

## Readiness, trust, dashboard and storage

`guard doctor` verifies bundled files. `doctor --fork true` additionally creates native snapshot/ephemeral forks without inference, checks runtime settings and trusted sync/async hooks, then queues cleanup. Read readiness and deletion status honestly. `MODELTRACE_CODEX_PATH` can select the intended executable; never fix readiness by changing an unrelated account/provider or bypassing trust.

Respect an already completed hook review. If the runtime reports untrusted hooks or changed definitions, ask the user to review ModelTrace Guard Autoswitch in Codex CLI's `/hooks`; do not run trust-changing commands yourself. Reload the plugin when required. Untrusted fork protection refuses inference rather than falling back to an unsafe path.

`status` reports current requests, saved route and monitoring state alongside gateway/connection readiness; use actual receipts before claiming which channel handled a request. Stopped monitoring does not mean a stopped gateway. The synchronous startup readiness check and background monitoring hooks have separate purposes: only already-enabled monitoring schedules probes. Do not reactivate stopped Official monitoring implicitly. Verification requires newly observed work-tool/background-hook activity in the current runtime, not just an old timestamp. Long idle time means waiting for work activity, not proven health or failure.

When asked for a dashboard, run `guard dashboard` and open the returned local URL. Keep its capability fragment and the gateway capability URL private; do not publish them or remove authentication/Origin checks. Browser notifications need permission and a connected page, and an existing alert is not proof of delivery. The page does not export probe arrays, transcripts or credentials. `dashboard-stop` stops only the web service; hook monitoring does not depend on it. `guard stop` cancels standalone sampling and preserves any halt/history.

The default data directory is `${CODEX_HOME:-~/.codex}/modeltrace-guard-autoswitch`, isolated from the upstream monitor. See `../../README.md` for storage, cleanup and calibration details. The packaged bank is a snapshot; do not collect or expand it without a separate user request. Synthetic tests and scorer parity do not establish independent long-context or multilingual accuracy. Standalone web search/images endpoints are unsupported; encrypted history can be nonportable, so never promise full endpoint compatibility or lossless cross-route continuation.
