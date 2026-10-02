# Antigravity migration

Status date: 2026-09-04

## Why the target changed

The original implementation bundled `@google/gemini-cli@0.58.0` and attempted its `oauth-personal` ACP authentication flow. That flow now reports that Gemini Code Assist for individuals is no longer supported. Treating this as a missing local credential was an architectural error: retrying `/login` could not make the retired service path viable.

The provider now targets Google's Antigravity product surface instead:

- official `agy_acp_server.par` ACP server;
- Antigravity OAuth/token state under `~/.gemini/antigravity-acp/`;
- Antigravity model slugs and effort tiers;
- `@estebanforge/pi-antigravity-bridge` 1.4.1 as the primary setup and behavior reference.

## Implemented migration

- Removed the production dependency on `@google/gemini-cli`.
- Launches the Antigravity ACP server under the existing process-tree supervisor.
- Resolves `AGY_ACP_BIN`, user and managed install paths, and `PATH`.
- Uses the bridge's reviewed ACP registry installer when no server is present.
- Renamed Pi login/provider presentation to **Google Antigravity (ACP)**.
- Adds an SSH/headless OAuth relay because ACP 1.1.1 keeps its browser URL internal: a private `BROWSER` shim captures the URL, Pi displays it, and a user-pasted loopback callback is strictly validated and forwarded to the remote listener.
- Reads only Antigravity auth presence, never token values.
- Replaced stale Gemini 2.5 fallbacks with current Antigravity models. Effort-qualified ACP IDs are collapsed into one Pi model and selected dynamically through Pi's reasoning level.
- Updated real and authenticated tests to assert `agentInfo.name === "antigravity-acp"`.

## Verified live

Against authenticated `agy_acp_server_1.1.1` on Linux:

- ACP initialization negotiated protocol 1.
- The server advertised `oauth-personal`, enterprise, API-key, and agent-platform authentication.
- `session/new` returned the authenticated Antigravity catalog, including Gemini 3.8/3.7/3.6 Flash effort variants and Gemini 3.1 Pro variants.
- A real prompt completed with `stopReason: "end_turn"` and streamed the requested exact response.
- Both `session/set_model` and `session/set_config_option` were accepted by this server build.
- Pi reasoning levels now map to exact ACP variants (`low`, `medium`, or `high`) through `session/set_model`; unsupported levels are hidden or safely clamped.
- Antigravity session permissions support persisted `default`, `auto_edit`, and `yolo` modes through `session/set_mode`; upstream defaulted fresh installations to `yolo`; this fork defaults to `default` and the setup wizard offers it first.

## Documentation status

The older design/research documents contain useful Pi and ACP analysis, but statements requiring bundled Gemini CLI or individual Gemini Code Assist authentication are superseded by this document. They must not be used as current setup guidance.
