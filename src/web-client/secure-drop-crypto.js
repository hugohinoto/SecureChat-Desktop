const FILE_KEY_LENGTH = 32;
const MAX_UPLOAD_FILE_BYTES = 25_000_000;
const MAX_STORED_BYTES = 26_000_000;
const ENVELOPE_ALGORITHM = "ECDH-P256-HKDF-SHA256-AES-GCM-256";
const encoder = new TextEncoder();
const ARCHIVE_EXTENSION = /\.(?:zip|zipx|7z|rar|tar|tgz|tbz2|gz|gzip|bz2|bzip2|xz|zst|zstd|lz4|cab)$/i;
const ARCHIVE_MIME = /^application\/(?:zip|x-zip-compressed|x-7z-compressed|x-rar-compressed|vnd\.rar|gzip|x-gzip|x-bzip2|x-xz|zstd|x-zstd|x-tar)$/i;

function archiveNotSupported() {
  const error = new Error("ZIP・7z・RAR・gzip・tarなどの圧縮／アーカイブ形式は送信できません。");
  error.code = "SECURE_DROP_ARCHIVE_NOT_SUPPORTED";
  return error;
}

export function assertSecureDropFileNameAllowed(name) {
  if (typeof name === "string" && ARCHIVE_EXTENSION.test(name.trim())) {
    throw archiveNotSupported();
  }
}

function containsSignature(bytes, signature) {
  outer: for (let offset = 0; offset <= bytes.length - signature.length; offset += 1) {
    for (let i = 0; i < signature.length; i += 1) {
      if (bytes[offset + i] !== signature[i]) continue outer;
    }
    return true;
  }
  return false;
}

export async function assertSecureDropFileAllowed(file) {
  if (!(file instanceof Blob)) throw new TypeError("SECURE_DROP_FILE_REQUIRED");
  assertSecureDropFileNameAllowed(file.name);
  // .mcworld is a ZIP-based Minecraft world package; allow this extension only.
  const isMcworld = typeof file.name === "string" && /\.mcworld$/i.test(file.name.trim());
  if (!isMcworld && typeof file.type === "string" &&
      ARCHIVE_MIME.test(file.type.split(";")[0].trim())) {
    throw archiveNotSupported();
  }

  // ZIP EOCD/ZIP64 records live at the end; scanning both ends also catches
  // common self-extracting ZIPs whose executable stub precedes the ZIP data.
  const head = new Uint8Array(await file.slice(0, Math.min(file.size, 1_048_576)).arrayBuffer());
  const tailStart = Math.max(0, file.size - 65_557);
  const tail = tailStart ? new Uint8Array(await file.slice(tailStart).arrayBuffer()) : head;
  const zipSignatures = [
    [0x50, 0x4b, 0x03, 0x04], // local file header
    [0x50, 0x4b, 0x05, 0x06], // end of central directory / empty ZIP
    [0x50, 0x4b, 0x07, 0x08], // spanning marker
    [0x50, 0x4b, 0x06, 0x06], // ZIP64 end of central directory
    [0x50, 0x4b, 0x06, 0x07]  // ZIP64 locator
  ];
  const zipFound = zipSignatures.some(signature =>
    containsSignature(head, signature) || containsSignature(tail, signature)
  );
  const startsWith = signature => signature.every((byte, index) => head[index] === byte);
  const gzip = startsWith([0x1f, 0x8b]);
  const bzip2 = startsWith([0x42, 0x5a, 0x68]);
  const xz = startsWith([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);
  const zstd = startsWith([0x28, 0xb5, 0x2f, 0xfd]);
  const lz4 = startsWith([0x04, 0x22, 0x4d, 0x18]);
  const sevenZip = startsWith([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
  const rar = startsWith([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]);
  const cab = startsWith([0x4d, 0x53, 0x43, 0x46]);
  const tar = head.length >= 262 &&
    new TextDecoder().decode(head.slice(257, 262)) === "ustar";
  if (!isMcworld && (zipFound || gzip || bzip2 || xz || zstd || lz4 ||
      sevenZip || rar || cab || tar)) {
    throw archiveNotSupported();
  }
}

function toBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function fromBase64(value) {
  if (typeof value !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("SECURE_DROP_KEY_ENCODING_INVALID");
  }
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
function toHex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function publicKeyFingerprint(publicKeyBase64) {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(publicKeyBase64)));
}
function envelopeAad(fingerprint) {
  return encoder.encode("SecureChat SecureDrop key envelope v1\n" + fingerprint);
}
function fileAad(fingerprint) {
  return encoder.encode("SecureChat SecureDrop file payload v1\n" + fingerprint);
}
async function readStreamBounded(stream, maxBytes) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new RangeError("SECURE_DROP_DECOMPRESSED_SIZE_INVALID");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
function senderSignatureMessage(envelope) {
  const signedFields = {
    version: envelope.version,
    algorithm: envelope.algorithm,
    recipientKeyFingerprint: envelope.recipientKeyFingerprint,
    ephemeralPublicKey: envelope.ephemeralPublicKey,
    salt: envelope.salt,
    iv: envelope.iv,
    wrappedFileKey: envelope.wrappedFileKey,
    fileIv: envelope.fileIv,
    senderUserId: envelope.senderUserId,
    senderSigningPublicKey: envelope.senderSigningPublicKey,
    ciphertextSha256: envelope.ciphertextSha256
  };
  return encoder.encode(
    "SecureChat SecureDrop sender signature v1\n" +
    envelope.senderUserId + "\n" + JSON.stringify(signedFields)
  );
}
async function deriveWrappingKey(privateKey, publicKey, salt, fingerprint) {
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: publicKey }, privateKey, 256
  ));
  try {
    const hkdfKey = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveKey"]);
    return await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt,
        info: envelopeAad(fingerprint)
      },
      hkdfKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  } finally {
    sharedSecret.fill(0);
  }
}
async function wrapFileKey(fileKeyBytes, recipientPublicKeyBase64, fileIv) {
  const fingerprint = await publicKeyFingerprint(recipientPublicKeyBase64);
  const recipientPublicKey = await crypto.subtle.importKey(
    "raw", fromBase64(recipientPublicKeyBase64),
    { name: "ECDH", namedCurve: "P-256" }, false, []
  );
  const ephemeral = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const wrapIv = crypto.getRandomValues(new Uint8Array(12));
  const wrappingKey = await deriveWrappingKey(ephemeral.privateKey, recipientPublicKey, salt, fingerprint);
  const wrappedFileKey = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: wrapIv, additionalData: envelopeAad(fingerprint) },
    wrappingKey,
    fileKeyBytes
  );
  return {
    version: 1,
    algorithm: ENVELOPE_ALGORITHM,
    recipientKeyFingerprint: fingerprint,
    ephemeralPublicKey: toBase64(new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey))),
    salt: toBase64(salt),
    iv: toBase64(wrapIv),
    wrappedFileKey: toBase64(new Uint8Array(wrappedFileKey)),
    fileIv: toBase64(fileIv)
  };
}
async function unwrapFileKey(envelope, recipientPrivateKey, recipientPublicKeyBase64) {
  const fingerprint = await publicKeyFingerprint(recipientPublicKeyBase64);
  if (!envelope || envelope.version !== 1 ||
      envelope.algorithm !== ENVELOPE_ALGORITHM ||
      envelope.recipientKeyFingerprint !== fingerprint) {
    throw new Error("SECURE_DROP_RECIPIENT_KEY_MISMATCH");
  }
  const ephemeralPublicKey = await crypto.subtle.importKey(
    "raw", fromBase64(envelope.ephemeralPublicKey),
    { name: "ECDH", namedCurve: "P-256" }, false, []
  );
  const salt = fromBase64(envelope.salt);
  const wrapIv = fromBase64(envelope.iv);
  const wrappingKey = await deriveWrappingKey(recipientPrivateKey, ephemeralPublicKey, salt, fingerprint);
  const raw = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: wrapIv, additionalData: envelopeAad(fingerprint) },
    wrappingKey,
    fromBase64(envelope.wrappedFileKey)
  );
  if (raw.byteLength !== FILE_KEY_LENGTH) throw new Error("SECURE_DROP_FILE_KEY_INVALID");
  return new Uint8Array(raw);
}

export function encodeSecureDropKeyEnvelope(envelope) {
  const bytes = encoder.encode(JSON.stringify(envelope));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function encryptSecureDropFile(file, recipientPublicKeyBase64, senderUserId, senderSigningPrivateKey, senderSigningPublicKeyBase64) {
  if (!(file instanceof Blob) || file.size < 1 || file.size > MAX_UPLOAD_FILE_BYTES) {
    throw new RangeError("SECURE_DROP_FILE_SIZE_INVALID");
  }
  await assertSecureDropFileAllowed(file);
  if (typeof recipientPublicKeyBase64 !== "string") {
    throw new TypeError("SECURE_DROP_RECIPIENT_KEY_REQUIRED");
  }
  if (typeof senderUserId !== "string" || !/^[a-z0-9_]{3,32}$/.test(senderUserId) ||
      !senderSigningPrivateKey || typeof senderSigningPublicKeyBase64 !== "string") {
    throw new TypeError("SECURE_DROP_SENDER_SIGNING_KEY_REQUIRED");
  }
  if (typeof CompressionStream !== "function") {
    throw new Error("SECURE_DROP_COMPRESSION_UNAVAILABLE");
  }
  const metadata = {
    version: 1,
    name: typeof file.name === "string" ? file.name.slice(0, 255) : "secure-drop-file",
    type: typeof file.type === "string" ? file.type.slice(0, 128) : "application/octet-stream",
    lastModified: Number.isSafeInteger(file.lastModified) ? file.lastModified : 0
  };
  const metadataBytes = encoder.encode(JSON.stringify(metadata));
  const metadataLength = new Uint8Array(4);
  new DataView(metadataLength.buffer).setUint32(0, metadataBytes.length, false);
  const plaintext = await readStreamBounded(
    new Blob([metadataLength, metadataBytes, file]).stream().pipeThrough(new CompressionStream("gzip")),
    MAX_STORED_BYTES
  );
  const fileKeyBytes = crypto.getRandomValues(new Uint8Array(FILE_KEY_LENGTH));
  const fileIv = crypto.getRandomValues(new Uint8Array(12));
  try {
    const fingerprint = await publicKeyFingerprint(recipientPublicKeyBase64);
    const fileKey = await crypto.subtle.importKey(
      "raw", fileKeyBytes, { name: "AES-GCM" }, false, ["encrypt"]
    );
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: fileIv, additionalData: fileAad(fingerprint) },
      fileKey,
      plaintext
    );
    if (ciphertext.byteLength > MAX_STORED_BYTES) throw new RangeError("SECURE_DROP_ENCRYPTED_FILE_TOO_LARGE");
    const envelope = await wrapFileKey(fileKeyBytes, recipientPublicKeyBase64, fileIv);
    envelope.senderUserId = senderUserId;
    envelope.senderSigningPublicKey = senderSigningPublicKeyBase64;
    envelope.ciphertextSha256 = toHex(await crypto.subtle.digest("SHA-256", ciphertext));
    envelope.senderSignature = toBase64(new Uint8Array(await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      senderSigningPrivateKey,
      senderSignatureMessage(envelope)
    )));
    return {
      ciphertext: new Uint8Array(ciphertext),
      envelope,
      encodedEnvelope: encodeSecureDropKeyEnvelope(envelope),
      originalSizeBytes: file.size,
      storedSizeBytes: ciphertext.byteLength,
      compression: "gzip"
    };
  } finally {
    fileKeyBytes.fill(0);
  }
}

export async function decryptSecureDropFile(ciphertext, envelope, recipientPrivateKey, recipientPublicKeyBase64, expectedSenderUserId, expectedSenderSigningPublicKey) {
  const bytes = ciphertext instanceof ArrayBuffer
    ? ciphertext
    : ArrayBuffer.isView(ciphertext)
      ? ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength)
      : null;
  if (!bytes || bytes.byteLength < 17 || bytes.byteLength > MAX_STORED_BYTES) {
    throw new RangeError("SECURE_DROP_CIPHERTEXT_SIZE_INVALID");
  }
  if (!envelope || envelope.senderUserId !== expectedSenderUserId ||
      envelope.senderSigningPublicKey !== expectedSenderSigningPublicKey ||
      typeof expectedSenderUserId !== "string" || !/^[a-z0-9_]{3,32}$/.test(expectedSenderUserId)) {
    throw new Error("SECURE_DROP_SENDER_IDENTITY_MISMATCH");
  }
  const ciphertextHash = toHex(await crypto.subtle.digest("SHA-256", bytes));
  if (ciphertextHash !== envelope.ciphertextSha256) throw new Error("SECURE_DROP_CIPHERTEXT_HASH_MISMATCH");
  const signingKeyBytes = fromBase64(expectedSenderSigningPublicKey);
  if (signingKeyBytes.length !== 65 || signingKeyBytes[0] !== 4) {
    throw new Error("SECURE_DROP_SENDER_KEY_INVALID");
  }
  const signingKey = await crypto.subtle.importKey(
    "raw", signingKeyBytes, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]
  );
  const signatureValid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    signingKey,
    fromBase64(envelope.senderSignature),
    senderSignatureMessage(envelope)
  );
  if (!signatureValid) throw new Error("SECURE_DROP_SENDER_SIGNATURE_INVALID");
  const fileKeyBytes = await unwrapFileKey(envelope, recipientPrivateKey, recipientPublicKeyBase64);
  try {
    const fileKey = await crypto.subtle.importKey(
      "raw", fileKeyBytes, { name: "AES-GCM" }, false, ["decrypt"]
    );
    const fingerprint = await publicKeyFingerprint(recipientPublicKeyBase64);
    const fileIv = fromBase64(envelope.fileIv);
    if (fileIv.byteLength !== 12) throw new Error("SECURE_DROP_FILE_IV_INVALID");
    const compressed = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fileIv, additionalData: fileAad(fingerprint) },
      fileKey,
      bytes
    );
    if (typeof DecompressionStream !== "function") {
      throw new Error("SECURE_DROP_DECOMPRESSION_UNAVAILABLE");
    }
    const packed = await readStreamBounded(
      new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip")),
      MAX_UPLOAD_FILE_BYTES + 2048
    );
    if (packed.byteLength < 5) throw new Error("SECURE_DROP_METADATA_INVALID");
    const metadataLength = new DataView(packed.buffer, packed.byteOffset, packed.byteLength).getUint32(0, false);
    if (metadataLength < 2 || metadataLength > 2048 || 4 + metadataLength > packed.byteLength) {
      throw new Error("SECURE_DROP_METADATA_INVALID");
    }
    let metadata;
    try {
      metadata = JSON.parse(new TextDecoder().decode(packed.slice(4, 4 + metadataLength)));
    } catch {
      throw new Error("SECURE_DROP_METADATA_INVALID");
    }
    if (!metadata || metadata.version !== 1 ||
        typeof metadata.name !== "string" || metadata.name.length > 255 ||
        typeof metadata.type !== "string" || metadata.type.length > 128) {
      throw new Error("SECURE_DROP_METADATA_INVALID");
    }
    const name = metadata.name.replaceAll("\\", "_").replaceAll("/", "_").replace(/[\u0000-\u001f\u007f]/g, "_") || "secure-drop-file";
    const restoredBytes = new Uint8Array(packed.slice(4 + metadataLength));
    if (restoredBytes.byteLength < 1 || restoredBytes.byteLength > MAX_UPLOAD_FILE_BYTES) {
      throw new RangeError("SECURE_DROP_DECOMPRESSED_SIZE_INVALID");
    }
    return {
      bytes: restoredBytes,
      name,
      type: metadata.type,
      lastModified: Number.isSafeInteger(metadata.lastModified) ? metadata.lastModified : 0
    };
  } finally {
    fileKeyBytes.fill(0);
  }
}

export const SECURE_DROP_CRYPTO = Object.freeze({
  algorithm: ENVELOPE_ALGORITHM,
  maxFileBytes: MAX_UPLOAD_FILE_BYTES,
  maxUploadFileBytes: MAX_UPLOAD_FILE_BYTES,
  maxStoredBytes: MAX_STORED_BYTES,
  fileKeyBytes: FILE_KEY_LENGTH
});
