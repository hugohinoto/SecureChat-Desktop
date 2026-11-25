# SecureChat Desktop - User guide

## Startup screen and app icon
The startup splash screen uses the supplied horizontal SecureChat logo. The Windows executable and application window use the supplied square mark as their icon. The artwork is included as local SVG assets; no network request is needed to display it.

## First launch
1. Start SecureChat Desktop.
2. Create a master password of at least 12 characters.
3. Keep the password in a safe password manager. It is not stored in the app.
4. Create a chat and write messages. They are encrypted and stored locally.

## Portable use
For the Windows portable build, keep the executable and the portable-data folder together. After first launch, the folder will contain the encrypted vault file. To move to another PC, close the app, copy both the executable and the entire portable-data folder, then unlock with the same master password.

Do not copy only the executable. Without the portable-data folder, the local chat data is not included. Keep a separate backup of the encrypted portable-data folder.

## Offline behavior
The app can launch and read/write its local vault without an internet connection. Messages placed in the local outbox are not delivered to recipients in this version. The app does not claim delivery or read receipts.

## Password recovery
There is no password reset or recovery key. A forgotten master password cannot decrypt the vault. Reinstalling the app does not recover it.

## Current scope
This initial desktop foundation is local/offline only. It is not yet connected to SecureChat account login, contact verification, device enrollment, end-to-end encrypted delivery, or server-side synchronization.
