const encoder = new TextEncoder();
const VAULT_VERSION = 2;

function vaultError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function associatedData(userId, deviceId) {
  return encoder.encode("SecureChat device vault:v2\\n" + userId + "\\n" + deviceId);
}

async function deriveWrappingKey(rootKey, salt, userId, deviceId, cryptoApi) {
  return cryptoApi.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: encoder.encode("SecureChat device vault wrapping key:v2\\n" + userId + "\\n" + deviceId)
    },
    rootKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function createDeviceVaultRecord(userId, deviceId, storePassphrase, cryptoApi = globalThis.crypto) {
  if (typeof userId !== "string" || !/^[a-z0-9_]{3,32}$/.test(userId) ||
      typeof deviceId !== "string" || !/^SC_[A-Za-z0-9]{16,40}$/.test(deviceId) ||
      typeof storePassphrase !== "string" || storePassphrase.length < 32) {
    throw vaultError("CRYPTO_VAULT_INPUT_INVALID", "端末鍵保管領域の入力が不正です。");
  }
  const rootMaterial = cryptoApi.getRandomValues(new Uint8Array(32));
  let rootKey;
  try {
    rootKey = await cryptoApi.subtle.importKey("raw", rootMaterial, "HKDF", false, ["deriveKey"]);
  } finally {
    rootMaterial.fill(0);
  }
  const salt = cryptoApi.getRandomValues(new Uint8Array(32));
  const iv = cryptoApi.getRandomValues(new Uint8Array(12));
  const wrappingKey = await deriveWrappingKey(rootKey, salt, userId, deviceId, cryptoApi);
  const ciphertext = await cryptoApi.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: associatedData(userId, deviceId), tagLength: 128 },
    wrappingKey,
    encoder.encode(storePassphrase)
  );
  return {
    version: VAULT_VERSION,
    userId,
    deviceId,
    rootKey,
    salt,
    iv,
    ciphertext,
    createdAt: Date.now()
  };
}

export async function unlockDeviceVaultRecord(record, userId, cryptoApi = globalThis.crypto) {
  if (!record || record.userId !== userId || typeof record.deviceId !== "string") {
    throw vaultError("CRYPTO_VAULT_IDENTITY_MISMATCH", "端末鍵保管領域が別のアカウントに属しています。");
  }
  try {
    let passphraseBytes;
    if (record.version === VAULT_VERSION) {
      if (!record.rootKey || record.rootKey.algorithm?.name !== "HKDF" ||
          record.rootKey.extractable !== false ||
          !(record.salt instanceof Uint8Array) || record.salt.length !== 32 ||
          !(record.iv instanceof Uint8Array) || record.iv.length !== 12 ||
          !(record.ciphertext instanceof ArrayBuffer || ArrayBuffer.isView(record.ciphertext))) {
        throw vaultError("CRYPTO_VAULT_CORRUPT", "端末鍵保管領域の形式が壊れています。");
      }
      const wrappingKey = await deriveWrappingKey(record.rootKey, record.salt, userId, record.deviceId, cryptoApi);
      passphraseBytes = await cryptoApi.subtle.decrypt(
        { name: "AES-GCM", iv: record.iv, additionalData: associatedData(userId, record.deviceId), tagLength: 128 },
        wrappingKey,
        record.ciphertext
      );
      return { storePassphrase: new TextDecoder().decode(passphraseBytes), upgradedRecord: null };
    }

    // Backward-compatible upgrade for the original AES-GCM wrapping-key record.
    if ((record.version === undefined || record.version === 1) &&
        record.wrappingKey && record.wrappingKey.algorithm?.name === "AES-GCM" &&
        record.wrappingKey.extractable === false &&
        record.iv && record.ciphertext) {
      passphraseBytes = await cryptoApi.subtle.decrypt(
        { name: "AES-GCM", iv: record.iv },
        record.wrappingKey,
        record.ciphertext
      );
      const storePassphrase = new TextDecoder().decode(passphraseBytes);
      const upgradedRecord = await createDeviceVaultRecord(userId, record.deviceId, storePassphrase, cryptoApi);
      upgradedRecord.createdAt = Number(record.createdAt || upgradedRecord.createdAt);
      return { storePassphrase, upgradedRecord };
    }
    throw vaultError("CRYPTO_VAULT_VERSION_UNSUPPORTED", "端末鍵保管領域のバージョンに対応していません。");
  } catch (error) {
    if (error?.code) throw error;
    throw vaultError("CRYPTO_VAULT_DECRYPT_FAILED", "端末鍵保管領域を復号できません。保存データを削除せず、復旧手順を確認してください。");
  }
}
