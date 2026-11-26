# Desktop post-quantum readiness

**Status: investigation only. Runtime cryptography is unchanged.**

The canonical readiness review is maintained in the main repository:

https://github.com/hugohinoto/SecureChat/blob/main/docs/pq-implementation-readiness.md

The current desktop renderer bundles the same Matrix Rust/WASM crypto-v2 source as the web client. This preserves protocol parity today, but the current Matrix Olm/Megolm implementation is classical cryptography.

Desktop must not integrate a separate PQ protocol implementation. Any selected PQ adapter must be shared with the web client and verified in the portable Electron build, including:
- the same pinned implementation and protocol version;
- identical test vectors and serialized wire messages;
- local encrypted storage of device private keys and ratchet state;
- no private crypto material crossing Electron preload/IPC boundaries;
- CSP-compatible WASM loading and offline startup;
- crash/restart recovery and concurrent-instance protection;
- fail-closed negotiation with no plaintext or silent classical fallback.

The official Signal libsignal repository is a candidate for technical evaluation, not an approved dependency. Its current repository license is AGPL-3.0, so licensing and distribution review is required before adoption. Do not change SecureChat's Apache-2.0 project license implicitly.

No PQ runtime code, dependency, database migration, or security claim is introduced by this document.
