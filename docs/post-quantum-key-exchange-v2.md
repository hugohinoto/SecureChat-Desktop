# SecureChat V2 post-quantum key exchange — desktop parity

**Status: design only. No post-quantum key exchange is implemented or enabled in this desktop build.**

The desktop client bundles the web crypto client and must use the same reviewed protocol implementation, capability negotiation, wire format, and test vectors. It must not implement a separate cryptographic protocol in Electron.

The canonical architecture, security requirements, rollout gates, and current implementation limitations are maintained in the main repository:

https://github.com/hugohinoto/SecureChat/blob/main/docs/post-quantum-key-exchange-v2.md

## Desktop-specific requirements

- Keep device private keys and ratchet state inside the existing per-profile encrypted local crypto store.
- Do not expose private keys, KEM secrets, ratchet state, or session keys through preload/IPC or the Main Process network bridge.
- Use the same browser/WASM crypto adapter and pinned dependencies as the web client.
- Verify that the bundled WASM assets work under the desktop Content Security Policy and in the portable offline shell.
- Device enrollment, revocation, automatic refresh, and fail-closed downgrade handling must behave identically to the web client.
- Test restart/crash recovery and simultaneous app instances so a ratchet state cannot be rolled back or advanced twice.
- Do not claim PQ protection until the canonical implementation is integrated and all release gates pass.

The current Matrix Rust/WASM Olm/Megolm implementation is classical cryptography. The desktop app currently inherits that implementation; it does not gain post-quantum protection merely by bundling the web client.
