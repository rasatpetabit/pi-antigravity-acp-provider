# pi-antigravity-acp-provider

A first-class [Pi](https://github.com/earendil-works/pi) provider for **Google Antigravity** through its official ACP server.

> **Important:** this package no longer uses `@google/gemini-cli`. The Gemini CLI individual Code Assist login path was retired and is not a supported authentication route. Antigravity/`agy` is the target runtime.

## Features

- Registers `antigravity-acp/*` models backed by Google Antigravity.
- Uses ACP protocol v1 and the official TypeScript SDK.
- Collapses Antigravity's effort-qualified IDs into one entry per model; Pi's Shift+Tab reasoning control selects low/medium/high dynamically.
- Supports Pi streaming, cancellation, usage/quota metadata, lifecycle cleanup, and persisted ACP session restoration across Pi restarts.
- Routes compatible Pi tools through an authenticated loopback MCP bridge.
- Supports persisted `default`, `auto-edit`, and `yolo` Antigravity permission modes. The default is `default` (ask before sensitive operations), and a session that does not advertise and apply the configured mode is refused before any prompt; the single-use, fail-closed Pi permission broker handles the prompts.
- Advertises no ACP filesystem or terminal client capabilities.
- Provides setup, auth-health, logout/account-switching, qualification, quota, and runtime-update commands.
- Automatically checks for newer managed ACP runtimes once per day, with `automatic`, `notify`, and `manual` update modes.
- Uses an Ed25519-signed runtime catalog with exact Google artifact URLs, archive hashes and sizes, strict two-file extraction, pre-activation ACP identity/version validation, immutable releases, rollback retention, musl rejection, macOS quarantine cleanup, and Windows process-tree handling.

## New-user setup

Install from the official Pi package gallery/npm:

```bash
pi install npm:pi-antigravity-acp-provider
pi
```

To run from source instead:

```bash
git clone https://github.com/zacbemis/pi-antigravity-acp-provider.git
cd pi-antigravity-acp-provider
npm install
pi --no-extensions -e ./extensions/index.ts
```

In Pi:

1. Run `/antigravity-acp setup` to install the signed runtime (required while runtime updates are `manual` or `notify`, which never download implicitly) and for a runtime/auth preflight.
2. Run `/login`.
3. Choose **Sign in with an account**.
4. Choose **Google Antigravity (ACP)**.
5. If needed, wait for the official ACP server download and extraction. Progress is shown; the Linux build observed during development expands to about 1.8 GB.
6. Complete the Google login in the browser.
7. Run `/antigravity-acp setup` again to perform a network auth probe and model discovery.
8. Run `/model` and select one of the `antigravity-acp` models.
9. Press **Shift+Tab** to choose the reasoning effort. Flash models expose low, medium, and high; Pro exposes only the tiers advertised by Antigravity.
10. Send a prompt. The default permission mode is `default`, so Antigravity asks before sensitive commands and edits.

The provider first looks at `AGY_ACP_BIN`, then its verified managed `~/.local/opt/agy-acp/current/` release, `~/.local/bin/agy_acp_server.par`, and `PATH`. Set `AGY_ACP_BIN` to explicitly prefer an externally managed runtime. If absent, it installs the platform build published in the ACP registry. A global `agy` or `gemini` command is not required.

Standalone Pi builds also need Node.js to run the ACP supervisor. The provider looks for `node` or `nodejs` on `PATH`; set `NODE` to the executable path if neither is available. On NixOS with Home Manager, `programs.pi-coding-agent.extraPackages = [ pkgs.nodejs ];` adds Node to Pi's `PATH`. An explicit `SSL_CERT_FILE` is preserved; otherwise the provider uses `NIX_SSL_CERT_FILE` or a readable system CA bundle when available.

### SSH and headless Google login

When Pi is running over SSH, or on Linux without `DISPLAY`/`WAYLAND_DISPLAY`, `/login` automatically uses a manual browser relay:

1. Pi prints the Google authorization URL instead of trying to launch a browser on the server.
2. Open that URL in a browser on your local machine and finish Google sign-in.
3. Google redirects to an Antigravity loopback URL. The page may show a connection error because `127.0.0.1` refers to your local machine; copy the **complete final URL** from the browser address bar.
4. Paste that URL into Pi. The provider validates its host, port, path, and OAuth state, then relays it to Antigravity's loopback listener on the server. An SSH port-forward is not required.

Set `PI_ANTIGRAVITY_ACP_OAUTH_MODE=manual` to force this flow, or `PI_ANTIGRAVITY_ACP_OAUTH_MODE=browser` to force normal browser launch. OAuth URLs and callback codes are kept in a private temporary directory only for the duration of login and are never logged or persisted by this package.

For API-key authentication, choose **Enter an API key** and then **Antigravity Gemini API key** in `/login`, or set `GEMINI_API_KEY` before starting Pi.

Antigravity owns OAuth tokens under `~/.gemini/antigravity-acp/`; Pi stores only a non-secret configured marker. Existing `agy` CLI credentials and Gemini CLI credentials should not be assumed to authenticate this separate ACP server.

## Commands

```text
/antigravity-acp setup
/antigravity-acp doctor
/antigravity-acp doctor --verbose
/antigravity-acp status
/antigravity-acp quota
/antigravity-acp update
/antigravity-acp updates [automatic|notify|manual]
/antigravity-acp qualify
/antigravity-acp logout
/antigravity-acp account
/antigravity-acp permissions
/antigravity-acp permissions default
/antigravity-acp permissions auto-edit
/antigravity-acp permissions yolo
```

Permission and runtime-update modes are saved in `~/.pi/agent/antigravity-acp-provider/config.json`. Runtime updates default to `manual`; only `automatic` or an explicit `/antigravity-acp setup`/`update` downloads a runtime, and only provider-managed installations are replaced. A missing, corrupt or unrecognized config file falls back to `default`/`manual`; a legacy `gemini-acp-provider` config migrates only its `runtimeUpdates`. ACP session bindings are saved beside the config in `sessions.json`.

`logout`/`account` clears local Antigravity credentials and saved ACP sessions. Run Pi's `/logout` afterward to remove the Pi credential marker, then `/login` for the new account. `update` checks the official registry and installs its newest release only after matching it to the provider's signed runtime catalog. See [`docs/RUNTIME-UPDATES.md`](docs/RUNTIME-UPDATES.md).

## Development

```bash
npm run check
npm run test:real-acp  # initializes the installed Antigravity ACP server
npm run test:live      # sends a real authenticated prompt
npm run test:qualify   # live cancel, restore, MCP, model, and permission qualification
npm run test:packed
npm audit --audit-level=high

# Maintainer-only runtime catalog refresh/signing
npm run refresh:runtime-manifest
ACP_RUNTIME_MANIFEST_PRIVATE_KEY_PATH=/secure/key.pem npm run sign:runtime-manifest
```

## Security boundary

This launches a full coding agent with the user's OS privileges. **The `yolo` mode permits Antigravity-native commands and edits without confirmation**; the default is `default`, which prompts. Disabling ACP filesystem/terminal **client callbacks is not a sandbox** for Antigravity-native tools. Pi hooks govern tools routed through the `pi_` MCP namespace; Antigravity-native tools remain governed by Antigravity policy and ACP permission requests.

## Compatibility

The supported host is Pi 0.99.2 or a later 0.99.x release (`peerDependencies`: `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` `^0.99.2`, `typebox` `^1.3.27`); Pi 0.85 is not supported, because Pi 0.99 carries the system prompt and tool set as transcript messages. Pi supplies these packages at load time, so a deployed copy must not bundle them. The test suite and typecheck resolve them from an installed Pi host (`PI_HOST_ROOT` for vitest, `paths` in `tsconfig.json`), so they exercise the modules that Pi actually loads; the matching `devDependencies` exist for tooling only. The provider uses ACP SDK 0.19.1 and ACP protocol 1. The bundled signed catalog bootstraps Antigravity ACP 1.1.1 and can accept newer signed catalog releases without an npm update. ACP session setup allows up to two minutes for slow first-run initialization, while transport shutdown rejects pending requests immediately. The official registry currently provides Linux x64/ARM64, Windows x64/ARM64, and macOS ARM64 artifacts. Intel macOS has no pinned artifact, and Alpine/musl is rejected because Google's Linux build targets glibc.

During browser authentication, Chromium may write `Opening in existing browser session.` to the ACP process's inherited stdout. The transport ignores only that exact known compatibility line and reports its count in `doctor`; all other non-JSON stdout remains a fatal protocol error.

Managed installations also repair executable permissions for both the ACP server and its `localharness_external` helper. This repairs installations created by 0.1.3 and earlier, where OAuth could succeed but session creation failed with an opaque ACP `Internal error` because the extracted helper was not executable.

Earlier repository documents analyzing `@google/gemini-cli@0.58.0` describe the superseded implementation and are retained only as historical research. See [`docs/ANTIGRAVITY-MIGRATION.md`](docs/ANTIGRAVITY-MIGRATION.md).

## License

MIT
