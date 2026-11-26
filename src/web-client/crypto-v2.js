import { createDeviceVaultRecord, unlockDeviceVaultRecord } from "./device-vault.js";
import {
  initAsync,
  OlmMachine,
  UserId,
  DeviceId,
  RoomId,
  RequestType,
  DeviceLists,
  EncryptionSettings,
  EncryptionAlgorithm,
  CollectStrategy,
  RoomSettings,
  DecryptionSettings,
  TrustRequirement,
  LocalTrust
} from "@matrix-org/matrix-sdk-crypto-wasm";

const MATRIX_SERVER = "securechat.invalid";
const VAULT_DB = "securechat-crypto-v2-vault";
const VAULT_STORE = "devices";
const DEVICE_HEADER = "X-SecureChat-Device";
// One Megolm session per message: session keys are delivered through the Olm Double Ratchet.
// Never reuse a group ratchet for a second message; a Megolm-key compromise is limited to one message.
const machines = new Map();
const initializers = new Map();
const roomLocks = new Map();
const syncLocks = new Map();
const machineLocks = new Map();
const deviceOwnership = new Map();

function toBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value) {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}

function toBase64Url(bytes) {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function matrixUserId(userId) {
  return "@" + userId + ":" + MATRIX_SERVER;
}

function parseMatrixUserId(value) {
  const match = typeof value === "string" && value.match(/^@([a-z0-9_]{3,32}):securechat\.invalid$/);
  if (!match) throw cryptoError("CRYPTO_USER_ID_INVALID", "暗号化ユーザーIDを確認できません。");
  return match[1];
}

function cryptoError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function openVault() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(VAULT_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(VAULT_STORE)) {
        request.result.createObjectStore(VAULT_STORE, { keyPath: "userId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function createDeviceVault(userId) {
  const deviceId = "SC_" + crypto.randomUUID().replace(/-/g, "").slice(0, 32);
  const storePassphrase = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const candidate = await createDeviceVaultRecord(userId, deviceId, storePassphrase);

  // IndexedDB readwrite transactions serialize across tabs on the same origin.
  // Preserve an existing device ID and passphrase so the encrypted Olm store
  // and its ratchet state remain addressable during the v1 -> v2 vault upgrade.
  const db = await openVault();
  const record = await new Promise((resolve, reject) => {
    const transaction = db.transaction(VAULT_STORE, "readwrite");
    const store = transaction.objectStore(VAULT_STORE);
    let selected = null;
    const request = store.get(userId);
    request.onsuccess = () => {
      selected = request.result || candidate;
      if (!request.result) store.add(candidate);
    };
    request.onerror = () => transaction.abort();
    transaction.oncomplete = () => resolve(selected);
    transaction.onerror = () => reject(transaction.error || new Error("CRYPTO_VAULT_TRANSACTION_FAILED"));
    transaction.onabort = () => reject(transaction.error || new Error("CRYPTO_VAULT_TRANSACTION_ABORTED"));
  }).finally(() => db.close());

  const unlocked = await unlockDeviceVaultRecord(record, userId);
  if (!record?.deviceId || !unlocked.storePassphrase) {
    throw cryptoError("CRYPTO_VAULT_CORRUPT", "この端末の暗号鍵保管領域が破損しています。復旧操作なしに削除しないでください。");
  }
  if (unlocked.upgradedRecord) {
    const upgradeDb = await openVault();
    try {
      await new Promise((resolve, reject) => {
        const transaction = upgradeDb.transaction(VAULT_STORE, "readwrite");
        const store = transaction.objectStore(VAULT_STORE);
        const request = store.get(userId);
        request.onsuccess = () => {
          const current = request.result;
          if (!current || current.deviceId !== record.deviceId) {
            transaction.abort();
            return;
          }
          store.put(unlocked.upgradedRecord);
        };
        request.onerror = () => transaction.abort();
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error("CRYPTO_VAULT_UPGRADE_FAILED"));
        transaction.onabort = () => reject(transaction.error || new Error("CRYPTO_VAULT_UPGRADE_ABORTED"));
      });
    } finally {
      upgradeDb.close();
    }
  }
  return {
    deviceId: record.deviceId,
    storePassphrase: unlocked.storePassphrase,
    storeName: "securechat-olm-v2-" + userId + "-" + record.deviceId
  };
}

async function api(path, { deviceId, method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(deviceId ? { [DEVICE_HEADER]: deviceId } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = typeof data.error === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(data.error)
      ? data.error : "CRYPTO_HTTP_" + response.status;
    throw cryptoError(code, data.message || "暗号化サービスとの通信に失敗しました。");
  }
  return data;
}

function deviceAuthorizationMessage(userId, deviceId, curve25519Key, ed25519Key) {
  return new TextEncoder().encode(
    "SecureChat device authorization:v2\n" +
    matrixUserId(userId) + "\n" + deviceId + "\n" +
    curve25519Key + "\n" + ed25519Key
  );
}

async function signDeviceAuthorization(context, deviceKeys) {
  const deviceId = deviceKeys.device_id;
  const curve25519Key = deviceKeys.keys?.["curve25519:" + deviceId];
  const ed25519Key = deviceKeys.keys?.["ed25519:" + deviceId];
  if (!curve25519Key || !ed25519Key || !context.signingPrivateKey) {
    throw cryptoError("CRYPTO_DEVICE_KEYS_INVALID", "端末公開鍵またはアカウント署名鍵がありません。");
  }
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    context.signingPrivateKey,
    deviceAuthorizationMessage(context.userId, deviceId, curve25519Key, ed25519Key)
  );
  return toBase64(new Uint8Array(signature));
}

function parseRequestBody(request) {
  try {
    return typeof request.body === "string" ? JSON.parse(request.body) : request.body;
  } catch {
    throw cryptoError("CRYPTO_SDK_REQUEST_INVALID", "暗号SDKが不正な通信要求を生成しました。");
  }
}

async function trustVerifiedDevices(context, devices) {
  for (const item of devices) {
    const userId = new UserId(item.matrixUserId);
    const deviceId = new DeviceId(item.deviceId);
    const device = await context.machine.getDevice(userId, deviceId);
    if (!device) continue;
    try {
      await device.setLocalTrust(LocalTrust.Verified);
    } finally {
      device.free();
    }
  }
}

async function processOutgoingRequest(context, request) {
  if (!request) return;
  try {
    const body = parseRequestBody(request);

    if (request.type === RequestType.KeysUpload) {
      const authorization = body.device_keys
        ? await signDeviceAuthorization(context, body.device_keys)
        : undefined;
      const result = await api("/api/crypto/keys/upload", {
        deviceId: context.deviceId,
        method: "POST",
        body: { ...body, ...(authorization ? { account_authorization_signature: authorization } : {}) }
      });
      await context.machine.markRequestAsSent(request.id, request.type, JSON.stringify(result));
      return;
    }

    if (request.type === RequestType.KeysQuery) {
      const result = await api("/api/crypto/keys/query", {
        deviceId: context.deviceId,
        method: "POST",
        body
      });
      const verifiedDevices = [];
      for (const [mxUserId, userDevices] of Object.entries(result.device_keys || {})) {
        const userId = parseMatrixUserId(mxUserId);
        for (const [deviceId, deviceKeys] of Object.entries(userDevices || {})) {
          const authorization = result.device_authorizations?.[mxUserId]?.[deviceId];
          const accepted = await context.authorizeDevice(userId, deviceId, deviceKeys, authorization);
          if (!accepted) {
            delete userDevices[deviceId];
            continue;
          }
          verifiedDevices.push({ matrixUserId: mxUserId, deviceId });
        }
      }
      const { device_authorizations: _ignored, ...matrixResponse } = result;
      await context.machine.markRequestAsSent(request.id, request.type, JSON.stringify(matrixResponse));
      await trustVerifiedDevices(context, verifiedDevices);
      return;
    }

    if (request.type === RequestType.KeysClaim) {
      const result = await api("/api/crypto/keys/claim", {
        deviceId: context.deviceId,
        method: "POST",
        body
      });
      await context.machine.markRequestAsSent(request.id, request.type, JSON.stringify(result));
      return;
    }

    if (request.type === RequestType.ToDevice) {
      await api("/api/crypto/to-device", {
        deviceId: context.deviceId,
        method: "POST",
        body: {
          event_type: request.event_type,
          transaction_id: request.txn_id || request.id,
          messages: body.messages || {}
        }
      });
      await context.machine.markRequestAsSent(request.id, request.type, JSON.stringify({}));
      return;
    }

    throw cryptoError(
      "CRYPTO_SDK_REQUEST_UNSUPPORTED",
      "まだ対応していない暗号プロトコル要求です（type " + request.type + "）。安全のため処理を中止しました。"
    );
  } finally {
    request.free?.();
  }
}
async function flushOutgoing(context) {
  const requests = await context.machine.outgoingRequests();
  for (const request of requests) await processOutgoingRequest(context, request);
}

async function withLock(map, key, callback) {
  const previous = map.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  const queued = previous.then(() => current);
  map.set(key, queued);
  await previous;
  try {
    return await callback();
  } finally {
    release();
    if (map.get(key) === queued) map.delete(key);
  }
}

const withRoomLock = (key, callback) => withLock(roomLocks, key, callback);
const withSyncLock = (key, callback) => withLock(syncLocks, key, callback);
const withMachineLock = (key, callback) => withLock(machineLocks, key, callback);

async function acquireDeviceOwnership(userId) {
  if (deviceOwnership.has(userId)) return;
  const lockManager = globalThis.navigator?.locks;
  if (!lockManager?.request) {
    throw cryptoError(
      "CRYPTO_CROSS_TAB_LOCK_UNAVAILABLE",
      "このブラウザーは複数タブ間の暗号鍵ロックに対応していません。安全のため前方秘匿性v2をこの環境では有効にできません。"
    );
  }
  let resolveAcquired, rejectAcquired, releaseHold;
  const acquired = new Promise((resolve, reject) => {
    resolveAcquired = resolve;
    rejectAcquired = reject;
  });
  const hold = new Promise(resolve => { releaseHold = resolve; });
  const state = { release: releaseHold, request: null };
  deviceOwnership.set(userId, state);
  state.request = lockManager.request(
    "securechat-crypto-v2-device:" + userId,
    { mode: "exclusive", ifAvailable: true },
    async lock => {
      if (!lock) {
        rejectAcquired(cryptoError(
          "CRYPTO_DEVICE_ALREADY_OPEN_IN_ANOTHER_TAB",
          "この端末の暗号化セッションは別のタブで使用中です。安全のため同じブラウザーでは1つのタブだけでv2を使用してください。"
        ));
        return;
      }
      resolveAcquired();
      await hold;
    }
  ).catch(error => rejectAcquired(error));
  try {
    await acquired;
  } catch (error) {
    deviceOwnership.delete(userId);
    state.release();
    throw error;
  }
}

function releaseDeviceOwnership(userId) {
  const state = deviceOwnership.get(userId);
  if (!state) return;
  deviceOwnership.delete(userId);
  state.release();
}

export async function initializeCryptoV2(options) {
  const userId = String(options.userId || "").toLowerCase();
  if (!/^[a-z0-9_]{3,32}$/.test(userId)) throw cryptoError("CRYPTO_USER_ID_INVALID", "ユーザーIDが不正です。");
  if (typeof options.internalUserId !== "string" ||
      typeof options.authorizeDevice !== "function" || !options.signingPrivateKey) {
    throw cryptoError("CRYPTO_IDENTITY_REQUIRED", "アカウント本人確認鍵を読み込めません。");
  }
  if (machines.has(userId)) return machines.get(userId);
  if (initializers.has(userId)) return initializers.get(userId);
  const initializer = (async () => {
    await acquireDeviceOwnership(userId);
    try {
      if (machines.has(userId)) return machines.get(userId);
      await initAsync();
      const vault = await createDeviceVault(userId);
      const machine = await OlmMachine.initialize(
        new UserId(matrixUserId(userId)),
        new DeviceId(vault.deviceId),
        vault.storeName,
        vault.storePassphrase
      );
      const context = {
        userId,
        internalUserId: options.internalUserId,
        matrixUserId: matrixUserId(userId),
        deviceId: vault.deviceId,
        signingPrivateKey: options.signingPrivateKey,
        authorizeDevice: options.authorizeDevice,
        machine
      };
      machines.set(userId, context);
      await flushOutgoing(context);
      return context;
    } catch (error) {
      const context = machines.get(userId);
      if (context) {
        machines.delete(userId);
        try { context.machine.close(); } catch {}
      }
      releaseDeviceOwnership(userId);
      throw error;
    }
  })();
  initializers.set(userId, initializer);
  try {
    return await initializer;
  } finally {
    initializers.delete(userId);
  }
}

export function cryptoDeviceId(userId) {
  return machines.get(String(userId).toLowerCase())?.deviceId || null;
}

export async function cryptoV2Status(userId) {
  const context = machines.get(String(userId).toLowerCase());
  if (!context) return { initialized: false };
  const status = await api("/api/crypto/status", { deviceId: context.deviceId });
  return { ...status, initialized: true, deviceId: context.deviceId };
}

export async function syncCryptoV2(userId) {
  const key = String(userId).toLowerCase();
  return withMachineLock(key, () => withSyncLock(key, async () => {
    const context = machines.get(key);
    if (!context) throw cryptoError("CRYPTO_DEVICE_NOT_INITIALIZED", "この端末の暗号鍵が初期化されていません。");
    const data = await api("/api/crypto/sync", { deviceId: context.deviceId });
    const events = [];
    const affectedAccounts = new Set();
    for (const item of data.events || []) {
      if (!item?.event || typeof item.id !== "string") continue;
      if (item.event.type === "org.securechat.device_revoked") {
        const affectedUser = parseMatrixUserId(item.event.content?.affected_user_id);
        if (!affectedUser) {
          throw cryptoError("CRYPTO_REVOCATION_EVENT_INVALID", "端末失効通知の対象アカウントを検証できません。");
        }
        affectedAccounts.add(affectedUser);
        continue;
      }
      events.push({
        event_id: "$" + item.id.replace(/-/g, ""),
        type: item.event.type,
        sender: item.event.sender,
        origin_server_ts: Number(item.event.origin_server_ts || item.event.created_at || Date.now()),
        content: item.event.content
      });
    }
    // Each surviving device receives one control event per affected account.
    // Owners invalidate every outbound session; the other participant devices
    // invalidate only the direct conversations with the affected account.
    if (affectedAccounts.size) {
      const conversations = await api("/api/conversations");
      const roomsToInvalidate = new Set();
      for (const affectedUser of affectedAccounts) {
        for (const conversation of conversations.conversations || []) {
          if (affectedUser === context.userId || conversation.peer_user_id === affectedUser) {
            roomsToInvalidate.add(conversation.id);
          }
        }
      }
      for (const conversationId of roomsToInvalidate) {
        await withRoomLock(conversationId, async () => {
          const room = roomId(conversationId);
          try {
            await context.machine.invalidateGroupSession(room);
          } finally {
            room.free();
          }
        });
      }
      await context.machine.markAllTrackedUsersAsDirty();
    }
    const counts = new Map([["signed_curve25519", Number(data.one_time_key_counts?.signed_curve25519 || 0)]]);
    const unusedFallbackKeys = new Set(data.unused_fallback_key_types || []);
    const deviceLists = new DeviceLists([], []);
    try {
      await context.machine.receiveSyncChanges(
        JSON.stringify(events),
        deviceLists,
        counts,
        unusedFallbackKeys
      );
    } finally {
      deviceLists.free();
    }
    const eventIds = (data.events || []).map(item => item.id).filter(Boolean);
    if (eventIds.length) {
      await api("/api/crypto/sync/ack", {
        deviceId: context.deviceId,
        method: "POST",
        body: { event_ids: eventIds }
      });
    }
    await flushOutgoing(context);
    // The SDK requires missing Olm sessions to be checked after sync as well as
    // before sharing a room key. Keep this operation serialized per device.
    const missing = await context.machine.getMissingSessions([]);
    if (missing) await processOutgoingRequest(context, missing);
    await flushOutgoing(context);
    return { received: events.length };
  }));
}
async function registerAndTrustParticipants(context, peerUserId) {
  const participantIds = [context.userId, peerUserId].map(matrixUserId);
  const queryUsers = participantIds.map(id => new UserId(id));
  const query = context.machine.queryKeysForUsers(queryUsers);
  await processOutgoingRequest(context, query);
  await flushOutgoing(context);
  await withSyncLock(context.userId, async () => {
    const users = participantIds.map(id => new UserId(id));
    const missing = await context.machine.getMissingSessions(users);
    if (missing) await processOutgoingRequest(context, missing);
    await flushOutgoing(context);
  });
}
function roomId(conversationId) {
  return new RoomId("!" + conversationId.replace(/-/g, "") + ":" + MATRIX_SERVER);
}

async function prepareRoom(context, conversationId, peerUserId) {
  const room = roomId(conversationId);
  const roomSettings = new RoomSettings();
  try {
    roomSettings.algorithm = EncryptionAlgorithm.MegolmV1AesSha2;
    roomSettings.onlyAllowTrustedDevices = true;
    roomSettings.sessionRotationPeriodMessages = 1;
    roomSettings.sessionRotationPeriodMs = 60 * 60 * 1000;
    await context.machine.setRoomSettings(room, roomSettings);
  } finally {
    roomSettings.free();
  }

  await registerAndTrustParticipants(context, peerUserId);

  const settings = new EncryptionSettings();
  const sharingStrategy = CollectStrategy.onlyTrustedDevices();
  try {
    settings.algorithm = EncryptionAlgorithm.MegolmV1AesSha2;
    settings.rotationPeriod = 60n * 60n * 1_000_000n;
    settings.rotationPeriodMessages = 1n;
    settings.sharingStrategy = sharingStrategy;
    const requests = await context.machine.shareRoomKey(
      room,
      [new UserId(context.matrixUserId), new UserId(matrixUserId(peerUserId))],
      settings
    );
    for (const request of requests) await processOutgoingRequest(context, request);
  } finally {
    // Assigning the strategy transfers its WASM handle into EncryptionSettings.
    // Freeing the original wrapper here double-frees the Rust-owned pointer.
    settings.free();
    room.free();
  }
  await flushOutgoing(context);
}

export async function getConversationCryptoMode(userId, conversationId) {
  const context = machines.get(String(userId).toLowerCase());
  if (!context) throw cryptoError("CRYPTO_DEVICE_NOT_INITIALIZED", "この端末の暗号鍵が初期化されていません。");
  return api("/api/crypto/conversations/" + encodeURIComponent(conversationId) + "/mode", {
    deviceId: context.deviceId
  });
}

export async function prepareEncryptedConversation(userId, conversationId, peerUserId) {
  const key = String(userId).toLowerCase();
  const context = machines.get(key);
  if (!context) throw cryptoError("CRYPTO_DEVICE_NOT_INITIALIZED", "この端末の暗号鍵が初期化されていません。");
  await syncCryptoV2(userId);
  return withMachineLock(key, () => withRoomLock(conversationId, () => prepareRoom(context, conversationId, peerUserId)));
}

export async function approveAndPrepareConversation(userId, conversationId, peerUserId) {
  const key = String(userId).toLowerCase();
  const context = machines.get(key);
  if (!context) throw cryptoError("CRYPTO_DEVICE_NOT_INITIALIZED", "この端末の暗号鍵が初期化されていません。");
  await syncCryptoV2(userId);
  return withMachineLock(key, async () => {
    const mode = await api("/api/crypto/conversations/" + encodeURIComponent(conversationId) + "/mode", {
      deviceId: context.deviceId,
      method: "POST",
      body: {}
    });
    if (mode.protocolVersion === 2) {
      await withRoomLock(conversationId, () => prepareRoom(context, conversationId, peerUserId));
    }
    return mode;
  });
}

export async function encryptConversationMessage(userId, conversationId, peerUserId, text) {
  const key = String(userId).toLowerCase();
  const context = machines.get(key);
  if (!context) throw cryptoError("CRYPTO_DEVICE_NOT_INITIALIZED", "この端末の暗号鍵が初期化されていません。");
  await syncCryptoV2(userId);
  return withMachineLock(key, () => withRoomLock(conversationId, async () => {
    await prepareRoom(context, conversationId, peerUserId);
    const room = roomId(conversationId);
    try {
      const encryptedJson = await context.machine.encryptRoomEvent(
        room,
        "m.room.message",
        JSON.stringify({ msgtype: "m.text", body: text })
      );
      let encryptedEvent;
      try { encryptedEvent = JSON.parse(encryptedJson); }
      catch { throw cryptoError("CRYPTO_ENVELOPE_INVALID", "暗号SDKのメッセージ形式を確認できません。"); }
      const result = await api(
        "/api/crypto/conversations/" + encodeURIComponent(conversationId) + "/messages",
        { deviceId: context.deviceId, method: "POST", body: { encrypted_event: encryptedEvent } }
      );
      return result;
    } finally {
      room.free();
    }
  }));
}

export async function decryptConversationMessage(userId, conversationId, expectedPeerUserId, message) {
  const key = String(userId).toLowerCase();
  const context = machines.get(key);
  if (!context) throw cryptoError("CRYPTO_DEVICE_NOT_INITIALIZED", "この端末の暗号鍵が初期化されていません。");
  return withMachineLock(key, async () => {
  let encryptedEvent;
  try { encryptedEvent = JSON.parse(message.ciphertext); }
  catch { throw cryptoError("CRYPTO_ENVELOPE_INVALID", "保存された暗号化メッセージの形式が不正です。"); }
  const senderUserId = message.sender_user_id === context.internalUserId
    ? context.matrixUserId
    : matrixUserId(expectedPeerUserId);
  const room = roomId(conversationId);
  const event = {
    type: "m.room.encrypted",
    event_id: "$" + message.id.replace(/-/g, ""),
    sender: senderUserId,
    origin_server_ts: Number(message.created_at),
    room_id: room.toString(),
    content: encryptedEvent
  };
  const settings = new DecryptionSettings(TrustRequirement.Untrusted);
  try {
    const decrypted = await context.machine.decryptRoomEvent(JSON.stringify(event), room, settings);
    try {
      if (decrypted.sender.toString() !== senderUserId) {
        throw cryptoError("CRYPTO_SENDER_MISMATCH", "暗号化イベントの送信者が会話参加者と一致しません。");
      }
      const senderDeviceId = decrypted.senderDevice?.toString();
      if (!senderDeviceId || senderDeviceId !== message.sender_device_id ||
          encryptedEvent.device_id !== message.sender_device_id) {
        throw cryptoError("CRYPTO_SENDER_DEVICE_MISMATCH", "暗号化メッセージの送信端末IDが一致しません。");
      }
      if (typeof encryptedEvent.sender_key !== "string" ||
          decrypted.senderCurve25519Key !== encryptedEvent.sender_key) {
        throw cryptoError("CRYPTO_SENDER_KEY_MISMATCH", "暗号化メッセージの送信公開鍵が一致しません。");
      }
      const senderDevice = await context.machine.getDevice(
        new UserId(senderUserId),
        new DeviceId(senderDeviceId)
      );
      if (!senderDevice) throw cryptoError("CRYPTO_SENDER_DEVICE_UNKNOWN", "送信端末が登録されていません。");
      let trusted = false;
      try { trusted = senderDevice.isLocallyTrusted() || senderDevice.isCrossSigningTrusted(); }
      finally { senderDevice.free(); }
      if (!trusted) {
        throw cryptoError("CRYPTO_SENDER_DEVICE_UNVERIFIED", "送信端末の本人確認ができていません。端末指紋を確認するまで本文を表示しません。");
      }
      const payload = JSON.parse(decrypted.event);
      if (payload.type !== "m.room.message" || typeof payload.content?.body !== "string") {
        throw cryptoError("CRYPTO_MESSAGE_FORMAT_INVALID", "復号したメッセージ形式が不正です。");
      }
      return payload.content.body;
    } finally {
      decrypted.free();
    }
  } finally {
    settings.free();
    room.free();
  }
  });
}

export async function listCryptoDevices(userId) {
  const context = machines.get(String(userId).toLowerCase());
  if (!context) throw cryptoError("CRYPTO_DEVICE_NOT_INITIALIZED", "この端末の暗号鍵が初期化されていません。");
  return api("/api/crypto/devices", { deviceId: context.deviceId });
}

export async function revokeCryptoDevice(userId, targetDeviceId) {
  const context = machines.get(String(userId).toLowerCase());
  if (!context) throw cryptoError("CRYPTO_DEVICE_NOT_INITIALIZED", "この端末の暗号鍵が初期化されていません。");
  if (targetDeviceId === context.deviceId) {
    throw cryptoError("CRYPTO_CANNOT_REVOKE_CURRENT_DEVICE", "現在使用中の端末はここから失効できません。");
  }
  return api("/api/crypto/devices/" + encodeURIComponent(targetDeviceId) + "/revoke", {
    deviceId: context.deviceId,
    method: "POST",
    body: {}
  });
}

export async function getCryptoDeviceState(userId) {
  const context = machines.get(String(userId).toLowerCase());
  if (!context) return { initialized: false, deviceId: null };
  const status = await api("/api/crypto/status", { deviceId: context.deviceId });
  return { initialized: true, deviceId: context.deviceId, ...status };
}

export async function closeCryptoV2(userId) {
  const key = String(userId).toLowerCase();
  try {
    await withMachineLock(key, async () => {
      const context = machines.get(key);
      if (context) {
        machines.delete(key);
        context.machine.close();
      }
    });
  } finally {
    releaseDeviceOwnership(key);
  }
}
