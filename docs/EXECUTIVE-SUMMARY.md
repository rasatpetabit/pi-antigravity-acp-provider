# Executive summary

## Recommendation

Build a focused Pi package that registers a complete `@earendil-works/pi-ai` `Provider` named `gemini-acp`, bundles a pinned `@google/gemini-cli`, and controls that CLI through stable ACP v1 over NDJSON stdio. Do not require a globally installed executable, patch Pi, proxy Gemini's private HTTP APIs, or turn the package into a general research/tool suite.

The core shape is:

```text
Pi /model + /login
        │
        ▼
complete pi-ai Provider
        │ streamSimple(model, context, options)
        ▼
turn/session coordinator ─── session binding + context watermark
        │
        ▼
official ACP client/transport
        │ JSON-RPC v1 over NDJSON stdio
        ▼
process.execPath + bundled @google/gemini-cli/dist/index.js --acp
        │
        └── Gemini auth store, model service, agent loop, and tools
```

Use `@estebanforge/pi-antigravity-bridge` as the principal engineering reference for provider/driver separation, session binding, close-on-switch event streaming, process supervision, cancellation fallback, no-patch permission/tool round trips, and lifecycle cleanup. Do **not** copy its Antigravity-specific wire assumptions, auto-approval policy, or dual-engine scope.

## Why this is materially better

The existing `pi-gemini-acp` package is useful but solves a broader problem. Its provider path depends on a user-installed/authenticated `gemini` command, exposes a static catalog, converts ACP primarily to text, and sends flattened transcript history into a reused ACP session. In the inspected 0.13.2 source, model selection is implemented by persisting/probing a CLI `--model` setting rather than calling ACP's session model method, and the streaming path does not expose the full Pi content-block lifecycle. Those choices prevent the clean “install → login → `/model`” experience and risk duplicated context.

The proposed package instead makes four invariants non-negotiable:

1. **One history owner per turn.** A live ACP session receives only the new user turn plus a bounded delta for Pi-side events it could not have seen. A newly reconstructed session receives a one-time context envelope. Never replay the full transcript into a warm ACP session.
2. **The selected Pi model controls the ACP session.** Read available models from `session/new`, publish them through Pi's dynamic model API, and call `unstable_setSessionModel` (or a negotiated successor) before prompting.
3. **Every stream is protocol-correct.** Emit `start`; balanced `text_*` and `thinking_*` blocks; then exactly one `done` or `error`, with actual ACP stop reason and usage metadata preserved.
4. **Denial is the safety fallback.** Permission requests must reach a user-visible Pi round trip. Headless operation denies unless an explicit, narrowly scoped policy says otherwise. Abort first sends `session/cancel`, then tears down the process tree after a deadline.

## What “no special setup” means

The package's normal installation should be enough to supply the executable and ACP transport:

```bash
pi install npm:pi-gemini-acp-provider
```

Gemini appears in `/model` without a PATH probe. `/login gemini-acp` drives an advertised Gemini ACP auth method (Google login or API key) and uses Gemini CLI's credential mechanisms. Authentication is normal provider setup and cannot be removed. Advanced users may override the command for debugging, but the bundled entry point is always the default and the supported path.

Bundling has a cost: `@google/gemini-cli@0.58.0` has an npm unpacked size of roughly 98 MB **for that package alone**, before its transitive dependency footprint. It includes native-addon dependencies such as keytar/PTY packages; supported platforms commonly have prebuilt artifacts, but clean Debian, Alpine/musl, and source-build cases must be tested and may need an OS toolchain. “No special setup” is therefore a release gate, not an assumption. Install size, cold start, native compatibility, and dependency supply chain must be explicit criteria.

## Product boundaries

### Stable v1 scope

- Normal Pi provider and models in `/model`.
- Standard `/login` onboarding with Google-login and API-key paths where ACP supports them.
- Bundled Gemini CLI; optional diagnostic override only.
- Persistent process pool, serialized prompts per ACP session, and bounded idle cleanup.
- Dynamic model discovery with cached static fallback.
- Text, thought, images, embedded context, usage, errors, and stop reasons.
- User-mediated permission bridge and safe non-interactive denial.
- Gemini-native tool loop; its tool notifications are not rendered in the Pi transcript, and completed tools are never re-executed.
- Authenticated MCP round trips for active Pi tools, including marketplace-extension tools; Pi remains their executor.
- Explicit dual-loop security boundary: Pi hooks govern bridged `pi_` tools, while Gemini-native tools remain governed by Gemini policy and ACP permission prompts unless a tested per-process overlap policy can disable them safely.
- Pi lifecycle cleanup, diagnostics command, and marketplace-compliant package metadata.

### Later, gated scope

- Reliable cross-process `session/load`, only after pinned-version regression tests pass.
- Native display replay cards for already-executed Gemini tools.
- Audio input if Pi's model/content APIs and UI expose it cleanly.

### Explicit non-goals

- A generic ACP orchestrator or delegation tool collection.
- Search/research/file-analysis commands unrelated to provider behavior.
- Account rotation or quota bypass.
- Automatic approval of all edits or shell commands.
- Mutation of the user's global Gemini settings to disable tools.
- A global Gemini install, Pi dist patch, or undocumented database/protobuf integration.
- Claiming per-token dollar cost for subscription-backed traffic when no reliable billing rate is known.

## Key upstream constraints

The protocol surface is sufficient, but upstream quality must be treated as fallible:

- Gemini CLI cold starts can be noticeable; warm process reuse is required.
- Open reports describe `session/load` losing memory or even harming resumability (#27913, #28693, #28775).
- Sequential ACP prompts have had dropped/merged response regressions (#24017).
- Usage is currently carried under non-standard `PromptResponse._meta.quota`.
- Filesystem proxy handling has had structured-ENOENT inconsistencies (#26448).
- Configuring `tools.core`, including `[]`, has been reported to suppress MCP tools (#28361).
- Some releases have polluted ACP stdout or hung as a subprocess (#22647, #13913).

Consequently, the package must pin a known-good CLI/SDK pair, test the real subprocess, parse stdout strictly, retain stderr tails, expose versions in diagnostics, and ship upgrades only through compatibility gates.

## Delivery recommendation

Use milestone gates rather than a large one-shot implementation:

- **M0:** contract spike against the bundled CLI and Pi auth/tool APIs.
- **M1:** package skeleton, supervised process, and ACP transport.
- **M2:** static provider, event mapper, cancellation, and lifecycle cleanup.
- **M3:** auth onboarding and permission round trips.
- **M4:** session/context correctness, dynamic models, and the required Pi-tool MCP bridge.
- **M5:** hardening, real-CLI/platform matrix, packed smoke, and public beta.

Build the provider-only path before the MCP bridge so transport and stream failures are isolated, but do not call the result 1.0 until the active Pi/marketplace-tool round trip passes R14. The bridge has the largest state-machine surface and receives its own milestone and security gates.
