import {
  assertSecureDropFileAllowed,
  assertSecureDropFileNameAllowed,
  decryptSecureDropFile,
  encryptSecureDropFile
} from "./secure-drop-crypto.js";

const $ = (selector) => document.querySelector(selector);
const ui = {
  user: $("#service-user"), logout: $("#service-logout"), auth: $("#service-auth"),
  keyWarning: $("#service-key-warning"), content: $("#service-content"),
  recipient: $("#service-recipient"), file: $("#service-file"), chooseFile: $("#service-choose-file"),
  fileName: $("#service-file-name"), priority: $("#service-priority"), send: $("#service-send"),
  uploadStatus: $("#service-upload-status"), credits: $("#service-credits"),
  meter: $("#service-meter-fill"), storage: $("#service-storage"),
  refresh: $("#service-refresh"), files: $("#service-files"),
  pendingCard: $("#service-pending-card"), pending: $("#service-pending"),
  toast: $("#service-toast")
};
const KEY_DB = "securechat-local-keys";
const KEY_STORE = "identity";
const PENDING_DB = "securechat-securedrop-pending";
const PENDING_STORE = "uploads";
const MAX_FILE_BYTES = 25_000_000;
let currentUser = null;
let identity = null;
let contacts = [];
let credits = null;
let busy = false;
let refreshBusy = false;
let toastTimer = null;

function error(code, message) {
  const result = new Error(message);
  result.code = code;
  return result;
}
function notify(message, duration = 4500) {
  ui.toast.textContent = message;
  ui.toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove("visible"), duration);
}
function errorText(value) {
  const code = value?.code || "SECURE_DROP_ERROR";
  return (value?.message || "処理に失敗しました。") + "\nエラーコード: " + code;
}
function formatSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "容量不明";
  if (value < 1_000_000) return Math.max(1, Math.round(value / 1000)) + " KB";
  return (value / 1_000_000).toFixed(2) + " MB";
}
function formatDate(value) {
  const date = new Date(Number(value));
  return Number.isNaN(date.getTime()) ? "日時不明" :
    new Intl.DateTimeFormat("ja-JP", { month:"numeric", day:"numeric", hour:"2-digit", minute:"2-digit" }).format(date);
}
function fromBase64(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
function identityProofMessage(userId, publicKey) {
  return new TextEncoder().encode("SecureChat identity-key-proof:v1\n" + userId + "\n" + publicKey);
}
async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      method: options.method || "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept:"application/json", ...(options.headers || {}) },
      ...(options.body !== undefined ? { body: options.body } : {})
    });
  } catch {
    throw error("SECURE_DROP_NETWORK_ERROR", "SecureDropサーバーに接続できません。");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.deleted === false) {
    const messages = {
      UNAUTHENTICATED:"ログインし直してください。",
      SECURE_DROP_RECIPIENT_NOT_AUTHORIZED:"送信先は相互確認済みの連絡先ではありません。",
      SECURE_DROP_KEY_ENVELOPE_INVALID:"受信者向け暗号鍵の検証に失敗しました。",
      INSUFFICIENT_CREDITS:"今月のクレジットが不足しています。",
      SECURE_DROP_UPLOADS_PAUSED:"専用容量の90%に達したため通常送信を停止しています。優先送信を選択してください。",
      SECURE_DROP_CAPACITY_REACHED:"専用容量に空きがありません。",
      UPLOAD_PREEMPTED:"優先容量確保のため予約が取り消されました。端末内の保留データは保持されています。",
      UPLOAD_FINALIZATION_PENDING:"保存完了を確認できません。保留一覧から再送信してください。",
      UPLOAD_ID_REUSED:"この予約IDは以前使用されています。",
      STORED_FILE_TOO_LARGE:"暗号化後のファイルが上限を超えています。",
      STORED_SIZE_MISMATCH:"転送中にファイル容量が変わりました。",
      TRANSFER_EXPIRED_OR_NOT_FOUND:"ファイルは期限切れか、削除されています。",
      DOWNLOAD_LIMIT_REACHED:"ダウンロード上限に達しました。",
      STORED_FILE_INTEGRITY_MISMATCH:"保存ファイルの整合性を確認できませんでした。",
      DELETE_PENDING:"削除要求を受け付けました。削除完了をサーバー側で再確認しています。",
      UPLOAD_ID_CONFLICT:"この保留データは既存の予約と一致しません。再読み込みして確認してください。"
    };
    const code = typeof data.error === "string" ? data.error : "HTTP_" + response.status;
    throw error(code, messages[code] || data.message || "SecureDropの処理に失敗しました。");
  }
  return data;
}
function openDb(name, storeName) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.createObjectStore(storeName, { keyPath:storeName === PENDING_STORE ? "id" : "userId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("LOCAL_DATABASE_UNAVAILABLE"));
  });
}
async function readIdentity(userId) {
  const db = await openDb(KEY_DB, KEY_STORE);
  return new Promise((resolve, reject) => {
    const request = db.transaction(KEY_STORE, "readonly").objectStore(KEY_STORE).get(userId);
    request.onsuccess = () => { db.close(); resolve(request.result || null); };
    request.onerror = () => { db.close(); reject(request.error || new Error("IDENTITY_READ_FAILED")); };
  });
}
async function readPending() {
  const db = await openDb(PENDING_DB, PENDING_STORE);
  return new Promise((resolve, reject) => {
    const request = db.transaction(PENDING_STORE, "readonly").objectStore(PENDING_STORE).getAll();
    request.onsuccess = () => {
      db.close();
      resolve((request.result || []).filter(item => item.userId === currentUser.id)
        .sort((a, b) => Number(a.createdAt) - Number(b.createdAt)));
    };
    request.onerror = () => { db.close(); reject(request.error || new Error("PENDING_READ_FAILED")); };
  });
}
async function savePending(item) {
  const db = await openDb(PENDING_DB, PENDING_STORE);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PENDING_STORE, "readwrite");
    tx.objectStore(PENDING_STORE).put(item);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error || new Error("PENDING_SAVE_FAILED")); };
    tx.onabort = () => { db.close(); reject(tx.error || new Error("PENDING_SAVE_FAILED")); };
  });
}
async function deletePending(id) {
  const db = await openDb(PENDING_DB, PENDING_STORE);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PENDING_STORE, "readwrite");
    tx.objectStore(PENDING_STORE).delete(id);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error || new Error("PENDING_DELETE_FAILED")); };
  });
}
async function verifiedPeerRoot(userId) {
  const peer = await api("/api/keys/" + encodeURIComponent(userId));
  if (!peer.identityPublicKey || !peer.identitySigningPublicKey || !peer.identityKeySignature) {
    throw error("IDENTITY_KEY_LEGACY_FORMAT", "相手の署名付きアカウント鍵がありません。");
  }
  const verifyKey = await crypto.subtle.importKey(
    "raw", fromBase64(peer.identitySigningPublicKey),
    { name:"ECDSA", namedCurve:"P-256" }, false, ["verify"]
  );
  const valid = await crypto.subtle.verify(
    { name:"ECDSA", hash:"SHA-256" }, verifyKey,
    fromBase64(peer.identityKeySignature),
    identityProofMessage(userId, peer.identityPublicKey)
  );
  if (!valid) throw error("IDENTITY_KEY_SIGNATURE_INVALID", "相手のアカウント鍵署名が正しくありません。");
  if (identity?.verifiedPeerPins?.[userId] !== peer.identitySigningPublicKey) {
    throw error("IDENTITY_FINGERPRINT_NOT_VERIFIED", "SecureChat Labで相手の署名鍵指紋を別経路で照合してください。");
  }
  return peer;
}
async function loadContacts() {
  const result = await api("/api/contacts");
  contacts = Array.isArray(result.contacts) ? result.contacts.map(item => item.userId).filter(Boolean) : [];
  const previous = ui.recipient.value;
  ui.recipient.replaceChildren();
  const first = document.createElement("option");
  first.value = "";
  first.textContent = contacts.length ? "送信先を選択" : "確認済み連絡先がありません";
  ui.recipient.append(first);
  for (const userId of contacts) {
    const option = document.createElement("option");
    option.value = userId;
    option.textContent = "@" + userId;
    ui.recipient.append(option);
  }
  if (contacts.includes(previous)) ui.recipient.value = previous;
  updateSendButton();
}
function updateSendButton() {
  ui.send.disabled = busy || !identity?.signingPrivateKey || !ui.recipient.value ||
    !ui.file.files?.length || (!ui.priority.checked && !!credits?.uploadsPaused);
}
function renderCredits(account) {
  credits = account;
  ui.credits.textContent = Number(account.balance || 0) + " / " + Number(account.granted || 0);
  const used = Number(account.storageUsedBytes || 0);
  const capacity = Number(account.storageCapacityBytes || 2_500_000_000);
  const percent = capacity > 0 ? Math.min(100, used / capacity * 100) : 0;
  ui.meter.style.width = percent.toFixed(1) + "%";
  ui.storage.textContent = formatSize(used) + " / " + formatSize(capacity) +
    " 使用中（" + percent.toFixed(1) + "%）" +
    (account.uploadsPaused ? " · 通常送信は一時停止中" : " · 通常送信可能");
  updateSendButton();
}
function makeFileRow(title, detail) {
  const row = document.createElement("article");
  row.className = "service-file-row";
  const copy = document.createElement("div");
  copy.className = "service-file-copy";
  const strong = document.createElement("strong");
  strong.textContent = title;
  const span = document.createElement("span");
  span.textContent = detail;
  copy.append(strong, span);
  const actions = document.createElement("div");
  actions.className = "service-file-actions";
  row.append(copy, actions);
  return { row, actions };
}
async function acknowledgePreemptions(ids) {
  if (!ids.length) return;
  await api("/api/secure-drop/preemptions/ack", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({ transferIds:ids })
  });
}
async function sendPendingUpload(pending) {
  assertSecureDropFileNameAllowed(pending.fileName);
  const ciphertext = pending.ciphertext instanceof ArrayBuffer
    ? new Uint8Array(pending.ciphertext)
    : new Uint8Array(pending.ciphertext.buffer, pending.ciphertext.byteOffset, pending.ciphertext.byteLength);
  const request = () => api("/api/secure-drop/files", {
    method:"POST",
    headers:{
      "X-Secure-Drop-Upload-Id":pending.id,
      "X-Secure-Drop-Original-Size":String(pending.originalSizeBytes),
      "X-Secure-Drop-Stored-Size":String(pending.storedSizeBytes),
      "X-Secure-Drop-Payload":"encrypted-v1",
      "X-Secure-Drop-Recipient-Id":pending.peerUserId,
      "X-Secure-Drop-Key-Envelope":pending.encodedEnvelope,
      "X-Secure-Drop-Priority":pending.priority ? "1" : "0",
      "Content-Type":"application/octet-stream"
    },
    body:new Blob([ciphertext], { type:"application/octet-stream" })
  });
  let result;
  try {
    result = await request();
  } catch (failure) {
    if (failure.code !== "UPLOAD_ID_REUSED" && failure.code !== "UPLOAD_PREEMPTED") throw failure;
    const oldId = pending.id;
    pending.id = crypto.randomUUID();
    pending.preemptedReservationIds = [...(pending.preemptedReservationIds || []), oldId];
    pending.canChangePriority = true;
    await savePending(pending);
    await deletePending(oldId);
    if (failure.code === "UPLOAD_PREEMPTED") throw failure;
    result = await request();
  }
  await deletePending(pending.id);
  return result;
}
async function handlePreemptions(events, localPending) {
  const acknowledged = [];
  let restored = 0;
  let unavailable = 0;
  for (const event of events) {
    const match = localPending.find(item => item.id === event.transferId ||
      (item.preemptedReservationIds || []).includes(event.transferId));
    if (match) {
      if (match.id === event.transferId) {
        const oldId = match.id;
        match.id = crypto.randomUUID();
        match.preemptedReservationIds = [...(match.preemptedReservationIds || []), oldId];
      }
      match.canChangePriority = true;
      await savePending(match);
      if (match.preemptedReservationIds?.includes(event.transferId)) {
        await deletePending(event.transferId);
      }
      restored++;
    } else {
      unavailable++;
    }
    acknowledged.push(event.transferId);
  }
  await acknowledgePreemptions(acknowledged).catch(() => {});
  if (restored || unavailable) {
    notify("優先容量確保により通常アップロードの予約が " + events.length +
      " 件解除されました。" + (unavailable ?
      " 端末内に保留データがないファイルは選び直してください。" :
      " 暗号化データは端末内に残っています。保留一覧から再送信できます。"), 9000);
  }
}
function renderPending(items) {
  ui.pending.replaceChildren();
  ui.pendingCard.hidden = items.length === 0;
  for (const pending of items) {
    const { row, actions } = makeFileRow(
      pending.fileName || "保留中の暗号化ファイル",
      "@" + pending.peerUserId + " · " + formatSize(pending.storedSizeBytes) +
      " · " + (pending.priority ? "優先送信" : "通常送信") + " · " + formatDate(pending.createdAt)
    );
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "再送信";
    retry.disabled = busy;
    retry.addEventListener("click", () => retryPending(pending, retry));
    actions.append(retry);
    if (pending.canChangePriority) {
      const tier = document.createElement("button");
      tier.type = "button";
      tier.textContent = pending.priority ? "通常で再送信" : "優先で再送信";
      tier.addEventListener("click", () => retryPending(pending, tier, !pending.priority));
      actions.append(tier);
    }
    ui.pending.append(row);
  }
}
function renderFiles(files) {
  ui.files.replaceChildren();
  if (!files.length) {
    const empty = document.createElement("p");
    empty.className = "service-empty";
    empty.textContent = "ファイルはありません。";
    ui.files.append(empty);
    return;
  }
  for (const file of files) {
    const isReceived = file.direction === "received";
    const title = isReceived ? "受信ファイル · @" + file.senderUserId : "送信ファイル · @" + file.peerUserId;
    const paidDownload = isReceived && Number(file.downloadCreditsRequired || 0) > 0;
    const detail = formatSize(file.storedSizeBytes) + " · 残り無料 " + file.downloadsRemaining +
      " 回" + (paidDownload ? " · 次回以降 " + file.downloadCreditsRequired + " クレジット/回" : "") +
      " · " + formatDate(file.createdAt) + " · 期限 " + formatDate(file.expiresAt);
    const { row, actions } = makeFileRow(title, detail);
    if (isReceived) {
      const download = document.createElement("button");
      download.type = "button";
      download.textContent = "取得・復号";
      download.disabled = !identity?.privateKey || !file.keyEnvelope;
      download.addEventListener("click", () => downloadFile(file, download));
      actions.append(download);
    } else {
      const sent = document.createElement("span");
      sent.textContent = "送信済み";
      sent.style.color = "#91a4bd";
      sent.style.fontSize = "10px";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "削除";
      remove.addEventListener("click", () => deleteFile(file, remove));
      actions.append(sent, remove);
    }
    ui.files.append(row);
  }
}
async function refresh() {
  if (refreshBusy || !currentUser) return;
  refreshBusy = true;
  ui.refresh.disabled = true;
  try {
    const [account, listing, pending] = await Promise.all([
      api("/api/secure-drop/credits"),
      api("/api/secure-drop/files"),
      readPending()
    ]);
    renderCredits(account);
    const events = Array.isArray(listing.preemptedUploads) ? listing.preemptedUploads : [];
    if (events.length) await handlePreemptions(events, pending);
    const refreshedPending = events.length ? await readPending() : pending;
    renderFiles(Array.isArray(listing.files) ? listing.files : []);
    renderPending(refreshedPending);
  } catch (failure) {
    notify(errorText(failure), 8500);
  } finally {
    refreshBusy = false;
    ui.refresh.disabled = false;
  }
}
async function retryPending(pending, button, priorityOverride = null) {
  button.disabled = true;
  busy = true;
  updateSendButton();
  try {
    if (priorityOverride !== null && pending.canChangePriority && pending.priority !== priorityOverride) {
      const oldId = pending.id;
      pending.id = crypto.randomUUID();
      pending.preemptedReservationIds = [...(pending.preemptedReservationIds || []), oldId];
      pending.priority = priorityOverride;
      pending.canChangePriority = false;
      await savePending(pending);
      await deletePending(oldId);
    }
    await savePending(pending);
    const result = await sendPendingUpload(pending);
    notify("保留ファイルを送信しました。消費クレジット: " + result.creditsConsumed);
  } catch (failure) {
    if (failure.code === "UPLOAD_PREEMPTED" || failure.code === "SECURE_DROP_UPLOADS_PAUSED" ||
        failure.code === "SECURE_DROP_CAPACITY_REACHED" || failure.code === "INSUFFICIENT_CREDITS") {
      pending.canChangePriority = true;
      await savePending(pending).catch(() => {});
    }
    notify(errorText(failure), 8500);
  } finally {
    busy = false;
    await refresh();
    updateSendButton();
  }
}
async function uploadSelectedFile() {
  const file = ui.file.files?.[0];
  const peerUserId = ui.recipient.value;
  if (!file || !peerUserId || busy || !currentUser) return;
  if (file.size < 1 || file.size > MAX_FILE_BYTES) {
    notify("ファイルは1バイト以上25 MB以下にしてください。");
    return;
  }
  try {
    await assertSecureDropFileAllowed(file);
  } catch (failure) {
    notify(errorText(failure), 8500);
    return;
  }
  busy = true;
  let pending = null;
  updateSendButton();
  ui.uploadStatus.textContent = "送信先の署名付き公開鍵と、この端末の照合済み指紋を確認しています…";
  try {
    const peer = await verifiedPeerRoot(peerUserId);
    if (!identity?.signingPrivateKey || !identity.signingPublicKey) {
      throw error("SECURE_DROP_SENDER_SIGNING_KEY_REQUIRED", "この端末の署名秘密鍵がありません。SecureChat Labで再ログインしてください。");
    }
    const encrypted = await encryptSecureDropFile(
      file, peer.identityPublicKey, currentUser.userId,
      identity.signingPrivateKey, identity.signingPublicKey
    );
    const bytes = encrypted.ciphertext instanceof Uint8Array
      ? encrypted.ciphertext
      : new Uint8Array(encrypted.ciphertext);
    pending = {
      id:crypto.randomUUID(),
      userId:currentUser.id,
      peerUserId,
      fileName:file.name || "ファイル",
      originalSizeBytes:file.size,
      storedSizeBytes:encrypted.storedSizeBytes,
      ciphertext:bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      encodedEnvelope:encrypted.encodedEnvelope,
      priority:!!ui.priority.checked,
      createdAt:Date.now(),
      preemptedReservationIds:[],
      canChangePriority:false
    };
    await savePending(pending);
    try { await navigator.storage?.persist?.(); } catch {}
    ui.uploadStatus.textContent = "暗号化データを端末内に保管しました。D1へ送信しています…";
    const result = await sendPendingUpload(pending);
    notify("暗号化ファイルを送信しました。消費クレジット: " + result.creditsConsumed);
    ui.file.value = "";
    ui.fileName.textContent = "選択されていません（最大25 MB）";
    ui.uploadStatus.textContent = "送信が完了しました。";
  } catch (failure) {
    if (pending && (failure.code === "UPLOAD_PREEMPTED" || failure.code === "SECURE_DROP_UPLOADS_PAUSED" ||
        failure.code === "SECURE_DROP_CAPACITY_REACHED" || failure.code === "INSUFFICIENT_CREDITS")) {
      pending.canChangePriority = true;
      await savePending(pending).catch(() => {});
    }
    ui.uploadStatus.textContent = errorText(failure);
    notify(errorText(failure), 8500);
  } finally {
    busy = false;
    await refresh();
    updateSendButton();
  }
}
async function downloadFile(file, button) {
  if (!identity?.privateKey || !identity.publicKey) return;
  const paidCredits = Number(file.downloadCreditsRequired || 0);
  if (paidCredits > 0 && !confirm(
    "無料ダウンロード3回を使い切っています。\n今回の取得で " + paidCredits +
    " クレジットを消費します。続行しますか？"
  )) return;
  button.disabled = true;
  try {
    const response = await fetch(file.downloadPath, { method:"GET", credentials:"same-origin", cache:"no-store" });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw error(data.error || "SECURE_DROP_DOWNLOAD_FAILED", data.message || "ファイルを取得できませんでした。");
    }
    const ciphertext = await response.arrayBuffer();
    const sender = await verifiedPeerRoot(file.senderUserId);
    const restored = await decryptSecureDropFile(
      ciphertext, file.keyEnvelope, identity.privateKey, identity.publicKey,
      file.senderUserId, sender.identitySigningPublicKey
    );
    const blob = new Blob([restored.bytes], { type:restored.type || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = restored.name || ("secure-drop-" + file.id);
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    notify("ファイルを端末内で復号しました。");
    await refresh();
  } catch (failure) {
    notify(errorText(failure), 8500);
  } finally {
    button.disabled = false;
  }
}
async function deleteFile(file, button) {
  if (!confirm("このファイルを削除しますか？受信者もダウンロードできなくなります。")) return;
  button.disabled = true;
  try {
    await api("/api/secure-drop/files/" + encodeURIComponent(file.id), { method:"DELETE" });
    notify("削除完了を確認しました。");
    await refresh();
  } catch (failure) {
    notify(errorText(failure), 8500);
    button.disabled = false;
  }
}
async function signOut() {
  ui.logout.disabled = true;
  try {
    await api("/api/auth/logout", { method:"POST", body:"{}",
      headers:{ "Content-Type":"application/json" } });
    location.href = "index.html";
  } catch (failure) {
    notify(errorText(failure));
    ui.logout.disabled = false;
  }
}
async function start() {
  try {
    const response = await fetch("/api/auth/me", { credentials:"same-origin", cache:"no-store", headers:{ Accept:"application/json" } });
    if (!response.ok) throw error("AUTH_CHECK_FAILED", "ログイン状態を確認できません。");
    const session = await response.json();
    if (!session.authenticated || !session.user) {
      ui.auth.hidden = false;
      ui.user.textContent = "未ログイン";
      return;
    }
    currentUser = session.user;
    ui.user.textContent = "@" + currentUser.userId;
    ui.logout.hidden = false;
    ui.logout.addEventListener("click", signOut);
    identity = await readIdentity(currentUser.userId).catch(() => null);
    if (!identity?.privateKey || !identity?.publicKey || !identity?.signingPrivateKey || !identity?.signingPublicKey) {
      ui.keyWarning.hidden = false;
      return;
    }
    ui.content.hidden = false;
    document.querySelector("#service-view-tabs").hidden = false;
    await loadContacts();
    await refresh();
    ui.recipient.addEventListener("change", updateSendButton);
    ui.priority.addEventListener("change", updateSendButton);
    ui.file.addEventListener("change", () => {
      ui.fileName.textContent = ui.file.files?.[0]
        ? ui.file.files[0].name + " · " + formatSize(ui.file.files[0].size)
        : "選択されていません（最大25 MB）";
      updateSendButton();
    });
    ui.send.addEventListener("click", uploadSelectedFile);
    ui.chooseFile.addEventListener("click", () => ui.file.click());
    ui.refresh.addEventListener("click", refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refresh();
    });
    setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 30_000);
  } catch (failure) {
    ui.auth.hidden = false;
    const heading = ui.auth.querySelector("h2");
    const detail = ui.auth.querySelector("p");
    if (heading) heading.textContent = "SecureDropを初期化できません";
    if (detail) detail.textContent = errorText(failure);
  }
}

const serviceTabs=document.querySelectorAll("[data-service-target]");
function activateServiceView(target){
  document.querySelectorAll("[data-service-view]").forEach(section=>{
    const active=section.id===target;
    section.hidden=!active;
    section.classList.toggle("active-service-view",active);
  });
  serviceTabs.forEach(button=>{
    const active=button.dataset.serviceTarget===target;
    button.classList.toggle("active",active);
    button.setAttribute("aria-selected",String(active));
  });
}
serviceTabs.forEach(button=>button.addEventListener("click",()=>activateServiceView(button.dataset.serviceTarget)));
const pendingTab=document.querySelector('[data-service-target="service-pending-card"]');
const pendingCard=document.querySelector("#service-pending-card");
if(pendingTab&&pendingCard){const syncPendingTab=()=>{pendingTab.hidden=pendingCard.hidden;if(pendingCard.hidden&&pendingTab.classList.contains("active"))activateServiceView("service-files-card");};new MutationObserver(syncPendingTab).observe(pendingCard,{attributes:true,attributeFilter:["hidden"]});syncPendingTab();}
activateServiceView("service-upload-card");

start();
