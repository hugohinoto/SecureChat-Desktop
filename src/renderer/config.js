(() => {
  const form = document.getElementById("server-form");
  const input = document.getElementById("server-url");
  const button = document.getElementById("connect");
  const error = document.getElementById("error");
  const api = window.secureChatConfig;
  api.get().then(value => { input.value = value.serverUrl || ""; }).catch(() => { error.textContent = "現在の接続先設定を読み込めませんでした。"; });
  api.onError(message => { error.textContent = message; });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    button.disabled = true;
    error.textContent = "";
    try {
      await api.save(input.value.trim());
    } catch (e) {
      const code = String(e?.message || "");
      const messages = {
        SERVER_URL_INVALID: "有効なサーバーURLを入力してください。",
        SERVER_URL_HTTPS_REQUIRED: "HTTPSのURLを入力してください。",
        SERVER_URL_ORIGIN_ONLY: "ドメインのルートURLだけを入力してください。"
      };
      error.textContent = messages[code] || "接続先を保存できませんでした: " + code;
    } finally { button.disabled = false; }
  });
})();
