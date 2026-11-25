# Security notes

## Online desktop integration
- The online window loads the configured SecureChat HTTPS origin directly. It does not use a local HTTP proxy or rewrite authentication cookies.
- The remote SecureChat page receives no Electron preload bridge and no Node.js integration.
- The remote window uses context isolation, sandboxing, web security, and disabled webview support.
- Top-level navigation and redirects are restricted to the configured origin. External HTTPS links are handed to the system browser.
- The only preload bridge is attached to the local connection-settings page. Its IPC handlers validate the sender window and expose only read/save operations for the server origin.
- The connection settings page has a restrictive CSP and no network access.
- Server origins must use HTTPS. Plain HTTP is accepted only for loopback development when the explicit development environment flag is enabled.
- Electron's persistent profile stores SecureChat's HTTP-only login cookie and browser IndexedDB crypto state. Treat the complete portable-data folder as sensitive device material.

## Cryptographic boundary
- SecureChat Desktop does not implement a second messaging protocol, key exchange, or encryption format.
- Authentication, contact verification, Olm/Megolm, device management, and message encryption are supplied by the connected SecureChat web application and Worker deployment.
- Do not describe Crypto v2 as independently audited or production-secure solely because this desktop wrapper works. Follow the active SecureChat conversation's crypto status and the server project's multi-device test and independent-review gates.
- The old offline vault implementation remains in the source tree for compatibility with existing local vault files. This online client does not import or transmit its queued messages. Existing vault files are not deleted.

## Limitations
- A deployed SecureChat HTTPS URL must be configured before online use. No production URL is embedded in this repository.
- The desktop wrapper cannot make an unavailable or undeployed Worker service available. The SecureChat server, D1 migrations, Durable Object deployment, and required secrets must already be configured.
- Runtime memory erasure cannot be guaranteed; malware, keyloggers, compromised operating systems, or malicious builds can capture plaintext or credentials.
- Copying the portable profile copies the browser's local device crypto state. Use SecureChat device management and revocation when replacing or losing a device.

## Dependency audit status
The CI audit currently passes with a high-severity threshold. npm reports six moderate findings in the electron-builder build-time dependency tree involving minimatch versions below 11.0.1 (GHSA-g3hv-75wg-m249). This remains tracked and should be resolved through a compatibility-tested upstream update. Do not interpret the high-threshold CI pass as a zero-vulnerability audit.
