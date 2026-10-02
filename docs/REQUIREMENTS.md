# Requirements and acceptance criteria

## Terminology

- **Pi session**: the conversation identified by `SimpleStreamOptions.sessionId` and represented by Pi's `Context`.
- **ACP process**: one bundled Gemini CLI subprocess in `--acp` mode.
- **ACP session**: a Gemini session created within that process by `session/new` or restored by `session/load`.
- **Binding**: provider state associating a Pi session with an ACP session, cwd, selected model, process generation, and context watermark.
- **Turn**: one user request through Pi, including any provider continuations needed to finish permission/tool round trips.

## Functional requirements

### R1 — Native provider registration

The extension must register a complete `Provider`, not merely commands or delegation tools. Provider id is stable (`gemini-acp`); models participate in `/model`, session model switching, model history, and normal Pi selection. Both `stream` and `streamSimple` are valid and terminate according to Pi's event contract.

**Acceptance:** install the package and start Pi; the provider is present in `/login`. After standard `/login` (or safe detection of existing Gemini auth configuration), choose `gemini-acp/<model>` from `/model`, send a prompt, switch to another provider and back, and continue without provider-specific setup commands.

### R2 — Zero global binary prerequisite

`@google/gemini-cli` is a production dependency. Resolve its package entry with Node module resolution and launch it with `process.execPath` plus `--acp`. Never depend on shell lookup for the default path. An explicit command override may exist only for development/diagnostics.

**Acceptance:** in a clean environment where `which gemini` fails, the packaged provider still starts and `doctor` reports the bundled version/path provenance.

### R3 — Standard authentication onboarding

The provider appears in Pi's `/login` UI. The flow reads `initialize.authMethods`, lets the user choose a supported method, invokes ACP `authenticate`, and reports progress/auth URL/device code where available. API keys use a secret prompt and cross process boundaries only in an ACP request. Google credentials remain owned by Gemini CLI. Errors name a concrete remediation.

**Acceptance:** fresh Google login and API-key login work without hand-editing settings; an already authenticated Gemini user can run without re-login; cancellation leaves no stuck subprocess.

### R4 — Correct model semantics

The initial fallback catalog is usable offline. After authenticated ACP discovery, publish `availableModels` from `session/new` through Pi's model-refresh mechanism. Before every prompt, verify the binding's active model equals `model.id`; call the negotiated ACP model-control method when needed and reject unsupported ids visibly. Do not claim that a prompt preamble or persisted `--model` preference changed the running session.

**Acceptance:** selecting two distinct Pi models yields corresponding ACP model-change calls and diagnostics show the effective model. Unknown or revoked models fail safely or fall back only with an explicit message.

### R5 — Protocol-correct streaming

Map ACP message chunks to text, thought chunks to thinking, and preserve ordering using close-on-switch block handling. Every successful stream emits exactly one `start`, balanced block events, and one `done`; failures emit one `error`; no events follow termination. Empty responses remain valid. Preserve raw stop reason and diagnostic details.

**Acceptance:** Pi's provider conformance tests plus mapper fixtures pass for interleaved text/thought/tool updates, Unicode splits, empty turns, malformed frames, and process exit.

### R6 — Usage and stop reasons

Read actual usage from the negotiated response. For current Gemini CLI, parse `_meta.quota.token_count` defensively and retain per-model usage in diagnostics. Use zero/unknown fields when absent—never estimate silently. Map `end_turn → stop`, `cancelled → aborted`, and token/turn limits to `length`; preserve raw ACP values.

**Acceptance:** fixture and live smoke tests verify counts and all known stop reasons; malformed metadata does not crash a stream.

### R7 — Session continuity without duplicated context

Bind by Pi `sessionId`, not cwd alone. Serialize prompts within a binding. A warm ACP session receives only new content and a bounded delta of unseen Pi-side context. A fresh/recovered session receives a one-time reconstruction envelope. Track a message watermark/hash. Never send full Pi history on each prompt to a persistent ACP session.

**Acceptance:** a two-turn sentinel test proves turn one appears once in the effective ACP conversation; mixed-provider and post-compaction tests preserve required context; two simultaneous Pi sessions in one cwd do not leak.

### R8 — Images and system/project context

Forward image blocks as ACP image content only when advertised. Deliver Pi's system prompt and reconstructed context once per fresh binding, preferably as an embedded resource when supported. Do not re-read or independently merge `AGENTS.md` when Pi's composed `context.systemPrompt` is available; Pi remains the source of truth.

**Acceptance:** text-only, image-only, mixed image/text, project instructions, and compaction recovery work; oversized reconstruction is bounded and visibly marked.

### R9 — Permissions are user-mediated

ACP `session/request_permission` must never default to the first allow option. Use a registered Pi permission tool/continuation round trip to present title, kind, locations, diff/explanation, and offered choices. The selected ACP `optionId` must be one actually offered. Non-interactive mode and timeout deny/cancel. “Always” choices are session-scoped unless the upstream explicitly persists them and UI says so.

**Acceptance:** allow-once, deny, cancel, timeout, malformed options, and pending-abort tests pass. No edit or shell confirmation is auto-approved by default.

### R10 — Cancellation and lifecycle

On `AbortSignal`, immediately stop emitting normal deltas, resolve pending permission requests as cancelled, send `session/cancel`, and enforce a short grace deadline. If completion does not arrive, reject all RPC promises and terminate the child process group (`SIGTERM`, then `SIGKILL`; Windows equivalent). Close all processes and servers on `session_shutdown`, extension reload, fatal transport errors, and idle expiry.

**Acceptance:** abort-before-spawn, during initialize, during prompt, during permission, and hung-agent tests leave no child processes, timers, listeners, or unsettled promises.

### R11 — Safe filesystem capability posture

For 1.0, do not advertise ACP filesystem or terminal client capabilities. Assert this exact handshake posture against fake and bundled agents. If filesystem proxying is implemented later, canonicalize absolute paths, enforce cwd/explicit roots against symlink escapes, use atomic writes where appropriate, apply size limits, reject special files, and return structured not-found errors compatible with Gemini CLI. Advertising a root is not a sandbox; document subprocess trust separately.

**1.0 acceptance:** initialize omits or explicitly disables fs/terminal capabilities and no corresponding request can hang the client. **Future fs acceptance:** traversal, symlink, out-of-root, FIFO/device, oversize, race, and ENOENT tests fail closed before either fs capability is advertised.

### R12 — Observable operation

Provide `/gemini-acp doctor` (or equivalent) showing package, bundled CLI, ACP protocol/SDK, agent, auth-state provenance without secrets, active process/session counts, selected model, capability flags, restart count, and stderr tail only when explicitly requested/redacted. Debug logs are opt-in and never contain prompts, keys, tokens, or full file contents by default.

### R13 — Marketplace compatibility

The final package is public on npm, includes the exact `pi-package` keyword and a `pi.extensions` manifest, keeps Pi packages as `peerDependencies: "*"`, places the CLI and ACP SDK in `dependencies`, limits published files, declares Node `>=20`, and passes install-from-tarball tests. No postinstall global mutation.

### R14 — Pi tool and extension interoperability

For 1.0, active tools from Pi's `Context.tools`, including marketplace extension tools, must be available to Gemini under a `pi_` namespace through an authenticated in-process MCP bridge unless explicitly filtered for incompatible schema or safety. MCP calls park and become genuine Pi `toolCall`/`toolResult` round trips, so Pi—not provider internals—executes them with normal hooks, UI, and transcript semantics. Exclude the provider's own permission broker tool to prevent recursion. Gemini-completed native tools are not rendered in the transcript and are never replayed for side effects. Pi hooks/security extensions govern bridged `pi_` calls only; overlapping Gemini-native tools run under Gemini's policy and ACP permission broker. This dual-loop boundary must be prominent unless a tested per-process policy can disable overlaps without hiding MCP tools.

**Acceptance:** a fixture marketplace tool appears in Gemini's MCP tool list, is invoked once through Pi, returns to the still-running Gemini turn, and is visible to a later provider in structured Pi history. Name collisions, cancellation, timeout, malformed schemas, and #28361-compatible tool configuration are tested. If R14 is incomplete, the package may ship only as beta with the limitation stated prominently—not as 1.0.

## Non-functional requirements

- **Compatibility:** Linux, macOS, and Windows where the bundled Gemini CLI supports them; Node 20+.
- **Isolation:** one session's notifications, permissions, model, cancellation, and context never affect another.
- **Resilience:** unknown ACP updates are ignored with diagnostics; malformed known updates fail only the affected turn/process.
- **Performance:** reuse warm processes; do not spawn at extension import; idle timers use `unref`; no polling loop.
- **Privacy:** no telemetry added by the bridge; clearly document Gemini CLI's own telemetry controls.
- **Maintainability:** protocol types and transport are isolated; no business logic in extension entrypoint; injectable subprocess/time/filesystem seams.
- **Upgrade discipline:** exact or tightly pinned Gemini CLI/SDK versions, Renovate/Dependabot PRs gated by live contract tests, no automatic runtime download.

## Definition of done for 1.0

1. All R1–R14 acceptance tests pass on the supported OS/Node matrix.
2. A clean tarball install supports `/login` and `/model` without global Gemini.
3. Real CLI tests pass: first prompt, ten sequential prompts, model switch, image, permission allow/deny, abort, process crash/recovery, and two concurrent Pi sessions.
4. No open P0/P1 defects in authentication, context isolation, duplicate execution, permission safety, or child cleanup.
5. `npm pack --dry-run` contains only intended source/docs/assets and no secrets or probe logs.
6. README accurately distinguishes provider behavior from Gemini CLI's internal tool loop and sandbox limitations.
7. Public beta has at least one release cycle before `1.0.0`.
