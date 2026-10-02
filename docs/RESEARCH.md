# Research findings

Research date: **2026-09-04**. “Current” below means the versioned baseline in [SOURCES.md](SOURCES.md), not a timeless protocol guarantee.

## 1. Pi provider surface

Pi 0.85.0 supports complete runtime providers through `pi.registerProvider(provider)`. A provider owns:

- stable `id`, display `name`, and auth semantics;
- synchronous `getModels()`;
- optional dynamic `refreshModels(context)` and `filterModels()`;
- `stream()` and `streamSimple()`;
- model metadata (api, provider/id, inputs, reasoning, context/output limits, costs);
- optional API-key and/or OAuth login flows integrated with `/login`.

This is a better fit than the legacy registration object because Gemini ACP needs custom auth, model discovery, and streaming. Pi's `RefreshModelsContext` supports cached persisted catalogs, provider credentials, publication, network/offline modes, force refresh, and cancellation. That allows a static fallback plus authenticated ACP-discovered overlay.

`SimpleStreamOptions.sessionId` provides a stable Pi conversation key. The provider should treat it as authoritative. Cwd is necessary ACP session data but is not unique: two conversations often share one directory.

Pi's stream contract is stateful. Successful streams require `start`, block start/delta/end events, and one terminal `done`; failures terminate with `error`. The shared `partial` is a live object, not an event snapshot. Pi stop reasons are `pending`, `stop`, `length`, `toolUse`, `error`, `aborted`, and `deferred`. The event mapper therefore needs an explicit content-block state machine.

A complete provider must still define auth even if the real credentials are ambient or owned by a subprocess. This is useful: the auth adapter can make Gemini visible, integrate `/login`, and pass only a sentinel or API key to the process coordinator.

## 2. Pi package and marketplace rules

Pi installs npm, git, URL, and local packages and loads extension paths from a `pi` manifest. For gallery discovery a package must have the exact npm keyword `pi-package`. The proposed manifest is:

```json
{
  "name": "pi-gemini-acp-provider",
  "keywords": ["pi-package", "pi-extension", "gemini", "acp"],
  "pi": { "extensions": ["./extensions/index.ts"] },
  "peerDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*"
  },
  "dependencies": {
    "@agentclientprotocol/sdk": "<tested exact/range>",
    "@google/gemini-cli": "<tested exact>"
  },
  "engines": { "node": ">=20" }
}
```

Pi core libraries and `typebox` belong in peer dependencies, not the bundle. Third-party runtime dependencies belong in dependencies. Package source executes with full local privileges, so minimization and auditable publication matter.

At the research date, `pi-gemini-acp-provider` returned npm `E404`; `pi-gemini-acp` already exists at 0.13.2. The candidate name is not reserved and must be rechecked.

## 3. ACP protocol and official SDK

ACP is JSON-RPC 2.0 carried as newline-delimited JSON over stdio. The official TypeScript SDK supplies protocol types, NDJSON streams, a client builder/connection, method correlation, and helpers. Stable ACP v1 should be used; ACP v2 is explicitly experimental.

The client-facing lifecycle is:

1. Spawn agent.
2. `initialize` with protocol version, client identity, and only implemented capabilities.
3. If required, `authenticate` using an advertised auth method.
4. `session/new` with absolute cwd and MCP server list, or cautiously `session/load`.
5. Set model/mode where supported.
6. `session/prompt`; concurrently handle updates and agent-to-client requests.
7. `session/cancel` on abort.
8. Close transport/process.

The agent sends `session/update` notifications for text, thought, tool, plan, command, and state changes. It can issue `session/request_permission` as a JSON-RPC request. If the enclosing prompt is cancelled while permission is pending, the client must resolve the request as cancelled.

ACP filesystem methods are capability-negotiated client requests. Advertising `readTextFile` or `writeTextFile` is a commitment to implement it correctly. The client is a security boundary only for operations actually routed through it.

### SDK/CLI version caution

The latest SDK observed on npm was 1.4.0, while `@google/gemini-cli@0.58.0` declares `@agentclientprotocol/sdk@0.16.1`. Even if stable v1 wire formats are compatible, package API and protocol details can move independently. The provider should not use an unconstrained caret dependency and hope deduplication works. Pin a tested pair or keep the CLI's SDK nested and test the provider's chosen SDK against the exact CLI artifact. Record both versions in diagnostics.

## 4. Gemini CLI ACP implementation

The supported launch mode is:

```bash
gemini --acp
```

The npm package exposes `dist/index.js` as both `main` and the `gemini` bin. Therefore a shell-independent bundled launch is feasible:

```text
spawn(process.execPath, [require.resolve('@google/gemini-cli'), '--acp'], ...)
```

The actual resolver should use ESM-safe module resolution and verify the path remains under the installed package. Invoking Node avoids executable bits, shebang handling, `.cmd` behavior, and PATH differences. No shell should be used.

Gemini CLI currently requires Node 20+, matching a reasonable provider floor. Version 0.58.0's own unpacked npm artifact is about 98 MB, excluding transitive modules. Its dependency tree includes native keytar/PTY packages. Prebuilt binaries may make installation seamless on common targets, but source-build prerequisites and Alpine/musl support require packed-install testing before claiming zero setup.

### Initialize and authentication

`initialize` advertises:

- auth methods for Google login, Gemini API key, Vertex AI, and gateway;
- `loadSession: true`;
- prompt image, audio, and embedded-context support;
- MCP HTTP and SSE support.

The source initializes core configuration during handshake. Authentication parses the selected method and accepts Gemini API keys through request `_meta['api-key']`. It persists the selected auth type in user settings and delegates refresh/login to Gemini CLI core. `session/new` attempts auth again from loaded settings or supplied details and fails with ACP error `-32000` if required credentials are missing.

A provider should consume advertised methods rather than assume IDs forever. Initially support Google login and Gemini API key; label Vertex/gateway unsupported until their required fields and persistence semantics are designed.

### Sessions and model discovery

`session/new` creates a UUID, loads settings for cwd, authenticates, optionally installs ACP-backed filesystem service, initializes config and MCP, starts chat, and returns:

- `sessionId`;
- modes and current mode;
- models with `availableModels` and `currentModelId`.

Model choices can depend on account access, preview eligibility, auth type, feature flags, and dynamic model configuration. This confirms that hard-coded provider catalogs go stale and that discovery belongs after authentication. ACP's `unstable_setSessionModel` sets the model for a live session. Despite “unstable” in the method name, it is the relevant current control and must be feature-negotiated/tested.

`session/load` reconstructs Gemini CLI's own recorded conversation and streams history back to the client before/around the response. A client must suppress replay updates so old text is not shown as new generation. Open regressions make this unsuitable as the only recovery mechanism.

### Prompt stream and usage

Gemini sends:

- model content as `agent_message_chunk` text blocks;
- thought summaries as `agent_thought_chunk` text blocks;
- tool start/progress/completion as tool updates;
- a final `PromptResponse`.

Current usage is aggregated from Gemini events and returned under:

```json
{
  "_meta": {
    "quota": {
      "token_count": {
        "input_tokens": 123,
        "output_tokens": 45
      },
      "model_usage": [
        {
          "model": "...",
          "token_count": { "input_tokens": 123, "output_tokens": 45 }
        }
      ]
    }
  }
}
```

This metadata is not a reason to estimate token counts. Parse it as a versioned extension, preserve unknown shape, and use zeros when absent. Cache-read/write and separate thinking counts are not currently available there.

Observed stop reasons include `end_turn`, `cancelled`, `max_turn_requests`, and `max_tokens`. Internal stream errors can be normalized by Gemini to `end_turn`, while rate limits and other failures can become JSON-RPC errors. Preserve `rawStopReason` and stderr diagnostics.

### Gemini tool and permission behavior

Gemini CLI is an agent, not a raw model endpoint. Inside one `session/prompt`, it may execute multiple core or MCP tools and continue model turns before returning. For permission-gated tools it sends a permission request containing the tool call, locations, optional explanation or diff, and offered choices. Once approved, Gemini executes the tool itself and sends completion content/diffs.

This creates an impedance mismatch with Pi's usual model loop. Mapping a completed Gemini tool update to a Pi `toolCall` would make Pi execute it a second time. The safe baseline was (superseded for display: the current provider does not render native tool progress at all, see PROTOCOL-MAPPING.md):

- stream Gemini-native tool progress as thinking/activity text;
- use a special Pi tool round trip only to obtain permission;
- never present an already executed Gemini tool as an executable Pi call;
- add display-only replay cards later only if clearly non-executing.

This baseline also creates transcript asymmetry: Pi sees no structured tool call/result for tools Gemini executes internally, so a later provider sees only bounded activity/final text rather than exact structured operations. Document and test cross-provider handoff accordingly.

Gemini accepts MCP server descriptors on session creation. To meet the 1.0 first-class requirement, a no-patch bridge must expose active Pi/marketplace tools, park their calls, and let Pi execute them in its normal loop, as the Antigravity reference demonstrates. It is separate from Gemini's core tools and requires authentication, namespacing/collision policy, and explicit exclusion of the permission broker tool.

### Filesystem proxy behavior

If the client advertises fs support, Gemini wraps its file service. Current code uses the ACP client for files inside cwd but deliberately falls back to Gemini's native filesystem outside cwd and under `~/.gemini`. This means fs capability is useful for editor-buffer consistency but is **not** a complete sandbox. Gemini's shell and other process capabilities are also outside the ACP callback boundary.

Start with fs disabled. A later implementation should validate canonical paths and use the Pi/workspace filesystem only after a threat review. Never advertise terminal capability without an implementation.

## 5. Reliability evidence and implications

Issue reports are not protocol specifications, but they identify cases that contract tests must cover:

| Upstream report | Consequence for this provider |
|---|---|
| #24017: sequential prompts dropped/merged; startup overhead | serialize each session; ten-turn real test; warm reuse; timeouts |
| #27913: `session/load` did not restore memory | reconstruction fallback; load cannot be sole source of truth |
| #28693/#28775: same-minute load can damage resumability | default away from cross-process load until pinned build passes destructive canary |
| #26448: fs structured ENOENT mismatch | exact error compatibility tests before enabling fs |
| #28361: `tools.core` can suppress MCP tools | do not set `tools.core: []`; test targeted exclude/allow strategy |
| #22647: plain stdout corrupts protocol | strict framing, bounded noise diagnostics, real subprocess tests |
| #13913: subprocess hang/no response | handshake deadlines, child exit race, teardown escalation |

The provider should capture stderr separately and reject non-JSON stdout. Silently discarding arbitrary stdout can hide protocol corruption; tolerate known leading blank/banner lines only behind a tested compatibility rule and report the count in diagnostics.

## 6. Context ownership findings

Pi provides the complete effective context on each stream call; Gemini ACP sessions maintain their own history. Sending all Pi messages every turn to the same ACP session duplicates history and wastes tokens. Sending only the latest user message loses:

- Pi system prompt and project instructions;
- compacted summaries;
- turns made with another provider;
- Pi-side tool results;
- history after process/session recovery.

The correct solution is not either extreme. Bind a context watermark to each ACP session:

- **fresh binding:** one bounded reconstruction resource containing system prompt plus prior context, then current user content;
- **warm binding:** only current user content plus newly unseen external delta;
- **permission continuation:** no new prompt; resolve the pending ACP request and continue reading the same turn;
- **recovery:** create a fresh ACP session and reconstruct from Pi; optionally attempt load only when safe.

Hashes/fingerprints should detect rewinds, branching, compaction, and provider handoff. The binding must be invalidated if cwd changes unexpectedly or a message prefix no longer matches.

## 7. Performance implications

- Lazy start: importing an extension must not spawn a 98 MB CLI runtime.
- Warm reuse: one process can host multiple ACP sessions, but a conservative initial pool may use one process per active Pi session to simplify routing and fault isolation. Measure before multiplexing.
- Queue prompts per ACP session. Do not serialize unrelated sessions globally if the process/CLI proves safe for multiplexing.
- Set handshake/session operation deadlines and prompt idle/overall deadlines. Prompt timeout pauses only where a user is actively deciding permission.
- Idle cleanup around 10–15 minutes is a reasonable initial default; timers must `unref()`.
- Model refresh should reuse a process when possible, but must not leak its probe session into chat context.

## 8. Resulting decisions

1. Use a complete Pi provider and standard package manifest.
2. Bundle and pin the official CLI; bundled path is authoritative.
3. Use stable ACP v1 and an official SDK where compatible; isolate it behind an adapter.
4. Model discovery comes from authenticated `session/new`; ship a fallback catalog.
5. Set the actual ACP session model before each prompt.
6. Preserve a live session with watermarked delta injection; reconstruct instead of trusting `session/load` by default.
7. Treat Gemini-native tools as a closed loop; permissions cross into Pi and completed tools do not re-execute. Bridge active Pi tools through authenticated MCP before 1.0 so marketplace tools retain Pi execution semantics.
8. Start with fs/terminal client capabilities disabled.
9. Parse actual `_meta.quota`; costs remain zero/unknown unless documented rates can be associated correctly.
10. Pin upgrades behind real subprocess and package-install gates.
