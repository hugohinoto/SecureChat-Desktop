# Native desktop renderer and API transport

## Runtime layout

The desktop app now loads the SecureChat web client from files packaged under `renderer/web-client`. It no longer navigates its primary window to the remote SecureChat website.

- `index.html`, `app.js`, CSS, admin, bug-report, and SecureDrop pages are bundled locally.
- The offline vault page uses the same SecureChat stylesheet and workspace layout.
- The renderer has Node integration disabled, context isolation enabled, sandboxing enabled, and a restrictive CSP. Direct network connections from the renderer are disabled.
- Root-relative static paths are rewritten during the build. The Crypto v2 module is bundled locally with its WASM dependency.

## API bridge

The bundled web client retains the existing SecureChat API contract. A small bootstrap intercepts requests to `/api/*` and forwards them through a narrow preload IPC method.

The Main Process:
1. Accepts only same-origin `/api/*` paths against the configured server origin.
2. Restricts HTTP methods and request/response bodies to 32 MiB.
3. Sends the configured origin in the `Origin` header so existing same-origin protections remain active.
4. Keeps the HttpOnly session cookie outside the renderer and attaches it to API requests.
5. Persists the cookie only through Electron `safeStorage`; if OS encryption is unavailable, the session remains memory-only.
6. Allows only the explicit `X-Secure-Drop-*` headers required by encrypted file transfers.
7. Supports JSON requests and binary SecureDrop upload/download bodies.

No Worker API change or database migration is required for this transport layer. Existing cookie-based authentication, rate limits, API authorization, and server-side validation remain authoritative.

## Session handling

The session cookie is never returned by the preload bridge. It is stored as an OS-encrypted blob associated with the configured server origin. Changing the server origin invalidates the stored session. On systems where Electron reports that secure storage is unavailable, the app does not write the cookie to disk.

On Windows, OS-protected session data may not decrypt on a different computer or Windows account. Users may need to sign in again after moving a portable copy.

## Offline behavior

The offline page uses the same design tokens and workspace composition as the online page, but reads and writes only the local encrypted vault. It does not impersonate an online account, submit queued messages, or synchronize offline conversations. A successful reachability probe switches to the bundled online client; the vault is locked before the offline window is closed.

## Maintenance

The files under `src/web-client` are a source snapshot of the SecureChat `public/` client. When the web client changes, refresh this snapshot and rerun the desktop test suite. The desktop build rewrites local paths and bundles `crypto-v2.js` for file-based rendering.
