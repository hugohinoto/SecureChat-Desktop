# SecureChat Desktop

Offline-first desktop companion for SecureChat.

## Status

Initial project setup is in progress. The first implementation targets Windows 11 and a portable folder distribution.

## Security model

- The local vault is encrypted with AES-256-GCM.
- A key is derived from a user-supplied master password using scrypt and a random salt.
- The password is never stored.
- The encrypted vault can be moved with the portable application folder and unlocked on another PC using the same master password.
- Losing the master password means the vault cannot be recovered.
- Offline messages remain local and queued; they are not delivered until a verified server integration is implemented.

## Development

Requirements: Node.js 24 or later and npm.

```sh
npm install
npm run build
npm test
npm start
```

## Build a Windows portable executable

```sh
npm run dist:win
```

The portable executable and its adjacent `portable-data` directory should be kept together when moving the app between PCs.

## Important

This project is not yet connected to the SecureChat production service. Do not treat local queue entries as delivered messages. Do not store your only copy of important data in a pre-release build.
