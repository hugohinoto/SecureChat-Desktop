export function validateServerUrl(value: unknown, allowInsecureDev = process.env.SECURECHAT_ALLOW_INSECURE_DEV === "1"): string {
  if (typeof value !== "string" || value.length > 2048) throw new Error("SERVER_URL_INVALID");
  let parsed: URL;
  try { parsed = new URL(value.trim()); } catch { throw new Error("SERVER_URL_INVALID"); }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(allowInsecureDev && loopback && parsed.protocol === "http:")) {
    throw new Error("SERVER_URL_HTTPS_REQUIRED");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("SERVER_URL_INVALID");
  if (parsed.pathname !== "/" && parsed.pathname !== "") throw new Error("SERVER_URL_ORIGIN_ONLY");
  return parsed.origin;
}
