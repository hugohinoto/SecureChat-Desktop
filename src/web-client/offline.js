(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  let snapshot = null, selectedId = null, creating = false;
  function setConnection(state, announce = false) {
    const labels = { online: "オンライン", offline: "オフライン", reconnecting: "再接続中" };
    $("connection-pill").dataset.state = state;
    $("connection-label").textContent = labels[state] || "接続状態を確認中";
    if (!announce) return;
    let toast = document.getElementById("connection-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "connection-toast";
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
      Object.assign(toast.style, { position:"fixed", zIndex:"20", top:"16px", right:"16px", padding:"12px 16px", border:"1px solid rgba(142,215,232,.35)", borderRadius:"12px", background:"#101a2b", color:"#edf4ff" });
      document.body.append(toast);
    }
    toast.textContent = state === "offline" ? "オフラインです。ローカル保管庫を利用できます。" : state === "reconnecting" ? "SecureChatに再接続しています。" : "接続が復旧しました。オンライン画面に切り替えます。";
    clearTimeout(window.__connectionToastTimer);
    window.__connectionToastTimer = setTimeout(() => toast.remove(), 5000);
  }
  function showGate(exists) {
    $("gate").hidden = false; $("workspace").hidden = true; creating = !exists;
    $("gate-title").textContent = exists ? "保管庫をロック解除" : "ローカル保管庫を作成";
    $("gate-description").textContent = exists ? "設定したマスターパスワードを入力してください。" : "マスターパスワードから暗号鍵を導出して保存します。";
    $("gate-submit").textContent = exists ? "ロック解除" : "保管庫を作成";
    $("password").value = ""; $("password").autocomplete = exists ? "current-password" : "new-password";
    $("confirm-password-row").hidden = exists; $("confirm-password").disabled = exists;
    $("confirm-password").value = ""; $("gate-error").textContent = "";
  }
  function render() {
    const list = $("conversation-list"); list.replaceChildren();
    for (const conversation of snapshot.conversations) {
      const button = document.createElement("button");
      button.type = "button"; button.className = "sidebar-user-button" + (conversation.id === selectedId ? " active" : "");
      button.textContent = conversation.title;
      button.addEventListener("click", () => { selectedId = conversation.id; render(); });
      list.append(button);
    }
    const selected = snapshot.conversations.find(item => item.id === selectedId);
    $("chat-title").textContent = selected ? selected.title : "チャットを選択";
    $("chat-subtitle").textContent = selected ? "ローカル保管庫の会話" : "ローカルチャットを選択してください";
    const area = $("messages"); area.replaceChildren();
    const divider = document.createElement("div"); divider.className = "day-divider";
    const dividerText = document.createElement("span"); dividerText.textContent = "SECURECHAT DESKTOP"; divider.append(dividerText); area.append(divider);
    if (!selected || !selected.messages.length) {
      const empty = document.createElement("div"); empty.className = "welcome-card";
      const orb = document.createElement("div"); orb.className = "welcome-orb"; orb.textContent = "＋";
      const heading = document.createElement("h2"); heading.textContent = selected ? "最初のメッセージを入力してください。" : "会話のための、静かな場所。";
      const paragraph = document.createElement("p"); paragraph.textContent = selected ? "この会話はこの端末の中だけに保存されます。" : "ローカルチャットを作成してメッセージを保存できます。";
      empty.append(orb, heading, paragraph); area.append(empty);
    } else {
      for (const message of selected.messages) {
        const row = document.createElement("article"); row.className = "message-row own";
        const avatar = document.createElement("div"); avatar.className = "message-avatar"; avatar.textContent = "S";
        const content = document.createElement("div"); content.className = "message-content";
        const meta = document.createElement("div"); meta.className = "message-meta";
        const name = document.createElement("span"); name.className = "message-name"; name.textContent = "この端末";
        const time = document.createElement("time"); time.className = "message-time"; time.textContent = new Date(message.createdAt).toLocaleString();
        const bubble = document.createElement("div"); bubble.className = "message-bubble"; bubble.textContent = message.text;
        meta.append(name, time); content.append(meta, bubble); row.append(avatar, content); area.append(row);
      }
      area.scrollTop = area.scrollHeight;
    }
    $("message-input").disabled = !selected; $("send").disabled = !selected;
    $("composer-hint").textContent = selected ? "このメッセージは端末内にのみ保存されます" : "ローカルチャットを選択すると入力できます";
  }
  async function enter() {
    snapshot = await window.secureChat.getSnapshot();
    selectedId = snapshot.conversations[0]?.id ?? null;
    $("gate").hidden = true; $("workspace").hidden = false; render();
  }
  $("gate-form").addEventListener("submit", async event => {
    event.preventDefault();
    const password = $("password").value;
    if (creating && password !== $("confirm-password").value) { $("gate-error").textContent = "確認用パスワードが一致しません。"; return; }
    $("gate-submit").disabled = true; $("gate-error").textContent = "";
    try {
      if (creating) await window.secureChat.createVault(password); else await window.secureChat.unlock(password);
      await enter();
    } catch (error) {
      const code = String(error?.message || "UNKNOWN");
      $("gate-error").textContent = code === "VAULT_UNLOCK_FAILED" ? "パスワードが違うか、保管庫データが破損しています。" : code === "MASTER_PASSWORD_POLICY" ? "12文字以上のパスワードを設定してください。" : "処理に失敗しました: " + code;
    } finally { $("gate-submit").disabled = false; $("password").value = ""; $("confirm-password").value = ""; }
  });
  $("new-chat").addEventListener("click", async () => {
    const title = window.prompt("チャット名");
    if (!title?.trim()) return;
    try { const conversation = await window.secureChat.createConversation(title); snapshot.conversations.unshift(conversation); selectedId = conversation.id; render(); }
    catch { window.alert("チャットを作成できませんでした。"); }
  });
  $("composer").addEventListener("submit", async event => {
    event.preventDefault();
    if (!selectedId) return;
    const input = $("message-input"), value = input.value.trim();
    if (!value) return;
    $("send").disabled = true;
    try { await window.secureChat.addLocalMessage(selectedId, value); snapshot = await window.secureChat.getSnapshot(); input.value = ""; render(); }
    catch { window.alert("メッセージをローカル保存できませんでした。"); }
    finally { $("send").disabled = false; }
  });
  $("lock").addEventListener("click", async () => { await window.secureChat.lock(); snapshot = null; selectedId = null; showGate(true); });
  window.secureChat.getVaultStatus().then(status => showGate(status.exists)).catch(() => showGate(false));
  window.secureChat.getConnectionState().then(state => setConnection(state, false)).catch(() => setConnection("offline", false));
  window.secureChat.onConnectionState(state => setConnection(state, true));
})();
