(() => {
  "use strict";
  const nativeFetch = window.fetch.bind(window);

  window.fetch = async (input, init = {}) => {
    let rawUrl;
    try {
      rawUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      const target = new URL(rawUrl, window.location.href);
      if (!target.pathname.startsWith("/api/")) return nativeFetch(input, init);

      const method = String(init.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
      let body = init.body ?? null;
      if (body instanceof Blob) body = new Uint8Array(await body.arrayBuffer());
      else if (body instanceof ArrayBuffer) body = new Uint8Array(body);
      else if (input instanceof Request && body === null && method !== "GET" && method !== "HEAD") body = new Uint8Array(await input.clone().arrayBuffer());
      if (body !== null && typeof body !== "string" && !(body instanceof Uint8Array)) {
        return new Response(JSON.stringify({ error: "DESKTOP_BODY_UNSUPPORTED" }), {
          status: 415, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
        });
      }
      const sourceHeaders = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
      const result = await window.secureChatDesktop.request(target.pathname + target.search, {
        method,
        body,
        contentType: sourceHeaders.get("content-type") || undefined
      });
      const headers = new Headers({
        "Content-Type": result.contentType || "application/json",
        "Cache-Control": "no-store"
      });
      return new Response(result.status === 204 || result.status === 304 ? null : result.body, {
        status: result.status, headers
      });
    } catch (error) {
      if (error instanceof TypeError) throw error;
      return new Response(JSON.stringify({ error: "DESKTOP_API_UNAVAILABLE", message: "デスクトップ通信ブリッジを利用できません。" }), {
        status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
      });
    }
  };

  function updateConnection(state, announce) {
    const pill = document.getElementById("connection-pill");
    const label = document.getElementById("connection-label");
    if (!pill || !label) return;
    const labels = { online: "オンライン", offline: "オフライン", reconnecting: "再接続中" };
    pill.dataset.state = state;
    label.textContent = labels[state] || "接続状態を確認中";
    if (!announce) return;
    let toast = document.getElementById("desktop-connection-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "desktop-connection-toast";
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
      Object.assign(toast.style, {
        position: "fixed", zIndex: "9999", top: "16px", right: "16px",
        maxWidth: "min(420px, calc(100vw - 32px))", padding: "12px 16px",
        border: "1px solid rgba(142,215,232,.35)", borderRadius: "12px",
        background: "#101a2b", color: "#edf4ff", boxShadow: "0 12px 40px #0008"
      });
      document.body.append(toast);
    }
    toast.textContent = state === "online" ? "SecureChatへの接続が復旧しました。"
      : state === "offline" ? "接続が切れました。ネットワークを確認してください。"
      : "SecureChatに再接続しています。";
    clearTimeout(window.__desktopConnectionToastTimer);
    window.__desktopConnectionToastTimer = setTimeout(() => toast.remove(), 5000);
  }

  document.addEventListener("DOMContentLoaded", () => {
    window.secureChatDesktop.getConnectionState().then(state => updateConnection(state, false)).catch(() => updateConnection("offline", false));
    window.secureChatDesktop.onConnectionState(state => updateConnection(state, true));
  }, { once: true });
})();
