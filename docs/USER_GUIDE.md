# SecureChat Desktop - User guide

## Startup and brand
The horizontal SecureChat logo is shown during startup. The square mark is used for the Windows application and window icon.

## Installation-free Windows portable app
The Windows release is a single portable EXE, not an installer. Double-click it to launch; Node.js, npm, Electron, and other application runtimes do not need to be installed separately. The app extracts its bundled runtime into a temporary directory while it runs. It does not register an installed application, create Start menu entries, or require administrator privileges.

On first launch, a `portable-data` folder is created beside the EXE. It stores the server URL, login session, and browser-side device state. Keep this folder with the EXE when moving the app to another PC. The EXE can start without that folder, but the saved settings and login session will not travel with it.

## First connection
1. Start SecureChat Desktop.
2. Enter the HTTPS root URL of the deployed SecureChat service.
3. Select "保存して接続".
4. Sign in with your existing SecureChat account, or register with a valid invitation code.

The production service URL is not hard-coded into this release. The URL is stored in portable-data/server-config.json for portable builds. Change it from the SecureChat menu when needed. Only HTTPS origins are accepted. HTTP is allowed only for loopback development when SECURECHAT_ALLOW_INSECURE_DEV=1 is set.

## Online features
The desktop app opens the existing SecureChat web client in an Electron window. Authentication, contacts, mutual OTP verification, real-time WebSocket chat, Crypto Protocol v1/v2 client, device management, SecureDrop, announcements, and bug reports are supplied by the connected SecureChat deployment. The desktop app does not implement a second cryptographic protocol or bypass the web client's fingerprint verification and bilateral migration controls.

Crypto v2 must be evaluated using the security status shown by the active conversation. A feature flag or successful unit test alone is not proof of production-grade forward secrecy.

## Data and portable use
Keep the portable executable and its entire portable-data folder together. Electron's persistent profile stores the login session cookie and the web client's IndexedDB crypto state. Treat this folder as sensitive. Do not share it or copy it to an untrusted PC. If you copy the profile, you are also copying that device's local crypto state; use SecureChat's device-management and revocation flow when replacing or losing a device.

If an old vault.scv file exists from the offline prototype, this version leaves it untouched. It does not import or automatically send its queued messages to online contacts.

## Offline behavior
The login, synchronization, message delivery, and file transfer features require an internet connection. No message is marked delivered by this desktop wrapper while offline.

## Security
Remote content receives no Electron preload bridge or Node.js access. The main window is restricted to the configured HTTPS origin. External HTTPS links open in the system browser. The local connection settings page has a separate minimal preload and a restrictive Content Security Policy.
