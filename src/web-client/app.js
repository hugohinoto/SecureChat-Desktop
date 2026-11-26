import { decryptIdentityBackup, encryptIdentityBackup } from "./identity-backup.js";
import { fingerprintsMatch } from "./identity-fingerprint.js";
const $ = (s) => document.querySelector(s);
const el = {
  connection: $("#connection-pill"), connectionLabel: $("#connection-label"),
  list: $("#message-list"), input: $("#message-input"), send: $("#send-button"),
  count: $("#character-count"), profile: $("#profile-name"), avatar: $("#profile-avatar"),
  logout: $("#logout-button"), authLoading: $("#auth-loading"), deleteAccount: $("#delete-account-button"), toast: $("#toast"), gate: $("#auth-gate"),
  form: $("#auth-form"), title: $("#auth-title"), description: $("#auth-description"),
  error: $("#auth-error"), submit: $("#auth-submit"), user: $("#auth-user-id"),
  password: $("#auth-password"), passwordHint: $("#password-hint"),
  inviteCode: $("#auth-invite-code"), inviteCodeField: $("#invite-code-field"),
  registrationInvite: $("#registration-invite-result"), registrationInviteButton: $("#registration-invite-button"),
  loginTab: $("#login-tab"), registerTab: $("#register-tab"),
  search: $("#user-search-input"), searchButton: $("#user-search-button"),
  results: $("#user-search-results"), contacts: $("#contact-list"), invitations: $("#invitation-list"),
  conversations: $("#conversation-list"), adminLink: $("#admin-link"), announcements: $("#public-announcements"), announcementsList: $("#public-announcements-list"), contactCount: $("#contact-count"),
  conversationCount: $("#conversation-count"), passwordChangeGate: $("#password-change-gate"), passwordChangeForm: $("#password-change-form"), currentAdminPassword: $("#current-admin-password"), newAdminPassword: $("#new-admin-password"), confirmAdminPassword: $("#confirm-admin-password"), passwordChangeError: $("#password-change-error"), passwordChangeSubmit: $("#password-change-submit"), chatTitle: $("#chat-title"),
  chatSubtitle: $("#chat-subtitle"), securityTitle: $("#security-title"),
  securityDescription: $("#security-description"), securityTag: $("#security-tag"),
  composerHint: $("#composer-hint"), fingerprint: $("#key-fingerprint"),
  mobileBack: $("#mobile-back-button"),
  unreadTotal: $("#unread-total"), notificationButton: $("#notification-enable-button"),
  cryptoV2Approve: $("#crypto-v2-approve-button"), cryptoV2Status: $("#crypto-v2-status"),
  cryptoV2DevicesToggle: $("#crypto-v2-devices-toggle"), cryptoV2Devices: $("#crypto-v2-devices"), cryptoV2DeviceList: $("#crypto-v2-device-list"),
};
const MAX_MESSAGE_LENGTH = 2000;
const DB_NAME = "securechat-local-keys";
const STORE = "identity";
let currentUser = null, authMode = "login", toastTimer = null, authTimer = null, cryptoV2Required = true;
let identityPrivateKey = null, identityPublicKey = null, identitySigningPublicKey = null;
let activeConversation = null, activeKey = null, activeProtocolVersion = 1, cryptoV2Module = null, cryptoV2Ready = false, cryptoV2StatusMessage = "", busy = false, refreshTimer = null, mobileView = "list";
const openingConversationPeers = new Set();
let messageLoadBusy = false, lastMessageCreatedAt = 0, lastMessageId = "", sidebarRefreshTick = 0;
const displayedOtpCodes = new Map();
const previousUnreadCounts = new Map();
const originalDocumentTitle = document.title;
let unreadCountsInitialized = false;
let cryptoModeRefreshTick = 0;
let activeCryptoMode = { protocolVersion: 1, approvedByMe: false, approvedByPeer: false };
const autoV2ApprovalInFlight = new Set();
let activePeerSigningKey = null, activePeerFingerprintVerified = false;

function toast(message, duration = 3200) {
  el.toast.textContent = message;
  el.toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove("visible"), duration);
}
function appError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
function formatError(error, prefix = "") {
  const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
    ? error.code : "CLIENT_ERROR";
  const message = typeof error?.message === "string" && error.message
    ? error.message : "予期しないエラーが発生しました。";
  return prefix + message + "\nエラーコード: " + code;
}
function showError(error, prefix = "") {
  toast(formatError(error, prefix), 8000);
}
function setError(target, error, prefix = "") {
  target.textContent = formatError(error, prefix);
}
function state(value, label) {
  el.connection.dataset.state = value;
  el.connectionLabel.textContent = label;
  updateSend();
}
async function closeCryptoV2Session() {
  try {
    if(cryptoV2Module?.closeCryptoV2 && currentUser) {
      await cryptoV2Module.closeCryptoV2(currentUser.userId);
    }
  } catch(error) {
    console.error("SecureChat crypto v2 close failed:",error?.code||"CRYPTO_CLOSE_ERROR");
  } finally {
    cryptoV2Module=null;
    cryptoV2Ready=false;
    activeProtocolVersion=1;
    activeCryptoMode={protocolVersion:1,approvedByMe:false,approvedByPeer:false};
    activePeerSigningKey=null;
    activePeerFingerprintVerified=false;
  }
}
function updateNotificationButton() {
  if(!el.notificationButton)return;
  if(!("Notification" in window)) {
    el.notificationButton.hidden=true;
    return;
  }
  el.notificationButton.hidden=false;
  if(Notification.permission==="granted") {
    el.notificationButton.textContent="ブラウザー通知は有効です";
    el.notificationButton.disabled=true;
  } else if(Notification.permission==="denied") {
    el.notificationButton.textContent="通知はブラウザー設定で許可してください";
    el.notificationButton.disabled=true;
  } else {
    el.notificationButton.textContent="ブラウザー通知を有効にする";
    el.notificationButton.disabled=false;
  }
}
async function enableBrowserNotifications() {
  if(!("Notification" in window)) {
    toast("このブラウザーは通知に対応していません。");
    return;
  }
  if(Notification.permission==="granted") {
    updateNotificationButton();toast("ブラウザー通知は既に有効です。");return;
  }
  try {
    const permission=await Notification.requestPermission();
    updateNotificationButton();
    toast(permission==="granted"?"新着メッセージのブラウザー通知を有効にしました。":
      "通知は許可されませんでした。ブラウザーのサイト設定から変更できます。",5000);
  } catch {
    toast("通知の許可を確認できませんでした。ブラウザーの設定を確認してください。",5000);
  }
}
function notifyUnreadConversation(conversation) {
  const peer=conversation.peer_user_id;
  toast("@"+peer+" から新着メッセージがあります。",4500);
  if(!("Notification" in window) || Notification.permission!=="granted")return;
  try {
    const notification=new Notification("SecureChat — 新着メッセージ",{
      body:"@"+peer+" から新着メッセージがあります。",
      tag:"securechat-conversation-"+conversation.id
    });
    notification.onclick=()=>{
      window.focus();
      notification.close();
      selectConversation({id:conversation.id,peer_user_id:peer});
    };
  } catch { /* Browser notification display can be blocked by platform settings. */ }
}
function setMobileView(view) {
  mobileView = view;
  const isMobile = window.matchMedia("(max-width: 680px)").matches;
  document.body.classList.toggle("mobile-chat", isMobile && view === "chat");
  document.body.classList.toggle("mobile-list", isMobile && view !== "chat");
}
function updateSend() {
  el.count.textContent = Array.from(el.input.value).length + " / " + MAX_MESSAGE_LENGTH;
  el.input.disabled = !currentUser || !activeConversation || busy || (activeProtocolVersion===2 && !cryptoV2Ready);
  el.send.disabled = !currentUser || !activeConversation || busy ||
    (activeProtocolVersion===2 && !cryptoV2Ready) ||
    (cryptoV2Required && activeProtocolVersion!==2) || !el.input.value.trim();
}
function time(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("ja-JP", {hour:"2-digit",minute:"2-digit"}).format(date);
}
function openKeyDb() {
  return new Promise((resolve,reject) => {
    const req = indexedDB.open(DB_NAME,1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE,{keyPath:"userId"}); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function storedIdentity(userId) {
  const db=await openKeyDb();
  return new Promise((resolve,reject)=>{
    const req=db.transaction(STORE,"readonly").objectStore(STORE).get(userId);
    req.onsuccess=()=>{db.close();resolve(req.result||null);};
    req.onerror=()=>{db.close();reject(req.error);};
  });
}
async function saveIdentity(userId,record) {
  const db=await openKeyDb();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,"readwrite");
    tx.objectStore(STORE).put(Object.assign({userId},record));
    tx.oncomplete=()=>{db.close();resolve();};
    tx.onerror=()=>{db.close();reject(tx.error);};
  });
}
async function removeIdentity(userId) {
  const db=await openKeyDb();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,"readwrite");
    tx.objectStore(STORE).delete(userId);
    tx.oncomplete=()=>{db.close();resolve();};
    tx.onerror=()=>{db.close();reject(tx.error);};
  });
}
function toB64(bytes) {
  let s=""; for(const b of bytes)s+=String.fromCharCode(b); return btoa(s);
}
function fromB64(s) { return Uint8Array.from(atob(s),c=>c.charCodeAt(0)); }
function fromB64Url(s) {
  const normalized=s.replace(/-/g,"+").replace(/_/g,"/");
  const padded=normalized+"=".repeat((4-normalized.length%4)%4);
  return Uint8Array.from(atob(padded),c=>c.charCodeAt(0));
}
async function publicKeyFingerprint(base64Key) {
  const digest=await crypto.subtle.digest("SHA-256",fromB64(base64Key));
  const hex=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("").toUpperCase();
  return hex.match(/.{1,4}/g).join(" ");
}

async function api(path, options={}) {
  let response;
  try {
    response=await fetch(path,{
      method:options.method||"GET",credentials:"same-origin",cache:"no-store",
      headers:Object.assign({Accept:"application/json"},options.body?{"Content-Type":"application/json"}:{}),
      ...(options.body?{body:JSON.stringify(options.body)}:{})
    });
  } catch {
    throw appError("NETWORK_ERROR","サーバーに接続できません。通信状態を確認してください。");
  }
  const data=response.status===204?{}:await response.json().catch(()=>({}));
  if(!response.ok) {
    const known={
      USER_NOT_FOUND:"そのユーザーIDは見つかりません。",
      RECIPIENT_KEY_MISSING:"相手がまだ公開鍵を登録していません。相手に一度ログインしてもらってください。",
      MUTUAL_OTP_REQUIRED:"双方のワンタイムコード確認が完了していません。",
      CONTACT_PERMISSION_REQUIRED:"OTPによる連絡先確認が解除されたため、このチャットは利用できません。",
      CONTACT_NOT_FOUND:"このユーザーは連絡先にありません。",
      OTP_INVALID:"コードが正しくありません。",
      OTP_NOT_CONFIGURED:"サーバー側のOTP秘密鍵が未設定です。Cloudflare WorkerのSecretにCONTACT_OTP_PEPPERを登録してください。",
      INVITATION_ALREADY_ACCEPTED:"相手は既に最初のコードを確認しています。",
      OTP_EXPIRED:"コードの有効期限が切れました。相手に新しいコードを発行してもらってください。",
      OTP_ATTEMPTS_EXCEEDED:"入力回数の上限に達しました。新しい招待からやり直してください。",
      INVALID_OTP_FORMAT:"8桁の数字を入力してください。",
      INVITATION_EXISTS:"この相手との招待は既に進行中です。下の招待欄を確認してください。",
      ALREADY_CONTACT:"このユーザーは既に確認済みの連絡先です。",
      INVITATION_NOT_ACCEPTED:"先に相手からの招待コードを確認してください。",
      INVITATION_ALREADY_ACCEPTED:"相手は既に最初のコードを確認しています。",
      INVITATION_NOT_FOUND:"招待が見つからないか、有効期限が切れています。",
      OTP_NOT_CONFIGURED:"サーバー側のOTP秘密鍵が未設定です。管理者の設定が必要です。",
      INVITE_CODE_REQUIRED:"新規登録には招待コードが必要です。",
      INVITE_CODE_INVALID:"招待コードが無効・使用済み・期限切れです。",
      INVITE_LIMIT_REACHED:"有効な招待コードは最大5件までです。",
      CONVERSATION_NOT_FOUND:"チャットが見つかりません。",
      IDENTITY_KEY_CONFLICT:"このアカウントの暗号鍵が別端末で変更されています。元の端末で同期の初期設定を完了してください。",
      IDENTITY_BACKUP_REQUIRED:"このブラウザーのアプリが古い可能性があります。Ctrl+Shift+R（MacはCommand+Shift+R）でページを強制再読み込みしてください。サイトデータや保存済み暗号鍵は削除しないでください。",
      IDENTITY_BACKUP_INVALID:"暗号化バックアップの形式を確認できません。ページを強制再読み込みして再度ログインしてください。サイトデータは削除しないでください。",
      IDENTITY_BACKUP_PASSWORD_REQUIRED:"暗号鍵を同期するため、パスワードを入力して再ログインしてください。",
      IDENTITY_BACKUP_PASSWORD_MISMATCH:"暗号鍵バックアップを復号できません。パスワードを確認してください。",
      IDENTITY_BACKUP_SETUP_REQUIRED:"このアカウントの暗号鍵は別端末にあります。先に元の端末で再ログインして同期バックアップを作成してください。"
    };
    const code=typeof data.error==="string"&&/^[A-Z][A-Z0-9_]{1,63}$/.test(data.error)
      ? data.error : "HTTP_"+response.status;
    throw appError(code,known[data.error]||data.message||("通信エラー ("+response.status+")"));
  }
  return data;
}
function identityProofMessage(userId,identityPublicKey) {
  return new TextEncoder().encode("SecureChat identity-key-proof:v1\n"+userId+"\n"+identityPublicKey);
}
async function createPortableIdentity(password,peerPins={}) {
  const ecdh=await crypto.subtle.generateKey({name:"ECDH",namedCurve:"P-256"},true,["deriveBits"]);
  const signing=await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign","verify"]);
  const ecdhPrivateJwk=await crypto.subtle.exportKey("jwk",ecdh.privateKey);
  const signingPrivateJwk=await crypto.subtle.exportKey("jwk",signing.privateKey);
  const publicKey=toB64(new Uint8Array(await crypto.subtle.exportKey("raw",ecdh.publicKey)));
  const signingPublicKey=toB64(new Uint8Array(await crypto.subtle.exportKey("raw",signing.publicKey)));
  const privateKey=await crypto.subtle.importKey("jwk",ecdhPrivateJwk,{name:"ECDH",namedCurve:"P-256"},false,["deriveBits"]);
  const signingPrivateKey=await crypto.subtle.importKey("jwk",signingPrivateJwk,{name:"ECDSA",namedCurve:"P-256"},false,["sign"]);
  const signature=await crypto.subtle.sign(
    {name:"ECDSA",hash:"SHA-256"},signingPrivateKey,
    identityProofMessage(currentUser.userId,publicKey)
  );
  const identityBackup=await encryptIdentityBackup({
    version:1,identityPublicKey:publicKey,identitySigningPublicKey:signingPublicKey,
    ecdhPrivateJwk,signingPrivateJwk
  },password);
  return {
    record:{privateKey,publicKey,signingPrivateKey,signingPublicKey,peerPins},
    identityPublicKey:publicKey,identitySigningPublicKey:signingPublicKey,
    identityKeySignature:toB64(new Uint8Array(signature)),identityBackup
  };
}
function setIdentityRecord(record) {
  identityPrivateKey=record.privateKey;
  identityPublicKey=record.publicKey;
  identitySigningPublicKey=record.signingPublicKey;
}
function deviceAuthorizationMessage(userId,deviceId,curve25519Key,ed25519Key) {
  return new TextEncoder().encode(
    "SecureChat device authorization:v2\n"+
    "@"+userId+":securechat.invalid\n"+deviceId+"\n"+
    curve25519Key+"\n"+ed25519Key
  );
}
async function verifiedAccountRoot(userId) {
  if(userId===currentUser.userId)return {identitySigningPublicKey};
  const peer=await api("/api/keys/"+encodeURIComponent(userId));
  if(!peer.identitySigningPublicKey || !peer.identityKeySignature) {
    throw appError("IDENTITY_KEY_LEGACY_FORMAT","相手の署名付きアカウント鍵がありません。");
  }
  const verifyKey=await crypto.subtle.importKey("raw",fromB64(peer.identitySigningPublicKey),{name:"ECDSA",namedCurve:"P-256"},false,["verify"]);
  const proof=await crypto.subtle.verify(
    {name:"ECDSA",hash:"SHA-256"},verifyKey,fromB64(peer.identityKeySignature),
    identityProofMessage(userId,peer.identityPublicKey)
  );
  if(!proof)throw appError("IDENTITY_KEY_SIGNATURE_INVALID","相手のアカウント鍵署名が正しくありません。");
  const ownRecord=await storedIdentity(currentUser.userId);
  if(ownRecord?.verifiedPeerPins?.[userId]!==peer.identitySigningPublicKey) {
    throw appError("IDENTITY_FINGERPRINT_NOT_VERIFIED","相手のアカウント指紋を別の安全な経路で確認してください。");
  }
  return peer;
}
async function authorizeCryptoDevice(matrixId,deviceId,deviceKeys,accountSignature) {
  const match=typeof matrixId==="string" && matrixId.match(/^@([a-z0-9_]{3,32}):securechat\.invalid$/);
  if(!match || typeof deviceId!=="string" || !deviceKeys ||
     deviceKeys.user_id!==matrixId || deviceKeys.device_id!==deviceId) return false;
  const userId=match[1];
  let root;
  try { root=await verifiedAccountRoot(userId); }
  catch(error) {
    if(error.code==="IDENTITY_FINGERPRINT_NOT_VERIFIED")return false;
    throw error;
  }
  const curve=deviceKeys.keys?.["curve25519:"+deviceId];
  const ed=deviceKeys.keys?.["ed25519:"+deviceId];
  if(typeof curve!=="string" || typeof ed!=="string" ||
     !/^[A-Za-z0-9+/_-]{43}=?$/.test(curve) || !/^[A-Za-z0-9+/_-]{43}=?$/.test(ed) ||
     typeof accountSignature!=="string")return false;
  const key=await crypto.subtle.importKey("raw",fromB64(root.identitySigningPublicKey),{name:"ECDSA",namedCurve:"P-256"},false,["verify"]);
  return crypto.subtle.verify(
    {name:"ECDSA",hash:"SHA-256"},key,fromB64(accountSignature),
    deviceAuthorizationMessage(userId,deviceId,curve,ed)
  );
}
async function confirmPeerFingerprint(peerUserId,peer) {
  const fingerprint=await publicKeyFingerprint(peer.identitySigningPublicKey);
  const supplied=window.prompt(
    "@"+peerUserId+" の指紋を電話・対面など別の安全な経路で照合してください。\n\n"+
    "表示された64桁のSHA-256指紋と完全一致した場合だけ入力してください。\n\n"+fingerprint
  );
  if(supplied===null)return false;
  if(!fingerprintsMatch(supplied,fingerprint)) {
    showError(appError("IDENTITY_FINGERPRINT_MISMATCH","指紋が一致しません。端末を信頼済みにしていません。"));
    return false;
  }
  const latest=await api("/api/keys/"+encodeURIComponent(peerUserId));
  if(latest.identitySigningPublicKey!==peer.identitySigningPublicKey ||
     latest.identityPublicKey!==peer.identityPublicKey) {
    throw appError("IDENTITY_KEY_CHANGED_AGAIN","照合中に相手の鍵が変更されました。再読み込みして確認してください。");
  }
  const rootKey=await crypto.subtle.importKey("raw",fromB64(latest.identitySigningPublicKey),{name:"ECDSA",namedCurve:"P-256"},false,["verify"]);
  const valid=await crypto.subtle.verify({name:"ECDSA",hash:"SHA-256"},rootKey,
    fromB64(latest.identityKeySignature),identityProofMessage(peerUserId,latest.identityPublicKey));
  if(!valid)throw appError("IDENTITY_KEY_SIGNATURE_INVALID","相手の公開鍵署名を検証できません。");
  const ownRecord=await storedIdentity(currentUser.userId);
  const verifiedPeerPins={...(ownRecord?.verifiedPeerPins||{})};
  verifiedPeerPins[peerUserId]=latest.identitySigningPublicKey;
  await saveIdentity(currentUser.userId,{...ownRecord,verifiedPeerPins});
  return true;
}
async function initializeCryptoV2IfEnabled() {
  cryptoV2Ready=false;
  cryptoV2Module=null;
  activeProtocolVersion=1;
  try {
    const status=await api("/api/crypto/status");
    cryptoV2Required = status.forwardSecrecyRequired === true;
    if(!status.enabled) {
      cryptoV2StatusMessage="前方秘匿性v2はサーバー側で無効です。";
      updateCryptoV2Controls();
      return;
    }
    const ownRecord=await storedIdentity(currentUser.userId);
    if(!ownRecord?.signingPrivateKey || !identitySigningPublicKey) {
      throw appError("CRYPTO_IDENTITY_REQUIRED","アカウント署名鍵をこの端末で使用できません。");
    }
    cryptoV2Module=await import("/crypto-v2.bundle.js");
    await cryptoV2Module.initializeCryptoV2({
      userId:currentUser.userId,
      internalUserId:currentUser.id,
      signingPrivateKey:ownRecord.signingPrivateKey,
      authorizeDevice:authorizeCryptoDevice
    });
    cryptoV2Ready=true;
    const deviceState=await cryptoV2Module.getCryptoDeviceState(currentUser.userId);
    cryptoV2StatusMessage="この端末のv2暗号鍵を準備しました。端末ID: "+deviceState.deviceId;
  } catch(error) {
    if(cryptoV2Module?.closeCryptoV2 && currentUser) {
      try { await cryptoV2Module.closeCryptoV2(currentUser.userId); } catch {}
    }
    cryptoV2Module=null;
    cryptoV2Ready=false;
    if(error.code==="CRYPTO_V2_DISABLED") {
      cryptoV2Required=false;
      cryptoV2StatusMessage="前方秘匿性v2は現在無効です（安全確認中）。";
    } else {
      cryptoV2StatusMessage="v2端末の初期化に失敗しました: "+(error.code||"CRYPTO_INIT_ERROR");
      console.error("SecureChat crypto v2 initialization failed:",error.code||"CRYPTO_INIT_ERROR");
    }
  }
  updateCryptoV2Controls();
}
function updateCryptoV2Controls() {
  if(el.cryptoV2Status)el.cryptoV2Status.textContent=cryptoV2StatusMessage;
  if(el.cryptoV2Approve) {
    // V2 approval is automatic only after this device explicitly verifies
    // the peer's account-signing fingerprint through an independent channel.
    el.cryptoV2Approve.hidden=true;
    el.cryptoV2Approve.disabled=true;
  }
  if(el.cryptoV2DevicesToggle)el.cryptoV2DevicesToggle.hidden=!cryptoV2Ready;
  if(el.cryptoV2Status && cryptoV2Required && activeProtocolVersion!==2) {
    el.cryptoV2Status.textContent=activeCryptoMode.approvedByMe
      ? "前方秘匿性を必須化しています。相手の本人確認完了後に自動でv2へ移行します。既存v1メッセージは閲覧できますが、新規送信はできません。"
      : activeCryptoMode.approvedByPeer
        ? "相手の本人確認済みです。あなたも指紋を確認すると自動でv2へ移行します。既存v1メッセージは閲覧できますが、新規送信はできません。"
        : "前方秘匿性を必須化しています。相手の署名鍵指紋を別経路で確認すると、自動でv2へ移行して鍵交換を開始します。既存v1メッセージは閲覧できます。";
  } else if(el.cryptoV2Status && activeProtocolVersion===2) {
    el.cryptoV2Status.textContent="前方秘匿性v2有効 — Olm Double Ratchetで鍵配送、Megolm鍵は1メッセージごとに更新";
  }
}
function formatCryptoDeviceTime(value) {
  if(!Number.isFinite(Number(value)))return "不明";
  try {
    return new Intl.DateTimeFormat("ja-JP",{dateStyle:"medium",timeStyle:"short"}).format(new Date(Number(value)));
  } catch {
    return "不明";
  }
}
async function refreshCryptoDeviceList() {
  if(!cryptoV2Ready || !cryptoV2Module || !currentUser || !el.cryptoV2DeviceList)return;
  el.cryptoV2DeviceList.textContent="端末一覧を確認しています…";
  try {
    const [result,state]=await Promise.all([
      cryptoV2Module.listCryptoDevices(currentUser.userId),
      cryptoV2Module.getCryptoDeviceState(currentUser.userId)
    ]);
    const currentDeviceId=state.deviceId;
    el.cryptoV2DeviceList.replaceChildren();
    const devices=Array.isArray(result.devices)?result.devices:[];
    if(!devices.length) {
      const empty=document.createElement("p");
      empty.textContent="登録済み端末はありません。";
      el.cryptoV2DeviceList.append(empty);
      return;
    }
    for(const device of devices) {
      const row=document.createElement("article");
      row.className="crypto-v2-device-row";
      const info=document.createElement("div");
      info.className="crypto-v2-device-info";
      const title=document.createElement("strong");
      const isCurrent=device.deviceId===currentDeviceId;
      title.textContent=(device.displayName||"SecureChat端末")+" · "+(isCurrent?"この端末":device.deviceId);
      const meta=document.createElement("span");
      meta.textContent=device.revokedAt
        ? "失効済み · "+formatCryptoDeviceTime(device.revokedAt)
        : "最終確認: "+formatCryptoDeviceTime(device.lastSeenAt);
      const created=document.createElement("small");
      created.textContent="登録: "+formatCryptoDeviceTime(device.createdAt);
      info.append(title,meta,created);
      row.append(info);
      if(!isCurrent) {
        const alreadyRevoked=!!device.revokedAt;
        const revoke=document.createElement("button");
        revoke.type="button";
        revoke.className="crypto-v2-revoke-button";
        revoke.textContent=alreadyRevoked?"失効通知を再送":"この端末を失効";
        revoke.addEventListener("click",async()=>{
          const promptText=alreadyRevoked
            ? "この端末の失効通知を残存端末へ再送しますか？"
            : "この端末を失効しますか？次回同期以降、失効端末には新しい会話鍵が共有されません。既に保存・複製されたデータを消去できるわけではありません。";
          if(!confirm(promptText))return;
          revoke.disabled=true;
          try {
            const result=await cryptoV2Module.revokeCryptoDevice(currentUser.userId,device.deviceId);
            await cryptoV2Module.syncCryptoV2(currentUser.userId);
            toast("失効通知を "+Number(result.notifiedDevices||0)+" 台の端末へ送信しました。");
            await refreshCryptoDeviceList();
          } catch(error) {
            showError(error,"端末の失効通知を送信できません: ");
            revoke.disabled=false;
          }
        });
        row.append(revoke);
      } else if(isCurrent && !device.revokedAt) {
        const current=document.createElement("span");
        current.className="crypto-v2-current-device";
        current.textContent="使用中";
        row.append(current);
      }
      el.cryptoV2DeviceList.append(row);
    }
  } catch(error) {
    el.cryptoV2DeviceList.textContent="端末一覧を取得できません: "+(error.code||"CRYPTO_DEVICE_LIST_ERROR");
  }
}
async function toggleCryptoDeviceList() {
  if(!cryptoV2Ready || !el.cryptoV2Devices)return;
  const opening=el.cryptoV2Devices.hidden;
  el.cryptoV2Devices.hidden=!opening;
  el.cryptoV2DevicesToggle?.setAttribute("aria-expanded",String(opening));
  if(opening)await refreshCryptoDeviceList();
}
async function refreshCryptoConversationMode() {
  activeProtocolVersion=1;
  activeCryptoMode={protocolVersion:1,approvedByMe:false,approvedByPeer:false};
  if(!activeConversation) {
    updateCryptoV2Controls();
    updateSend();
    return;
  }
  if(!cryptoV2Ready) {
    try {
      const mode=await api("/api/crypto/conversations/"+encodeURIComponent(activeConversation.id)+"/mode");
      activeCryptoMode=mode;
      activeProtocolVersion=Number(mode.protocolVersion||1);
      if(activeProtocolVersion===2) {
        cryptoV2StatusMessage="この会話は前方秘匿性v2です。このタブでは端末鍵を開けていないため送信・復号できません。端末を使用中のタブへ戻るか、先にそのタブを閉じてから再ログインしてください。";
      }
    } catch(error) {
      activeProtocolVersion=1;
      if(error.code!=="CRYPTO_V2_DISABLED") {
        cryptoV2StatusMessage="前方秘匿性v2状態を確認できません: "+(error.code||"CRYPTO_STATUS_ERROR");
      }
    }
    updateCryptoV2Controls();
    updateSend();
    return;
  }
  try {
    const mode=await cryptoV2Module.getConversationCryptoMode(currentUser.userId,activeConversation.id);
    activeCryptoMode=mode;
    activeProtocolVersion=Number(mode.protocolVersion||1);
    if(activeProtocolVersion===2) {
      await cryptoV2Module.prepareEncryptedConversation(currentUser.userId,activeConversation.id,activeConversation.peerUserId);
      cryptoV2StatusMessage="前方秘匿性v2有効 — 信頼済み端末間でMegolm鍵を共有します。";
    } else if(mode.approvedByMe) {
      cryptoV2StatusMessage="この端末の本人確認済みです。相手の本人確認後、v2と鍵交換が自動で有効になります。";
    } else if(mode.approvedByPeer) {
      cryptoV2StatusMessage="相手の本人確認済みです。あなたも指紋を確認するとv2と鍵交換が自動で有効になります。";
    } else {
      cryptoV2StatusMessage="相手の署名鍵指紋を別経路で確認すると、v2への移行と鍵交換が自動で始まります。";
    }
  } catch(error) {
    cryptoV2StatusMessage="前方秘匿性v2状態を確認できません: "+(error.code||"CRYPTO_STATUS_ERROR");
    activeProtocolVersion=1;
  }
  updateCryptoV2Controls();
}
async function maybeAutoApproveCryptoV2ForActiveConversation() {
  const conversation=activeConversation;
  if(!cryptoV2Ready || !cryptoV2Module || !conversation ||
     !cryptoV2Required || !activePeerFingerprintVerified || activeProtocolVersion===2) return;
  const key=conversation.id;
  if(autoV2ApprovalInFlight.has(key)) return;
  autoV2ApprovalInFlight.add(key);
  try {
    const result=await cryptoV2Module.approveAndPrepareConversation(
      currentUser.userId,conversation.id,conversation.peerUserId
    );
    if(!activeConversation || activeConversation.id!==conversation.id) return;
    activeCryptoMode=result;
    activeProtocolVersion=Number(result.protocolVersion||1);
    if(activeProtocolVersion===2) {
      cryptoV2StatusMessage="前方秘匿性v2が自動で有効になりました。鍵交換・メッセージ鍵の更新も自動で行われます。";
      await loadMessages(true);
    } else {
      cryptoV2StatusMessage="この端末の本人確認が完了しました。相手の本人確認後、前方秘匿性v2と鍵交換が自動で有効になります。";
    }
  } catch(error) {
    cryptoV2StatusMessage="前方秘匿性v2の自動鍵交換に失敗しました: "+(error.code||"CRYPTO_AUTO_EXCHANGE_FAILED");
    showError(error,"前方秘匿性v2の自動鍵交換に失敗しました: ");
  } finally {
    autoV2ApprovalInFlight.delete(key);
    if(activeConversation?.id===key) {
      updateCryptoV2Controls();
      updateSend();
    }
  }
}

async function approveCryptoV2ForActiveConversation() {
  if(!cryptoV2Ready || !activeConversation)return;
  if(!activePeerFingerprintVerified) {
    showError(appError("IDENTITY_FINGERPRINT_NOT_VERIFIED","先に相手のSHA-256指紋を別経路で照合してください。"));
    return;
  }
  el.cryptoV2Approve.disabled=true;
  try {
    const result=await cryptoV2Module.approveAndPrepareConversation(
      currentUser.userId,activeConversation.id,activeConversation.peerUserId
    );
    activeCryptoMode=result;
    activeProtocolVersion=Number(result.protocolVersion||1);
    if(activeProtocolVersion===2) {
      cryptoV2StatusMessage="前方秘匿性v2が有効になりました。既存v1メッセージは従来の鍵で復号します。";
      await loadMessages(true);
    } else {
      cryptoV2StatusMessage="この端末の承認を保存しました。相手側の承認を待っています。";
    }
  } catch(error) {
    showError(error,"v2移行を開始できません: ");
  } finally {
    updateCryptoV2Controls();
  }
}

async function registerPortableIdentity(portable,previousRecord=null) {
  let previousIdentitySigningPublicKey=null,identityTransitionSignature=null;
  if(previousRecord?.signingPrivateKey && previousRecord?.signingPublicKey) {
    previousIdentitySigningPublicKey=previousRecord.signingPublicKey;
    const transitionMessage=new TextEncoder().encode(
      "SecureChat identity-key-transition:v1\n"+currentUser.userId+"\n"+
      previousIdentitySigningPublicKey+"\n"+portable.identityPublicKey+"\n"+portable.identitySigningPublicKey
    );
    identityTransitionSignature=toB64(new Uint8Array(await crypto.subtle.sign(
      {name:"ECDSA",hash:"SHA-256"},previousRecord.signingPrivateKey,transitionMessage
    )));
  }
  await api("/api/keys",{method:"PUT",body:{
    identityPublicKey:portable.identityPublicKey,
    identitySigningPublicKey:portable.identitySigningPublicKey,
    identityKeySignature:portable.identityKeySignature,
    identityBackup:portable.identityBackup,
    ...(previousIdentitySigningPublicKey?{previousIdentitySigningPublicKey,identityTransitionSignature}:{})
  }});
  await saveIdentity(currentUser.userId,portable.record);
  setIdentityRecord(portable.record);
}
async function preserveLegacyLocalIdentity(saved,remote) {
  if(!saved?.privateKey || saved.publicKey!==remote.identityPublicKey) {
    throw appError("IDENTITY_LEGACY_DEVICE_REQUIRED","この暗号鍵は旧形式です。鍵を持つ元の端末でログインしてください。新しい端末で鍵を作り直すと、既存の会話を復号できなくなります。");
  }
  let signingPrivateKey=saved.signingPrivateKey;
  let signingPublicKey=saved.signingPublicKey;
  if(!signingPrivateKey || !signingPublicKey) {
    if(remote.identitySigningPublicKey) {
      throw appError("IDENTITY_LEGACY_DEVICE_KEY_MISSING","サーバーには署名鍵がありますが、この端末に対応する秘密鍵がありません。元の端末・ブラウザーデータを保持してください。");
    }
    const pair=await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign","verify"]);
    signingPublicKey=toB64(new Uint8Array(await crypto.subtle.exportKey("raw",pair.publicKey)));
    const privateJwk=await crypto.subtle.exportKey("jwk",pair.privateKey);
    signingPrivateKey=await crypto.subtle.importKey("jwk",privateJwk,{name:"ECDSA",namedCurve:"P-256"},false,["sign"]);
  }
  if(remote.identitySigningPublicKey && remote.identitySigningPublicKey!==signingPublicKey) {
    throw appError("IDENTITY_KEY_CONFLICT","この端末の署名秘密鍵とサーバーの登録情報が一致しません。鍵を上書きせず、元の端末データを保持してください。");
  }
  const record={
    ...saved,privateKey:saved.privateKey,publicKey:saved.publicKey,
    signingPrivateKey,signingPublicKey,peerPins:saved.peerPins||{},verifiedPeerPins:saved.verifiedPeerPins||{},legacyLocalOnly:true
  };
  // Save the non-exportable legacy ECDH key and its signer before contacting
  // the server, so a network interruption cannot strand the one-time upgrade.
  await saveIdentity(currentUser.userId,record);
  if(!remote.identitySigningPublicKey) {
    const challenge=await api("/api/keys/legacy-challenge",{method:"POST",body:{}});
    if(challenge.identityPublicKey!==saved.publicKey) {
      throw appError("IDENTITY_KEY_CONFLICT","この端末の旧暗号鍵とサーバーの鍵が一致しません。");
    }
    const serverPublicKey=await crypto.subtle.importKey(
      "raw",fromB64Url(challenge.serverPublicKey),{name:"ECDH",namedCurve:"P-256"},false,[]
    );
    const shared=await crypto.subtle.deriveBits({name:"ECDH",public:serverPublicKey},saved.privateKey,256);
    const proofKey=await crypto.subtle.importKey("raw",shared,{name:"HMAC",hash:"SHA-256"},false,["sign"]);
    const proofMessage=new TextEncoder().encode(
      "SecureChat legacy-identity-possession:v1\\n"+currentUser.userId+"\\n"+
      challenge.challengeId+"\\n"+saved.publicKey+"\\n"+challenge.challenge
    );
    const possessionProof=await crypto.subtle.sign("HMAC",proofKey,proofMessage);
    await api("/api/keys",{method:"PUT",body:{
      identityPublicKey:saved.publicKey,
      identitySigningPublicKey:signingPublicKey,
      identityKeySignature:toB64(new Uint8Array(await crypto.subtle.sign(
        {name:"ECDSA",hash:"SHA-256"},signingPrivateKey,
        identityProofMessage(currentUser.userId,saved.publicKey)
      ))),
      legacyUpgrade:{challengeId:challenge.challengeId,proof:toB64(new Uint8Array(possessionProof))}
    }});
  } else {
    const verifyKey=await crypto.subtle.importKey("raw",fromB64(signingPublicKey),{name:"ECDSA",namedCurve:"P-256"},false,["verify"]);
    const proofValid=await crypto.subtle.verify(
      {name:"ECDSA",hash:"SHA-256"},verifyKey,fromB64(remote.identityKeySignature),
      identityProofMessage(currentUser.userId,saved.publicKey)
    );
    if(!proofValid) throw appError("IDENTITY_KEY_SIGNATURE_INVALID","旧形式鍵の署名を検証できません。安全のため接続を中止しました。");
  }
  await saveIdentity(currentUser.userId,record);
  setIdentityRecord(record);
  el.fingerprint.hidden=false;
  el.fingerprint.textContent="旧形式の暗号鍵を、この端末に保存されている秘密鍵を維持したまま署名付き形式へ移行しました。\nこの鍵は旧端末内のみで利用できます。暗号化バックアップは作成されていないため、サイトデータを削除したり別端末でログインしたりしないでください。";
}
async function ensureIdentity(password=null) {
  const saved=await storedIdentity(currentUser.userId);
  let remote=await api("/api/keys/backup");
  if(remote.identityRegistered && !remote.backupAvailable &&
     saved?.privateKey && saved.publicKey===remote.identityPublicKey &&
     (!remote.identitySigningPublicKey || remote.identityMode==="legacy-local-only")) {
    await preserveLegacyLocalIdentity(saved,remote);
    return;
  }
  if(remote.identityMode==="legacy-local-only" &&
     (!saved?.privateKey || saved.publicKey!==remote.identityPublicKey)) {
    throw appError("IDENTITY_LEGACY_DEVICE_REQUIRED","このアカウントの旧形式鍵は元の端末にのみ保存されています。元の端末とブラウザーのサイトデータを保持して利用してください。新しい端末では鍵を復元できません。");
  }
  if(remote.backupAvailable) {
    if(!password) {
      if(saved?.privateKey && saved.publicKey===remote.identityPublicKey &&
         saved.signingPublicKey===remote.identitySigningPublicKey) {
        setIdentityRecord(saved);
        return;
      }
      throw appError("IDENTITY_BACKUP_PASSWORD_REQUIRED","暗号鍵を同期するため、パスワードを入力して再ログインしてください。");
    }
    const restored=await decryptIdentityBackup(remote.backup,password);
    if(restored.publicKey!==remote.identityPublicKey || restored.signingPublicKey!==remote.identitySigningPublicKey) {
      throw appError("IDENTITY_BACKUP_INVALID","バックアップの公開鍵がサーバー登録情報と一致しません。");
    }
    const {backupPayload,...restoredIdentity}=restored;
    const record={...restoredIdentity,peerPins:saved?.peerPins||{},verifiedPeerPins:saved?.verifiedPeerPins||{}};
    await saveIdentity(currentUser.userId,record);
    setIdentityRecord(record);
    return;
  }

  if(remote.identityRegistered && !saved?.privateKey) {
    // A second device must never create and silently overwrite a different identity.
    // Retry once to cover two devices reaching the setup endpoint at nearly the same time.
    await new Promise(resolve=>setTimeout(resolve,400));
    remote=await api("/api/keys/backup");
    if(remote.backupAvailable && password) {
      const restored=await decryptIdentityBackup(remote.backup,password);
      if(restored.publicKey!==remote.identityPublicKey || restored.signingPublicKey!==remote.identitySigningPublicKey) {
        throw appError("IDENTITY_BACKUP_INVALID","バックアップの公開鍵がサーバー登録情報と一致しません。");
      }
      const {backupPayload,...restoredIdentity}=restored;
      const record={...restoredIdentity,peerPins:{},verifiedPeerPins:{}};
      await saveIdentity(currentUser.userId,record);setIdentityRecord(record);return;
    }
    const isLegacyLocalOnly=remote.identityMode==="legacy-local-only" || !remote.identitySigningPublicKey;
    throw appError(isLegacyLocalOnly?"IDENTITY_LEGACY_DEVICE_REQUIRED":"IDENTITY_BACKUP_SETUP_REQUIRED",isLegacyLocalOnly?"この旧形式鍵は元の端末にのみ保存されています。元の端末でSecureChatを更新してログインしてください。ブラウザーのサイトデータを削除しないでください。":"このアカウントの暗号鍵は別端末にあります。元の端末で再ログインして同期バックアップを作成してください。");
  }
  if(!password) {
    throw appError("IDENTITY_BACKUP_PASSWORD_REQUIRED","複数端末同期の初期設定にはパスワードの再入力が必要です。");
  }
  if(remote.identityRegistered && saved?.privateKey &&
     (saved.publicKey!==remote.identityPublicKey || saved.signingPublicKey!==remote.identitySigningPublicKey)) {
    throw appError("IDENTITY_KEY_CONFLICT","サーバーの暗号鍵とこの端末の鍵が異なります。以前の端末で鍵が上書きされている可能性があります。安全のため自動上書きを停止しました。");
  }

  const portable=await createPortableIdentity(password,saved?.peerPins||{});
  try {
    await registerPortableIdentity(portable,remote.identityRegistered?saved:null);
  } catch(error) {
    if(error.code==="IDENTITY_KEY_CONFLICT") {
      const latest=await api("/api/keys/backup");
      if(latest.backupAvailable) {
        const restored=await decryptIdentityBackup(latest.backup,password);
        if(restored.publicKey!==latest.identityPublicKey || restored.signingPublicKey!==latest.identitySigningPublicKey) {
          throw appError("IDENTITY_BACKUP_INVALID","バックアップの公開鍵がサーバー登録情報と一致しません。");
        }
        const {backupPayload,...restoredIdentity}=restored;
        const record={...restoredIdentity,peerPins:saved?.peerPins||{},verifiedPeerPins:saved?.verifiedPeerPins||{}};
        await saveIdentity(currentUser.userId,record);setIdentityRecord(record);return;
      }
    }
    throw error;
  }
}
async function showPeerKeyChangeVerification(peerUserId,peer,previousSigningPublicKey) {
  const fingerprint=await publicKeyFingerprint(peer.identitySigningPublicKey);
  el.fingerprint.replaceChildren();
  const heading=document.createElement("strong");
  heading.textContent="@"+peerUserId+" の署名鍵が変更されています";
  const explanation=document.createElement("p");
  explanation.textContent="安全のため接続を停止しました。相手本人と電話など別の安全な経路で照合し、相手のSecureChat画面に表示される「あなた」のSHA-256指紋と下の新しい指紋が完全一致した場合だけ承認してください。";
  const value=document.createElement("p");
  value.textContent="新しい署名鍵のSHA-256指紋:\n"+fingerprint;
  const label=document.createElement("label");
  label.textContent="別経路で相手から受け取った指紋を入力";
  const input=document.createElement("input");
  input.type="text";input.autocomplete="off";input.spellcheck=false;input.maxLength=128;
  input.placeholder="例: 1A2B 3C4D ...";
  const button=document.createElement("button");
  button.type="button";button.textContent="指紋を照合してこの鍵を承認";
  const status=document.createElement("p");
  status.setAttribute("role","status");
  button.addEventListener("click",async()=>{
    if(!fingerprintsMatch(input.value,fingerprint)) {
      status.textContent="指紋が一致しません。承認は行われていません。";
      return;
    }
    button.disabled=true;
    try {
      const latest=await api("/api/keys/"+encodeURIComponent(peerUserId));
      if(latest.identityPublicKey!==peer.identityPublicKey ||
         latest.identitySigningPublicKey!==peer.identitySigningPublicKey) {
        throw appError("IDENTITY_KEY_CHANGED_AGAIN","照合中に相手の鍵が再変更されました。もう一度指紋を確認してください。");
      }
      const verifyKey=await crypto.subtle.importKey("raw",fromB64(latest.identitySigningPublicKey),{name:"ECDSA",namedCurve:"P-256"},false,["verify"]);
      const proofValid=await crypto.subtle.verify(
        {name:"ECDSA",hash:"SHA-256"},verifyKey,fromB64(latest.identityKeySignature),
        identityProofMessage(peerUserId,latest.identityPublicKey)
      );
      if(!proofValid)throw appError("IDENTITY_KEY_SIGNATURE_INVALID","相手の公開鍵署名を検証できません。");
      const ownRecord=await storedIdentity(currentUser.userId);
      const peerPins={...(ownRecord?.peerPins||{})};
      const currentPin=peerPins[peerUserId]||null;
      if(currentPin!==previousSigningPublicKey) {
        throw appError("IDENTITY_PIN_CHANGED","保存済みの指紋が別の操作で更新されました。ページを再読み込みしてください。");
      }
      peerPins[peerUserId]=latest.identitySigningPublicKey;
      const verifiedPeerPins={...(ownRecord?.verifiedPeerPins||{}),[peerUserId]:latest.identitySigningPublicKey};
      await saveIdentity(currentUser.userId,{...ownRecord,peerPins,verifiedPeerPins});
      activePeerFingerprintVerified=true;
      activePeerSigningKey=latest.identitySigningPublicKey;
      el.fingerprint.textContent="署名鍵の指紋を別経路で照合して承認しました。\n相手: "+fingerprint+"\nこの承認はこの端末にだけ保存されます。";
      updateCryptoV2Controls();
      activeKey=null;
      if(activeConversation?.peerUserId===peerUserId) {
        await maybeAutoApproveCryptoV2ForActiveConversation();
        await loadMessages(true);
      }
      updateSend();
    } catch(error) {
      status.textContent=formatError(error);
      button.disabled=false;
    }
  });
  label.append(input);
  el.fingerprint.append(heading,explanation,value,label,button,status);
  el.fingerprint.hidden=false;
}
function renderPeerFingerprintPanel(peerUserId,ownFingerprint,peerFingerprint,peer) {
  const verified=activePeerFingerprintVerified;
  el.fingerprint.replaceChildren();
  const heading=document.createElement("strong");
  heading.textContent="アカウント署名鍵の指紋";
  const own=document.createElement("p");
  own.textContent="あなた: "+ownFingerprint;
  const remote=document.createElement("p");
  remote.textContent="@"+peerUserId+": "+peerFingerprint;
  const status=document.createElement("p");
  status.textContent=verified
    ? "別経路で確認済み（このブラウザーのみ）"
    : "未確認 — 連絡先確認とは別に、電話・対面など別経路で照合してください。照合後、V2移行と鍵交換は自動で行われます";
  const button=document.createElement("button");
  button.type="button";
  button.className="crypto-v2-button";
  button.textContent=verified?"本人確認済み":"別経路で指紋を確認して信頼";
  button.disabled=verified;
  button.addEventListener("click",async()=>{
    button.disabled=true;
    try {
      const success=await confirmPeerFingerprint(peerUserId,peer);
      if(success) {
        activePeerFingerprintVerified=true;
        status.textContent="別経路で確認済み（このブラウザーのみ）";
        button.textContent="本人確認済み";
        updateCryptoV2Controls();
        await maybeAutoApproveCryptoV2ForActiveConversation();
      } else button.disabled=false;
    } catch(error) {
      showError(error);
      button.disabled=false;
    }
  });
  el.fingerprint.append(heading,own,remote,status,button);
  el.fingerprint.hidden=false;
}
async function deriveKey(conversationId,peerUserId) {
  if(activeKey && activeConversation && activeConversation.id===conversationId)return activeKey;
  const peer=await api("/api/keys/"+encodeURIComponent(peerUserId));
  if(!peer.identitySigningPublicKey || !peer.identityKeySignature) {
    throw appError("IDENTITY_KEY_LEGACY_FORMAT","相手の公開鍵は旧形式です。相手に元の端末でSecureChatを強制再読み込みしてからログインしてもらってください。元の端末のブラウザーデータを削除せず、旧形式鍵の移行完了後にもう一度接続してください。");
  }
  const signingKey=await crypto.subtle.importKey("raw",fromB64(peer.identitySigningPublicKey),{name:"ECDSA",namedCurve:"P-256"},false,["verify"]);
  const proofValid=await crypto.subtle.verify(
    {name:"ECDSA",hash:"SHA-256"},signingKey,fromB64(peer.identityKeySignature),
    identityProofMessage(peerUserId,peer.identityPublicKey)
  );
  if(!proofValid)throw appError("IDENTITY_KEY_SIGNATURE_INVALID","相手の公開鍵署名を検証できません。安全のため接続を中止しました。");
  const ownRecord=await storedIdentity(currentUser.userId);
  const peerPins={...(ownRecord?.peerPins||{})};
  const verifiedPeerPins={...(ownRecord?.verifiedPeerPins||{})};
  if(peerPins[peerUserId] && peerPins[peerUserId]!==peer.identitySigningPublicKey) {
    const previousSigningPublicKey=peerPins[peerUserId];
    let transitionValid=false;
    if(peer.previousIdentitySigningPublicKey===previousSigningPublicKey && peer.identityTransitionSignature) {
      const previousSigningKey=await crypto.subtle.importKey(
        "raw",fromB64(previousSigningPublicKey),{name:"ECDSA",namedCurve:"P-256"},false,["verify"]
      );
      const transitionMessage=new TextEncoder().encode(
        "SecureChat identity-key-transition:v1\n"+peerUserId+"\n"+
        previousSigningPublicKey+"\n"+peer.identityPublicKey+"\n"+peer.identitySigningPublicKey
      );
      transitionValid=await crypto.subtle.verify(
        {name:"ECDSA",hash:"SHA-256"},previousSigningKey,
        fromB64(peer.identityTransitionSignature),transitionMessage
      );
    }
    if(!transitionValid) {
      await showPeerKeyChangeVerification(peerUserId,peer,previousSigningPublicKey);
      throw appError("IDENTITY_SIGNING_KEY_CHANGED","相手の署名鍵が以前の登録から変更されています。新しい指紋を別経路で照合するまで接続を中止しています。");
    }
    peerPins[peerUserId]=peer.identitySigningPublicKey;
    delete verifiedPeerPins[peerUserId];
    await saveIdentity(currentUser.userId,{...ownRecord,peerPins,verifiedPeerPins});
  } else if(!peerPins[peerUserId]) {
    peerPins[peerUserId]=peer.identitySigningPublicKey;
    await saveIdentity(currentUser.userId,{...ownRecord,peerPins,verifiedPeerPins});
  }
  activePeerSigningKey=peer.identitySigningPublicKey;
  activePeerFingerprintVerified=verifiedPeerPins[peerUserId]===peer.identitySigningPublicKey;
  const [ownFingerprint,peerFingerprint]=await Promise.all([
    publicKeyFingerprint(identitySigningPublicKey),
    publicKeyFingerprint(peer.identitySigningPublicKey)
  ]);
  renderPeerFingerprintPanel(peerUserId,ownFingerprint,peerFingerprint,peer);
  const pub=await crypto.subtle.importKey("raw",fromB64(peer.identityPublicKey),{name:"ECDH",namedCurve:"P-256"},false,[]);
  const bits=await crypto.subtle.deriveBits({name:"ECDH",public:pub},identityPrivateKey,256);
  const material=await crypto.subtle.importKey("raw",bits,"HKDF",false,["deriveKey"]);
  const salt=await crypto.subtle.digest("SHA-256",new TextEncoder().encode("SecureChat salt:"+conversationId));
  activeKey=await crypto.subtle.deriveKey({
    name:"HKDF",hash:"SHA-256",salt,
    info:new TextEncoder().encode("SecureChat E2EE prototype v1:"+conversationId)
  },material,{name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
  updateCryptoV2Controls();
  return activeKey;
}
async function encryptText(text,key) {
  const nonce=crypto.getRandomValues(new Uint8Array(12));
  const cipher=await crypto.subtle.encrypt({name:"AES-GCM",iv:nonce},key,new TextEncoder().encode(text));
  return {ciphertext:toB64(new Uint8Array(cipher)),nonce:toB64(nonce),algorithm:"AES-GCM-256"};
}
async function decryptText(message,key) {
  const plain=await crypto.subtle.decrypt({name:"AES-GCM",iv:fromB64(message.nonce)},key,fromB64(message.ciphertext));
  return new TextDecoder().decode(plain);
}
function welcome(title,description) {
  el.list.replaceChildren();
  const card=document.createElement("div"); card.className="welcome-card";
  const h=document.createElement("h2"); h.textContent=title;
  const p=document.createElement("p"); p.textContent=description;
  card.append(h,p); el.list.append(card);
}
function appendMessage(text,senderId,createdAt,expiresAt,messageId="") {
  el.list.querySelector(".welcome-card")?.remove();
  const own=senderId===currentUser.id;
  const row=document.createElement("article"); row.className=own?"message-row own":"message-row";
  row.dataset.messageId=messageId;
  row.dataset.expiresAt=String(expiresAt);
  const avatar=document.createElement("div"); avatar.className="message-avatar";
  avatar.textContent=Array.from(own?currentUser.userId:activeConversation.peerUserId)[0]||"U";
  const content=document.createElement("div"); content.className="message-content";
  const meta=document.createElement("div"); meta.className="message-meta";
  const name=document.createElement("span"); name.className="message-name";
  name.textContent=own?"あなた":activeConversation.peerUserId;
  const stamp=document.createElement("time"); stamp.className="message-time";
  stamp.textContent=time(createdAt)+" · "+Math.max(0,Math.ceil((expiresAt-Date.now())/60000))+"分後に削除";
  const bubble=document.createElement("div"); bubble.className="message-bubble"; bubble.textContent=text;
  meta.append(name,stamp); content.append(meta,bubble); row.append(avatar,content); el.list.append(row);
}
function setAuthMode(mode) {
  authMode=mode; const registering=mode==="register";
  el.loginTab.classList.toggle("active",!registering); el.registerTab.classList.toggle("active",registering);
  el.loginTab.setAttribute("aria-selected",String(!registering));
  el.registerTab.setAttribute("aria-selected",String(registering));
  el.title.textContent=registering?"アカウントを作成":"SecureChatへようこそ";
  el.description.textContent=registering?"新しいユーザーIDとパスワードを設定してください。":"アカウントにログインしてください。";
  el.submit.textContent=registering?"アカウントを作成":"ログイン";
  el.password.autocomplete=registering?"new-password":"current-password";
  el.password.minLength=registering?12:0;
  el.passwordHint.textContent=registering?"12〜128文字。長くて推測されにくいパスワードを使ってください。":"パスワードは大文字・小文字を区別します。";
  el.inviteCodeField.hidden=!registering;
  el.inviteCode.required=registering;
  el.error.textContent="";
}
function showAuth(message="") { el.gate.hidden=false; el.error.textContent=message; state("disconnected","ログインが必要です"); }
async function checkSession() {
  let r;
  try { r=await fetch("/api/auth/me",{credentials:"same-origin",cache:"no-store",headers:{Accept:"application/json"}}); }
  catch { throw appError("AUTH_NETWORK_ERROR","認証サーバーに接続できません。"); }
  if(!r.ok)throw appError("AUTH_SESSION_CHECK_FAILED","認証状態を確認できませんでした。");
  return r.json();
}
async function loadPublicAnnouncements() {
  if(!el.announcements || !el.announcementsList) return;
  try {
    const data=await api("/api/announcements");
    el.announcementsList.replaceChildren();
    for(const item of data.announcements||[]) {
      const article=document.createElement("article");
      article.className="public-announcement";
      const title=document.createElement("strong");title.textContent=item.title;
      const body=document.createElement("p");body.textContent=item.body;
      const stamp=document.createElement("time");stamp.textContent=new Intl.DateTimeFormat("ja-JP",{dateStyle:"medium",timeStyle:"short"}).format(new Date(item.published_at));
      article.append(title,body,stamp);el.announcementsList.append(article);
    }
    el.announcements.hidden=!(data.announcements||[]).length;
  } catch { el.announcements.hidden=true; }
}
async function signIn(user,password=null) {
  const sessionState=await checkSession();
  user.isAdmin=!!sessionState.user?.isAdmin;
  user.mustChangePassword=!!sessionState.user?.mustChangePassword;
  currentUser=user;
  if(el.adminLink)el.adminLink.hidden=!user.isAdmin;
  if(el.deleteAccount)el.deleteAccount.hidden=!!user.isAdmin;
  if(user.isAdmin && user.mustChangePassword) {
    el.gate.hidden=true;
    el.passwordChangeGate.hidden=false;
    el.currentAdminPassword.focus();
    return;
  }
  el.passwordChangeGate.hidden=true;
  await loadPublicAnnouncements();
  try {
    await ensureIdentity(password);
    await initializeCryptoV2IfEnabled();
    await refreshSidebar();
  } catch (error) {
    await closeCryptoV2Session();
    
    currentUser=null;
    identityPrivateKey=null;
    identityPublicKey=null;
    identitySigningPublicKey=null;
    throw error;
  }
  el.profile.textContent=user.userId;
  el.avatar.textContent=Array.from(user.userId)[0]||"U";
  el.gate.hidden=true;
  el.form.reset();
  state("connected","準備完了");
  startAuthCheck();
  clearInterval(refreshTimer);
  refreshTimer=setInterval(()=>{
    if(document.visibilityState==="visible" && document.hasFocus() && activeConversation) {
      if(activeProtocolVersion!==2 && ++cryptoModeRefreshTick % 5 === 0) {
        refreshCryptoConversationMode()
          .then(()=>maybeAutoApproveCryptoV2ForActiveConversation())
          .then(()=>loadMessages(false))
          .catch(()=>{});
      } else {
        loadMessages(false).catch(()=>{});
      }
    }
    if(++sidebarRefreshTick % 5 === 0) {
      refreshSidebar().catch(()=>{});
    }
  },1000);
}
function startAuthCheck() {
  clearInterval(authTimer);
  authTimer=setInterval(async()=>{
    try { const s=await checkSession(); if(!s.authenticated){await closeCryptoV2Session();currentUser=null;identityPrivateKey=null;identityPublicKey=null;identitySigningPublicKey=null;activeConversation=null;activeKey=null;showAuth(formatError(appError("SESSION_EXPIRED","セッションの有効期限が切れました。再ログインしてください。")));} }
    catch {showError(appError("AUTH_RECHECK_FAILED","認証サーバーに接続できません。"));}
  },300000);
}
async function submitAdminPasswordChange(event) {
  event.preventDefault();
  const currentPassword=el.currentAdminPassword.value;
  const newPassword=el.newAdminPassword.value;
  const confirmation=el.confirmAdminPassword.value;
  el.passwordChangeError.textContent="";
  if(Array.from(currentPassword).length<12 || Array.from(newPassword).length<12 || Array.from(newPassword).length>128) {
    setError(el.passwordChangeError,appError("PASSWORD_LENGTH_INVALID","現在と新しいパスワードは12〜128文字で入力してください。"));return;
  }
  if(newPassword!==confirmation) {setError(el.passwordChangeError,appError("PASSWORD_CONFIRMATION_MISMATCH","新しいパスワードが一致しません。"));return;}
  if(newPassword===currentPassword) {setError(el.passwordChangeError,appError("PASSWORD_UNCHANGED","現在とは異なるパスワードを設定してください。"));return;}
  el.passwordChangeSubmit.disabled=true;
  try {
    const backupState=await api("/api/keys/backup");
    let identityBackup=null;
    if(backupState.backupAvailable) {
      const restored=await decryptIdentityBackup(backupState.backup,currentPassword);
      identityBackup=await encryptIdentityBackup(restored.backupPayload,newPassword);
    }
    const result=await api("/api/auth/admin/change-password",{
      method:"POST",body:{currentPassword,newPassword,...(identityBackup?{identityBackup}:{})}
    });
    el.passwordChangeForm.reset();
    el.passwordChangeGate.hidden=true;
    await signIn(result.user,newPassword);
    toast("管理者パスワードを変更しました。次回の変更期限は90日後です。");
  } catch(error) {setError(el.passwordChangeError,error);}
  finally {el.passwordChangeSubmit.disabled=false;}
}
async function submitAuth(event) {
  event.preventDefault();
  const userId=el.user.value.trim(),password=el.password.value,registering=authMode==="register";
  el.error.textContent="";
  if(!/^[a-zA-Z0-9_]{3,32}$/.test(userId)){setError(el.error,appError("USER_ID_FORMAT_INVALID","ユーザーIDは半角英数字・アンダースコアの3〜32文字にしてください。"));return;}
  if(registering&&!el.inviteCode.value.trim()){setError(el.error,appError("INVITE_CODE_REQUIRED","招待コードを入力してください。"));return;}
  if(registering&&Array.from(password).length<12){setError(el.error,appError("PASSWORD_TOO_SHORT","パスワードは12文字以上にしてください。"));return;}
  if(!password||Array.from(password).length>128){setError(el.error,appError("PASSWORD_INVALID","パスワードを確認してください。"));return;}
  el.submit.disabled=true;
  try {
    const data=await api(registering?"/api/auth/register":"/api/auth/login",{method:"POST",body:registering?{userId,password,inviteCode:el.inviteCode.value.trim()}:{userId,password}});
    await signIn(data.user,password); toast(registering?"アカウントを作成しました。":"ログインしました。");
  } catch(e) {setError(el.error,e);}
  finally {el.submit.disabled=false;el.submit.textContent=authMode==="register"?"アカウントを作成":"ログイン";}
}
async function issueRegistrationInvite() {
  if(!currentUser)return;
  el.registrationInviteButton.disabled=true;
  try {
    const invite=await api("/api/registration-invitations",{method:"POST",body:{}});
    showOtpCode(el.registrationInvite,invite.code,invite.expiresAt,"","24時間以内に共有してください。コードは1回だけ使用できます。");
    toast("アカウント招待コードを発行しました。");
  } catch(e) {showError(e);}
  finally {el.registrationInviteButton.disabled=false;}
}
async function deleteAccount() {
  if(!currentUser)return;
  const userId=currentUser.userId;
  if(!confirm("@"+userId+" のアカウントを完全に削除します。連絡先・個別チャット・暗号化メッセージも削除されます。この操作は取り消せません。続行しますか？"))return;
  const password=prompt("本人確認のため、現在のパスワードを入力してください。");
  if(password===null)return;
  el.deleteAccount.disabled=true;
  try {
    await api("/api/auth/delete",{method:"POST",body:{password}});
    await removeIdentity(userId);
    await closeCryptoV2Session();
    
    cryptoV2Module=null;cryptoV2Ready=false;currentUser=null;identityPrivateKey=null;identityPublicKey=null;identitySigningPublicKey=null;activeConversation=null;activeKey=null;activeProtocolVersion=1;
    clearInterval(authTimer);clearInterval(refreshTimer);
    setAuthMode("login");showAuth();toast("アカウントと関連データを削除しました。");
  } catch(e) {showError(e);}
  finally {el.deleteAccount.disabled=false;}
}
async function logout() {
  el.logout.disabled=true;
  try {
    await api("/api/auth/logout",{method:"POST"});
    await closeCryptoV2Session();
    
    currentUser=null;identityPrivateKey=null;identityPublicKey=null;identitySigningPublicKey=null;activeConversation=null;activeKey=null;
    clearInterval(authTimer);clearInterval(refreshTimer);setAuthMode("login");showAuth();toast("ログアウトしました。");
  } catch(e) {showError(e);}
  finally {el.logout.disabled=false;}
}
function userAction(userId,label,fn) {
  const row=document.createElement("div");row.className="user-result";
  const name=document.createElement("span");name.textContent=userId;
  const button=document.createElement("button");button.type="button";button.textContent=label;button.addEventListener("click",fn);
  row.append(name,button);return row;
}
function showOtpCode(container,code,expiresAt,key="",detailText="5分以内に相手へ共有してください。") {
  if(key)displayedOtpCodes.set(key,{code,expiresAt});
  container.querySelectorAll(".otp-code-panel").forEach(panel=>panel.remove());
  const panel=document.createElement("div");panel.className="otp-code-panel";
  const value=document.createElement("strong");value.className="otp-code";value.textContent=code;
  const detail=document.createElement("span");detail.textContent=detailText;
  const copy=document.createElement("button");copy.type="button";copy.textContent="コードをコピー";
  copy.addEventListener("click",async()=>{try{await navigator.clipboard.writeText(code);toast("コードをコピーしました。");}catch{showError(appError("CLIPBOARD_COPY_FAILED","コピーできませんでした。コードを手動で共有してください。"));}});
  panel.append(value,detail,copy);container.append(panel);
}
async function searchUsers() {
  const q=el.search.value.trim().toLowerCase();el.results.replaceChildren();
  if(!/^[a-z0-9_]{1,32}$/.test(q)){el.results.textContent=formatError(appError("USER_SEARCH_QUERY_INVALID","1文字以上のユーザーIDを入力してください。"));return;}
  try {
    const data=await api("/api/users/search?q="+encodeURIComponent(q));
    if(!data.users.length){el.results.textContent="ユーザーが見つかりませんでした。";return;}
    for(const user of data.users)el.results.append(userAction(user.userId,"招待コード発行",async()=>{
      try {
        const invite=await api("/api/contact-invitations",{method:"POST",body:{userId:user.userId}});
        el.results.replaceChildren();
        const row=document.createElement("div");row.className="user-result";
        const label=document.createElement("span");label.textContent="@"+user.userId+" への招待コード";
        row.append(label);el.results.append(row);showOtpCode(el.results,invite.code,invite.expiresAt);
        toast("招待コードを発行しました。相手に安全な方法で共有してください。");
        await refreshSidebar();
      } catch(e){showError(e);}
    }));
  } catch(e){el.results.textContent=formatError(e);}
}
function otpInputRow(parent,placeholder,buttonText,handler,fieldKey) {
  const row=document.createElement("div");row.className="otp-input-row";
  const input=document.createElement("input");input.type="text";input.inputMode="numeric";input.autocomplete="one-time-code";input.maxLength=8;input.placeholder=placeholder;input.dataset.invitationField=fieldKey;
  input.addEventListener("input",()=>{input.value=input.value.replace(/\D/g,"").slice(0,8);});
  const button=document.createElement("button");button.type="button";button.textContent=buttonText;
  button.addEventListener("click",async()=>{button.disabled=true;try{await handler(input.value);}catch(e){showError(e);}finally{button.disabled=false;}});
  row.append(input,button);parent.append(row);
}
function renderInvitations(invitations) {
  const preservedInputs=new Map(Array.from(el.invitations.querySelectorAll("input[data-invitation-field]")).map(input=>[input.dataset.invitationField,input.value]));
  el.invitations.replaceChildren();
  const incoming=invitations.filter(i=>i.invitee_user_id===currentUser.userId);
  const outgoing=invitations.filter(i=>i.inviter_user_id===currentUser.userId);
  if(!incoming.length&&!outgoing.length){const p=document.createElement("p");p.className="sidebar-empty";p.textContent="進行中の招待はありません。";el.invitations.append(p);return;}
  for(const inv of incoming) {
    const card=document.createElement("div");card.className="invitation-card";
    const title=document.createElement("strong");title.textContent="@"+inv.inviter_user_id+" からの招待";
    card.append(title);
    if(!inv.invitee_verified_at) {
      const note=document.createElement("p");note.textContent="相手から受け取った8桁コードを入力して承認します。";card.append(note);
      otpInputRow(card,"相手の8桁コード","承認",async code=>{
        await api("/api/contact-invitations/"+inv.id+"/accept",{method:"POST",body:{code}});
        toast("招待を承認しました。次に確認コードを発行してください。");await refreshSidebar();
      },"accept:"+inv.id);
    } else {
      const note=document.createElement("p");note.textContent="あなたの確認コードを発行し、招待した相手へ共有してください。";card.append(note);
      const button=document.createElement("button");button.type="button";button.className="invitation-action";button.textContent="確認コードを発行 / 再発行";
      button.addEventListener("click",async()=>{button.disabled=true;try{const result=await api("/api/contact-invitations/"+inv.id+"/response-code",{method:"POST"});showOtpCode(card,result.code,result.expiresAt,"incoming:"+inv.id);}catch(e){showError(e);}finally{button.disabled=false;}});
      card.append(button);
      const savedCode=displayedOtpCodes.get("incoming:"+inv.id);if(savedCode)showOtpCode(card,savedCode.code,savedCode.expiresAt);
    }
    el.invitations.append(card);
  }
  for(const inv of outgoing) {
    const card=document.createElement("div");card.className="invitation-card";
    const title=document.createElement("strong");title.textContent="@"+inv.invitee_user_id+" への招待";
    card.append(title);
    if(!inv.invitee_verified_at) {
      const note=document.createElement("p");note.textContent="相手が最初のコードを入力するのを待っています。";card.append(note);
      const button=document.createElement("button");button.type="button";button.className="invitation-action";button.textContent=inv.inviter_code_expires_at>Date.now()?"コードを再発行":"期限切れ：コードを再発行";
      button.addEventListener("click",async()=>{button.disabled=true;try{const result=await api("/api/contact-invitations/"+inv.id+"/reissue",{method:"POST"});showOtpCode(card,result.code,result.expiresAt,"outgoing:"+inv.id);}catch(e){showError(e);}finally{button.disabled=false;}});
      card.append(button);
      const savedCode=displayedOtpCodes.get("outgoing:"+inv.id);if(savedCode)showOtpCode(card,savedCode.code,savedCode.expiresAt);
    } else {
      const note=document.createElement("p");note.textContent="相手側の確認が完了しました。相手から受け取ったコードで最終確認します。";card.append(note);
      otpInputRow(card,"相手の8桁コード","最終確認",async code=>{
        const result=await api("/api/contact-invitations/"+inv.id+"/confirm",{method:"POST",body:{code}});
        toast("@"+result.userId+"との相互確認が完了しました。");await refreshSidebar();
      },"confirm:"+inv.id);
    }
    el.invitations.append(card);
  }
  for(const input of el.invitations.querySelectorAll("input[data-invitation-field]")) {
    if(preservedInputs.has(input.dataset.invitationField))input.value=preservedInputs.get(input.dataset.invitationField);
  }
}
async function refreshSidebar() {
  const data=await Promise.all([api("/api/contacts"),api("/api/conversations"),api("/api/contact-invitations")]);
  const contacts=data[0].contacts||[],conversations=data[1].conversations||[];
  renderInvitations(data[2].invitations||[]);
  el.contactCount.textContent=String(contacts.length);el.conversationCount.textContent=String(conversations.length);
  const unreadTotal=conversations.reduce((sum,c)=>sum+Number(c.unread_count||0),0);
  el.unreadTotal.textContent="未読 "+unreadTotal;
  el.unreadTotal.hidden=unreadTotal===0;
  document.title=unreadTotal ? "("+unreadTotal+") "+originalDocumentTitle : originalDocumentTitle;

  const nextUnreadCounts=new Map();
  for(const conversation of conversations) {
    const count=Number(conversation.unread_count||0);
    nextUnreadCounts.set(conversation.id,count);
    const previous=previousUnreadCounts.get(conversation.id)||0;
    if(unreadCountsInitialized && count>previous) notifyUnreadConversation(conversation);
  }
  previousUnreadCounts.clear();
  for(const [id,count] of nextUnreadCounts)previousUnreadCounts.set(id,count);
  unreadCountsInitialized=true;

  el.contacts.replaceChildren();el.conversations.replaceChildren();
  if(!contacts.length){const p=document.createElement("p");p.className="sidebar-empty";p.textContent="連絡先はまだありません。";el.contacts.append(p);}
  for(const c of contacts){
    const row=document.createElement("div");row.className="contact-row";
    const open=document.createElement("button");open.type="button";open.className="sidebar-user-button";open.textContent=c.userId;
    open.addEventListener("click",()=>openConversation(c.userId,open));
    const remove=document.createElement("button");remove.type="button";remove.className="contact-remove";remove.textContent="削除";
    remove.title="@"+c.userId+"を連絡先から削除";
    remove.setAttribute("aria-label",c.userId+"を連絡先から削除");
    remove.addEventListener("click",async()=>{
      if(!confirm("@"+c.userId+"を連絡先から削除しますか？この相手との個別チャットと保存中のメッセージも削除されます。"))return;
      remove.disabled=true;
      try {
        await api("/api/contacts/"+encodeURIComponent(c.userId),{method:"DELETE"});
        if(activeConversation?.peerUserId===c.userId){
          activeConversation=null;activeKey=null;lastMessageCreatedAt=0;lastMessageId="";
          el.chatTitle.textContent="個別チャットを選択";
          el.chatSubtitle.textContent="連絡先を選択してください";
          el.fingerprint.hidden=true;
          welcome("連絡先を削除しました","別のユーザーを選択してチャットを始められます。");
          updateSend();
        }
        await refreshSidebar();
        toast("@"+c.userId+"を削除しました。");
      } catch(error) {showError(error);remove.disabled=false;}
    });
    row.append(open,remove);el.contacts.append(row);
  }
  if(!conversations.length){const p=document.createElement("p");p.className="sidebar-empty";p.textContent="チャットはまだありません。";el.conversations.append(p);}
  for(const c of conversations){
    const b=document.createElement("button");b.type="button";b.className="sidebar-user-button";
    const label=document.createElement("span");label.textContent=c.peer_user_id;
    const badge=document.createElement("span");badge.className="unread-badge";
    const unread=Number(c.unread_count||0);
    badge.textContent=unread>99?"99+":String(unread);
    badge.hidden=unread===0;
    b.append(label,badge);
    b.classList.toggle("active",activeConversation?.id===c.id);
    b.addEventListener("click",()=>selectConversation(c));
    el.conversations.append(b);
  }
}
async function openConversation(peerUserId, triggerButton = null) {
  const peerKey=String(peerUserId).toLowerCase();
  if(openingConversationPeers.has(peerKey))return;
  openingConversationPeers.add(peerKey);
  if(triggerButton)triggerButton.disabled=true;
  try {
    const result=await api("/api/conversations",{method:"POST",body:{recipientUserId:peerUserId}});
    await refreshSidebar();
    await selectConversation({id:result.conversationId,peer_user_id:peerUserId});
  } catch(e){showError(e);}
  finally {
    openingConversationPeers.delete(peerKey);
    if(triggerButton)triggerButton.disabled=false;
  }
}
async function selectConversation(c) {
  setMobileView("chat");
  activeConversation={id:c.id,peerUserId:c.peer_user_id};
  activeKey=null;
  activeProtocolVersion=1;
  activePeerSigningKey=null;
  activePeerFingerprintVerified=false;
  activeCryptoMode={protocolVersion:1,approvedByMe:false,approvedByPeer:false};
  el.fingerprint.hidden=true;
  lastMessageCreatedAt=0;lastMessageId="";messageLoadBusy=false;
  el.chatTitle.textContent=c.peer_user_id;
  el.chatSubtitle.textContent="@"+c.peer_user_id+" · 1対1の個別チャット";
  el.securityTitle.textContent="暗号化チャット（試作）";
  el.securityDescription.textContent="既存メッセージはv1で復号し、双方の端末登録と相手の署名鍵指紋の確認後、端末別Olm/Megolm v2へ自動で移行します。";
  el.securityTag.textContent="E2EE";
  el.composerHint.textContent="暗号化 · メッセージは1時間後に削除";
  welcome("暗号化チャット","このブラウザーで暗号化してから送信します。");
  updateSend();
  try {
    await deriveKey(c.id,c.peer_user_id);
    await refreshCryptoConversationMode();
    await maybeAutoApproveCryptoV2ForActiveConversation();
    if(activeProtocolVersion===2) {
      el.securityTitle.textContent="前方秘匿性v2 — 端末別暗号化";
      el.securityDescription.textContent="Olmで端末間の鍵を配布し、Megolmのメッセージ鍵ラチェットで暗号化します。未確認端末には鍵を共有しません。";
      el.securityTag.textContent="RATCHET v2";
    } else {
      el.securityTitle.textContent="暗号化方式 v1 — 試作版";
      el.securityDescription.textContent="現行v1は会話単位の長期鍵を使用し、前方秘匿性はありません。v2への移行には双方の承認と別経路での指紋照合が必要です。";
      el.securityTag.textContent="v1 / FSなし";
    }
    await loadMessages(true);
    
    updateSend();
  } catch(e) {
    showError(e,"暗号鍵を準備できません: ");
    el.input.disabled=true;
  }
  updateCryptoV2Controls();
  await refreshSidebar();
}
async function loadMessages(fullSync=false) {
  if(!activeConversation||messageLoadBusy)return;
  messageLoadBusy=true;
  const id=activeConversation.id,peer=activeConversation.peerUserId;
  try {
    const key=await deriveKey(id,peer);
    if(activeProtocolVersion===2 && cryptoV2Ready) {
      await cryptoV2Module.syncCryptoV2(currentUser.userId);
    }
    const cursor=fullSync||!lastMessageCreatedAt?"":("?after="+lastMessageCreatedAt+"&afterId="+encodeURIComponent(lastMessageId));
    const data=await api("/api/conversations/"+id+"/messages"+cursor);
    if(!activeConversation||activeConversation.id!==id)return;
    if(fullSync) {
      el.list.replaceChildren();
      lastMessageCreatedAt=0;lastMessageId="";
    }
    for(const m of data.messages) {
      try {
        const plain=Number(m.protocol_version||1)===2
          ? await cryptoV2Module.decryptConversationMessage(currentUser.userId,id,peer,m)
          : await decryptText(m,key);
        appendMessage(plain,m.sender_user_id,m.created_at,m.expires_at,m.id);
      } catch(error) {
        appendMessage(
          Number(m.protocol_version||1)===2
            ? "復号できません（この端末の鍵・送信端末の本人確認・受信済み鍵を確認してください）。"
            : "復号できません（鍵が一致しない可能性があります）。",
          m.sender_user_id,m.created_at,m.expires_at,m.id
        );
        if(Number(m.protocol_version||1)===2)showError(error,"v2メッセージの検証に失敗しました: ");
      }
      if(m.created_at>lastMessageCreatedAt || (m.created_at===lastMessageCreatedAt && m.id>lastMessageId)) {
        lastMessageCreatedAt=m.created_at;lastMessageId=m.id;
      }
    }
    const now=Date.now();
    el.list.querySelectorAll(".message-row").forEach(row=>{
      if(Number(row.dataset.expiresAt)<=now)row.remove();
    });
    if(!el.list.querySelector(".message-row"))welcome("最初のメッセージを送ろう","メッセージは送信から1時間で削除されます。");
    else if(data.messages.length)el.list.scrollTop=el.list.scrollHeight;
  } finally {
    messageLoadBusy=false;
  }
}
async function sendMessage() {
  if(busy||!activeConversation)return;
  const text=el.input.value.trim();if(!text)return;
  if(Array.from(text).length>MAX_MESSAGE_LENGTH){showError(appError("MESSAGE_LENGTH_EXCEEDED","メッセージは2000文字以内にしてください。"));return;}
  if(activeProtocolVersion===2 && !cryptoV2Ready) {
    showError(appError("CRYPTO_V2_DEVICE_NOT_INITIALIZED","この端末のv2暗号鍵が準備できていません。"));
    return;
  }
  busy=true;updateSend();
  try {
    if(activeProtocolVersion===2) {
      await cryptoV2Module.encryptConversationMessage(
        currentUser.userId,activeConversation.id,activeConversation.peerUserId,text
      );
    } else {
      const key=await deriveKey(activeConversation.id,activeConversation.peerUserId);
      const encrypted=await encryptText(text,key);
      await api("/api/conversations/"+activeConversation.id+"/messages",{method:"POST",body:encrypted});
    }
    el.input.value="";el.input.style.height="auto";await loadMessages(true);
  } catch(e){showError(e);}
  finally {busy=false;updateSend();el.input.focus();}
}
setMobileView("list");
el.mobileBack.addEventListener("click",()=>setMobileView("list"));
window.addEventListener("resize",()=>setMobileView(mobileView));
el.loginTab.addEventListener("click",()=>setAuthMode("login"));
el.registerTab.addEventListener("click",()=>setAuthMode("register"));
el.form.addEventListener("submit",submitAuth);
el.passwordChangeForm.addEventListener("submit",submitAdminPasswordChange);
el.logout.addEventListener("click",logout);
el.notificationButton?.addEventListener("click",enableBrowserNotifications);
updateNotificationButton();
el.deleteAccount.addEventListener("click",deleteAccount);
el.registrationInviteButton.addEventListener("click",issueRegistrationInvite);
el.searchButton.addEventListener("click",searchUsers);
el.search.addEventListener("keydown",e=>{if(e.key==="Enter")searchUsers();});
el.input.addEventListener("input",()=>{el.input.style.height="auto";el.input.style.height=Math.min(el.input.scrollHeight,125)+"px";updateSend();});
el.input.addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey&&!e.isComposing){e.preventDefault();sendMessage();}});
el.send.addEventListener("click",sendMessage);
el.cryptoV2Approve?.addEventListener("click",approveCryptoV2ForActiveConversation);
el.cryptoV2DevicesToggle?.addEventListener("click",toggleCryptoDeviceList);
window.addEventListener("focus",()=>{
  if(!currentUser)return;
  if(activeConversation)loadMessages(false).catch(()=>{});
  refreshSidebar().catch(()=>{});
});
document.addEventListener("visibilitychange",()=>{
  if(!currentUser)return;
  if(document.visibilityState==="visible" && document.hasFocus() && activeConversation)loadMessages(false).catch(()=>{});
  refreshSidebar().catch(()=>{});
});

async function bootstrap() {
  setAuthMode("login");state("connecting","認証確認中");
  try {
    const session=await checkSession();
    if(!session.authenticated||!session.user){
      el.authLoading.hidden=true;
      showAuth();
      return;
    }
    await signIn(session.user);
    el.authLoading.hidden=true;
  } catch(e){
    el.authLoading.hidden=true;
    showAuth(formatError(e,"初期化できませんでした: "));
  }
}
bootstrap();
