export function normalizeFingerprintInput(value) {
  if (typeof value !== "string") return "";
  let input = value.trim();
  // Accept a copied label such as "SHA-256: ..." or "SHA-256 指紋: ...".
  input = input.replace(/^SHA-?256(?:\s*(?:fingerprint|指紋))?\s*[:：=]?\s*/i, "");
  input = input.replace(/^0x/i, "");
  // Only formatting separators are ignored. Other characters invalidate input.
  if (!/^[0-9a-f\s:-]+$/i.test(input)) return "";
  return input.replace(/[\s:-]/g, "").toUpperCase();
}

export function fingerprintsMatch(supplied, expected) {
  const actual = normalizeFingerprintInput(supplied);
  const target = normalizeFingerprintInput(expected);
  return actual.length === 64 && target.length === 64 && actual === target;
}
