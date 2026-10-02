# Implementation plan

The plan favors small, reviewable state machines and executable gates. Estimates are relative effort, not calendar promises.

## Milestone 0 — Contract spike and decisions

**Goal:** prove current Pi and the exact bundled CLI can support the design before building product structure.

### Tasks

- Create minimal TypeScript package with Pi peer dependencies, exact Gemini CLI dependency, exact compatible ACP SDK, Vitest, strict tsconfig, formatter/linter.
- Resolve and spawn bundled CLI using `process.execPath`; prove it works when PATH has no `gemini`.
- Record redacted frames for initialize, authentication-required failure, authenticated new session, one prompt, thought/tool updates, model switch, image, cancel, and usage.
- Test both existing ambient Google credentials and temporary API-key flow without committing secrets.
- Verify Pi 0.85 complete-provider registration, custom api id, `streamSimple`, `refreshModels`, `/login` behavior for ambient/local auth, `sessionId`, lifecycle callbacks, and permission-tool UI access.
- Determine exact SDK pairing. Prefer official SDK; if latest is incompatible with CLI 0.58.0, pin the compatible v1 API or implement only a tiny framed adapter while retaining official protocol types. Document why.
- Measure CLI cold initialize/new-session/prompt latency and memory.
- Probe two sequential prompts, two sessions in one process, and concurrent sessions.
- Probe whether `unstable_setSessionModel` is discoverable/usable through chosen SDK.
- Verify cancel behavior during generation and permission.
- Decide the visible-before-login auth strategy in [Authentication and security §2](AUTH-PERMISSIONS-SECURITY.md#2-credential-ownership-model).

### Artifacts

- `docs/probes/<version>.md` with sanitized shapes and timings (no raw sensitive frames).
- Compatibility decision record for CLI/SDK pair.
- A fake-agent fixture schema derived from observed traffic.
- Updated assumptions in this documentation.

### Exit gate

Proceed only if bundled launch, authenticated prompt, actual model switch, streaming updates, cancellation or kill fallback, and Pi provider registration all work. If standard `/login` cannot bridge Google auth cleanly, do not silently weaken R3: write an ADR with the observed upstream limitation, amend requirements explicitly, and keep any provider-specific login command as a temporary beta-only fallback.

## Milestone 1 — Package skeleton and transport

**Goal:** robust ACP process/connection independent of Pi rendering.

### Tasks

1. Add package metadata:
   - name, license, repository, files allowlist;
   - `pi-package` keyword and `pi.extensions`;
   - Pi peer dependencies `*`;
   - exact runtime dependency pins;
   - Node `>=20`;
   - `build`, `test`, `lint`, `typecheck`, `pack:check`, `prepublishOnly`.
2. Implement bundled entry resolver with actionable install-corruption error and optional test-only/custom override.
3. Implement `ChildSupervisor`:
   - listeners attached immediately;
   - stdio encoding/backpressure and a chunked decoder with an initial 32 MiB frame ceiling;
   - generation id;
   - bounded stderr ring;
   - exit/error races;
   - POSIX group and Windows tree termination;
   - packaged parent-death supervisor/watchdog and ACP-stdin EOF/abrupt-parent orphan prevention test;
   - idempotent close.
4. Wrap official ACP client:
   - initialize validation;
   - request deadlines and abort;
   - session/update routing by session id;
   - agent request handlers;
   - reject-all on transport death;
   - maximum frame/line defense if SDK does not provide it.
5. Create typed error hierarchy and redaction utilities.
6. Build programmable fake ACP child covering malformed output, delayed responses, requests, notifications, and crashes.

### Tests

- entry resolution without PATH;
- ENOENT and early exit do not crash host;
- split/multiple NDJSON frames;
- backpressure/large bounded frame;
- timeout, abort, late response, duplicate id, malformed JSON;
- stderr does not pollute stdout parser;
- all promises settle and child dies on close.

### Exit gate

Transport fault suite has no hangs or unhandled rejection; repeated start/abort/close soak leaves no processes/listeners/timers.

## Milestone 2 — Pi provider and stream mapper

**Goal:** a selectable static provider with correct one-turn output.

### Tasks

- Implement complete `Provider` factory and minimal extension registration.
- Define conservative fallback models including `auto`; zero/unknown costs explained.
- Implement Pi message shell and close-on-switch event writer.
- Map text/thought/plan updates, final errors, stop reasons, and `_meta.quota`. Native tool notifications are dropped (see PROTOCOL-MAPPING.md).
- Forward current user text/images after capability checks.
- Start process lazily on first request.
- Hook idempotent runtime shutdown.
- Add `/gemini-acp doctor` with redacted versions/capabilities/state.

### Tests

Adapt Pi provider suites: basic stream, empty, abort, tokens/total, context overflow classification, image limits, Unicode surrogate boundaries, tool-call edge cases, cross-provider handoff. Add thought/text interleaving and exact terminal cardinality.

### Exit gate

One-turn real bundled-CLI smoke works in Pi and all stream invariants pass. No authentication setup beyond existing ambient credentials for this milestone.

## Milestone 3 — Authentication and permissions

**Goal:** standard safe onboarding and interactive tool confirmation.

### Authentication tasks

- Implement Pi auth adapter and advertised-method normalization.
- Implement Google login and Gemini API key paths.
- Pass API key via ACP `_meta`, never args/env.
- Verify auth with `session/new` before committing Pi credential.
- Handle cancellation, expired login, auth-required, method disappearance, and existing ambient credentials.
- Document logout split between Pi marker/key and Gemini shared OAuth store.

### Permission tasks

- Register hidden/provider-owned `gemini_acp_permission` tool.
- Implement broker records, opaque choice tokens, single-use validation, timeout, cancellation, and generation scoping.
- Render bounded title/kind/locations/explanation/diff in Pi UI/tool result.
- End provider stream with `toolUse`, detect continuation tool result, resolve ACP request, and continue same live prompt.
- Support repeated permission requests in one Gemini turn.
- Deny in headless mode; optional read-only policy remains off until security review.

### Exit gate

Fresh install → `/login` → `/model` → permission-gated edit works without global CLI or manual config. Allow, deny, cancel, timeout, abort, stale replay, and process crash are integration tested. No mutating action auto-approves.

## Milestone 4 — Session/context correctness, model discovery, and Pi tools

**Goal:** high-fidelity multi-turn behavior without duplicated history, plus first-class use of Pi/marketplace tools.

### Session tasks

- Implement bindings keyed by Pi session id and process generation.
- Queue per binding; define no-session-id ephemeral fallback.
- Implement watermark/prefix fingerprint.
- Build bounded one-time reconstruction and external delta.
- Exclude provider-owned assistant history and broker bookkeeping appropriately.
- Handle compaction, branches/rewinds, cwd changes, mixed-provider turns, and process recovery.
- Add idle process pool with strict maximum and LRU/TTL eviction.
- Persist only model cache initially; keep `session/load` disabled unless its gate passes.

### Model tasks

- Parse models/current model from session response.
- Implement `getModels` fallback + `refreshModels` publication/persistence.
- Validate catalog and retain old cache on failure.
- Call set-session-model before every prompt when needed.
- Track effective/response model diagnostics.
- Map reasoning/thinking metadata honestly; only map thinking levels if ACP exposes a real control.

### Pi-tool MCP tasks

- Start an authenticated loopback MCP server and pass its descriptor to `session/new`.
- Project active `Context.tools` under a `pi_` namespace; sanitize TypeBox schemas to the pinned Gemini function-schema subset and omit unsupported schemas/provider-internal tools with diagnostics.
- Define the dual-loop boundary: Pi hooks govern bridged tools, while Gemini-native tools use Gemini/ACP policy. Probe a per-process overlap exclusion policy without `tools.core: []` or global settings mutation; otherwise document coexistence prominently.
- Park `tools/call`, emit genuine Pi tool calls, consume matching results, and resume the same ACP prompt.
- Apply generation/session/call validation, timeouts, abort, body limits, and memory-only bearer tokens.
- Confirm a fixture marketplace extension tool executes once through Pi and remains structured in cross-provider history.

### Critical tests

- Fake transport directly asserts that turn N ACP prompt payload excludes earlier user/assistant turns already owned by the binding; no prompt-level full-history replay occurs across ten turns.
- Two Pi sessions in one cwd remain isolated.
- Same Pi session across cwd change reconstructs or rejects per policy.
- Compaction summary retained without replaying all old messages.
- Other-provider turn included once in next delta.
- Branch/rewind invalidates binding.
- Model A → B → A makes correct ACP calls before prompts.
- Catalog changes/revoked preview do not leave a stale effective model.
- Process crash reconstructs and does not repeat tool side effects.

### Exit gate

Ten-turn real-CLI sequential soak and all context-isolation tests pass. Diagnostics prove selected/effective model alignment. A marketplace fixture tool is discovered over MCP, executed exactly once by Pi, and its result resumes Gemini's pending turn.

## Milestone 5 — Hardening and marketplace beta

**Goal:** publishable `0.x` package.

### Tasks

- Linux/macOS/Windows and Node 20/22/24 CI where feasible.
- Real CLI contract jobs with test credentials in protected CI; a no-credential path always runs.
- Install packed tarball into isolated Pi data/home and launch smoke.
- Test npm package with no global Gemini and restricted PATH.
- Audit published file list, licenses, SBOM, lockfile, dependency scripts, and secret scans.
- Add README setup, auth, security, troubleshooting, telemetry, version/support policy, and screenshots.
- Benchmark cold/warm latency and memory; tune pool/TTL.
- Add chaos/soak tests and fake clock cleanup assertions.
- Verify package gallery metadata and installation/update/removal.
- Publish `0.1.0` beta with exact CLI version and known upstream caveats.

### Beta exit gate

No P0/P1 issues from at least one release cycle; clean upgrades; real users validate Google and API-key auth on multiple OSes. Then stabilize API/config and prepare 1.0 against Definition of Done.

## Milestone 6 — Optional enhancements (post-baseline)

Each feature requires a separate ADR and security/test gate.

### 6A — Version-gated `session/load`

- Build destructive canary in isolated Gemini home.
- Suppress only load replay updates.
- Verify restored-memory sentinel and no session overwrite.
- Keep reconstruction fallback and kill switch.
- Enable only for explicitly passing CLI versions; default can remain reconstruction.

### 6B — Expanded MCP parity

- Improve schema conversion and dynamic tool-list refresh beyond the 1.0 compatibility baseline.
- Add narrowly reviewed collision/selection policies for overlapping Gemini core tools.
- Re-run #28361 behavior on every CLI upgrade; never rely on `tools.core: []`.
- Consider resource/prompt surfaces only after tool round trips are stable.

### 6C — Rich activity cards

- Display-only replay tool for completed Gemini activity.
- Explicit non-executing semantics and no side-effect replay.
- Avoid exploding one ACP turn into excessive Pi turns.

### 6D — Filesystem proxy

- Implement canonical root policy and full security suite.
- Position as editor/file consistency, not sandbox.
- Validate structured ENOENT behavior against exact CLI.

## Cross-cutting engineering rules

- No `any` at protocol boundaries without immediate schema validation.
- Pure parsers/mappers; I/O behind injected interfaces.
- Never catch and ignore lifecycle failures without recording bounded diagnostics.
- Tests use fake clock, fake child, and real child separately.
- Every bug involving race/isolation gets a deterministic regression test.
- Configuration defaults are safe; environment overrides are documented and shown by doctor.
- Upgrade the pinned CLI in its own PR with captured compatibility diff.

## Suggested first issue backlog

1. `spike: bundled CLI launch and ACP handshake`
2. `spike: Pi provider auth visibility and /login callbacks`
3. `core: child supervisor with kill escalation`
4. `core: official SDK connection adapter`
5. `test: programmable ACP fake subprocess`
6. `provider: complete registration and fallback catalog`
7. `stream: balanced Pi event writer`
8. `stream: Gemini SessionUpdate mapper`
9. `usage: _meta.quota parser`
10. `auth: advertised method login adapter`
11. `permissions: broker and Pi confirmation tool`
12. `sessions: binding, watermark, reconstruction`
13. `models: dynamic refresh and set-session-model`
14. `lifecycle: idle pool and shutdown`
15. `diagnostics: doctor and redacted snapshots`
16. `release: packed clean-environment smoke`
