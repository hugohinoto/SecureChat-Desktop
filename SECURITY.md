# Security notes

## Implemented in this foundation
- Renderer uses context isolation, sandboxing, and disabled Node integration.
- A restrictive Content Security Policy blocks renderer network connections.
- Preload exposes a narrow set of IPC methods.
- Vault data is encrypted with AES-256-GCM.
- A random 128-bit salt and scrypt (N=32768, r=8, p=1) derive a 256-bit key from the master password.
- Each save uses a fresh random 96-bit GCM nonce and authenticated metadata.
- The password is not stored. Key buffers are overwritten on lock as a best-effort measure.

## Limitations
- Runtime memory erasure cannot be guaranteed; malware, keyloggers, compromised operating systems, or malicious builds can capture plaintext or passwords.
- Losing the master password means there is no recovery.
- The portable executable must travel with its adjacent portable-data folder. Keep a separate encrypted backup.
- The current outbox is local-only. No message is delivered to another user.
- Account authentication, device registration, Olm/Megolm, and forward-secrecy interoperability with SecureChat web are not implemented here.
- Do not claim production-ready end-to-end messaging until the desktop client integrates the existing protocol and passes multi-device security tests.

## Dependency audit status

The CI audit currently passes with a high-severity threshold. npm reports six moderate findings in the electron-builder build-time dependency tree involving minimatch versions below 11.0.1 (GHSA-g3hv-75wg-m249). This is a build-tool dependency issue, not a dependency loaded by the packaged app at runtime, but it remains tracked and should be resolved through a compatibility-tested upstream update. Do not interpret the high-threshold CI pass as a zero-vulnerability audit.
