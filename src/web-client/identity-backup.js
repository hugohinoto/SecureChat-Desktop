const textEncoder = new TextEncoder();

function encodeBase64(bytes) {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw);
}

function decodeBase64(value) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("IDENTITY_BACKUP_ENCODING_INVALID");
  }
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}

export const IDENTITY_BACKUP_ITERATIONS = 250000;

export async function deriveIdentityBackupKey(password, salt, cryptoApi = globalThis.crypto) {
  if (typeof password !== "string" || !password || !(salt instanceof Uint8Array) || salt.length !== 16) {
    throw new Error("IDENTITY_BACKUP_INPUT_INVALID");
  }
  const material = await cryptoApi.subtle.importKey(
    "raw", textEncoder.encode(password), "PBKDF2", false, ["deriveKey"]
  );
  return cryptoApi.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: IDENTITY_BACKUP_ITERATIONS },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptIdentityBackup(payload, password, cryptoApi = globalThis.crypto) {
  const salt = cryptoApi.getRandomValues(new Uint8Array(16));
  const iv = cryptoApi.getRandomValues(new Uint8Array(12));
  const key = await deriveIdentityBackupKey(password, salt, cryptoApi);
  const ciphertext = await cryptoApi.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    textEncoder.encode(JSON.stringify(payload))
  );
  return {
    version: 1,
    salt: encodeBase64(salt),
    iv: encodeBase64(iv),
    ciphertext: encodeBase64(new Uint8Array(ciphertext))
  };
}

export async function decryptIdentityBackup(backup, password, cryptoApi = globalThis.crypto) {
  try {
    if (!backup || backup.version !== 1) throw new Error("IDENTITY_BACKUP_VERSION_INVALID");
    const salt = decodeBase64(backup.salt);
    const iv = decodeBase64(backup.iv);
    const ciphertext = decodeBase64(backup.ciphertext);
    if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 64 || ciphertext.length > 12000) {
      throw new Error("IDENTITY_BACKUP_SIZE_INVALID");
    }
    const key = await deriveIdentityBackupKey(password, salt, cryptoApi);
    const plaintext = await cryptoApi.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    const payload = JSON.parse(new TextDecoder().decode(plaintext));
    if (payload?.version !== 1 ||
        typeof payload.identityPublicKey !== "string" ||
        typeof payload.identitySigningPublicKey !== "string" ||
        !payload.ecdhPrivateJwk ||
        !payload.signingPrivateJwk) {
      throw new Error("IDENTITY_BACKUP_PAYLOAD_INVALID");
    }
    const privateKey = await cryptoApi.subtle.importKey(
      "jwk", payload.ecdhPrivateJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]
    );
    const signingPrivateKey = await cryptoApi.subtle.importKey(
      "jwk", payload.signingPrivateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
    );
    return {
      privateKey,
      publicKey: payload.identityPublicKey,
      signingPrivateKey,
      signingPublicKey: payload.identitySigningPublicKey,
      backupPayload: payload
    };
  } catch {
    const error = new Error("暗号鍵バックアップを復号できません。パスワードを確認してください。");
    error.code = "IDENTITY_BACKUP_PASSWORD_MISMATCH";
    throw error;
  }
}
