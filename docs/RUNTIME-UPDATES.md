# Runtime updates

The provider installs Google Antigravity ACP separately from the npm package. Runtime updates default to `manual`. In `automatic` mode, managed installations check at most once every 24 hours when Antigravity is first used. External executables selected through `AGY_ACP_BIN`, `~/.local/bin`, or `PATH` are never replaced.

## Trust model

The official ACP registry identifies Google's current release and download URLs, but it does not publish checksums. The provider therefore does not execute a registry artifact based on the registry URL alone.

`runtime-manifest.json` is an Ed25519-signed release catalog containing, per platform:

- the exact `dl.google.com` archive URL;
- archive SHA-256 and decoded byte size;
- the only two permitted archive member names and their exact sizes;
- launch arguments.

The installer verifies the signature using the public key embedded in the package, limits metadata response sizes, checks that the signed release agrees with the official registry, downloads into a private staging directory, enforces archive hash and size, rejects extra or unsafe ZIP members, and starts the extracted binary. It activates the immutable hash-named release only if ACP `initialize` reports protocol 1, agent name `antigravity-acp`, and the signed version. The prior release remains available while the `current` pointer changes atomically.

This follows the important installation properties used by T3 Code's open-source Antigravity integration: immutable hash-addressed releases, exact archive/member sizes, strict extraction, pre-activation ACP validation, and a separate active pointer. T3 Code also pins reviewed release metadata rather than blindly executing the newest registry URL.

## Modes

```text
/antigravity-acp updates automatic
/antigravity-acp updates notify
/antigravity-acp updates manual
/antigravity-acp update
```

- `automatic` installs the newest signed release before opening the next managed ACP process.
- `notify` checks and reports an available signed release without installing it, and never installs a missing runtime implicitly.
- `manual` performs no background update check and never installs a missing runtime implicitly; `/antigravity-acp setup` installs one and `/antigravity-acp update` forces an update.

If the registry is unavailable, a working managed runtime remains usable. A first installation requires the official registry to be reachable; later checks may use cached registry metadata and the bundled or cached signed manifest. If the official registry is newer than the signed catalog, installation waits for the catalog automation instead of running an unverified artifact.

## Publishing new runtime metadata

The scheduled `update-runtime-manifest.yml` workflow checks the official registry daily. When it sees a new version, it downloads every platform archive, computes SHA-256 and decoded archive size, verifies the exact two-file layout, records member sizes, signs the updated catalog, tests signature verification, and commits only `runtime-manifest.json`.

The repository must define the Actions secret `ACP_RUNTIME_MANIFEST_PRIVATE_KEY` containing the Ed25519 private key corresponding to the public key in `src/acp/runtime-manifest.ts`. The private key must never be committed.

For a manual refresh:

```bash
npm run refresh:runtime-manifest
ACP_RUNTIME_MANIFEST_PRIVATE_KEY_PATH=/secure/path/runtime-manifest-private.pem \
  npm run sign:runtime-manifest
npx vitest run test/runtime-manifest.test.ts
```

Changing the signing key requires an npm provider release containing the replacement public key and a transition plan for installed clients.
