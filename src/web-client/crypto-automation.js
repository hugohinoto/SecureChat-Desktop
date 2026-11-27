export async function runAutomaticCryptoKeyExchange({
  userId,
  contacts = [],
  conversations = [],
  crypto,
  isPeerTrusted,
  onError = () => {}
}) {
  if (typeof userId !== "string" || !userId ||
      !crypto || typeof crypto.syncCryptoV2 !== "function" ||
      typeof crypto.getConversationCryptoMode !== "function" ||
      typeof crypto.approveAndPrepareConversation !== "function" ||
      typeof crypto.maintainPeerSessions !== "function" ||
      typeof isPeerTrusted !== "function") {
    throw new TypeError("CRYPTO_AUTOMATION_ARGUMENTS_INVALID");
  }

  // Process inbound Olm events and replenish this device's signed one-time keys
  // even when no conversation is currently open.
  await crypto.syncCryptoV2(userId);

  const contactIds = new Set(
    contacts.map(contact => String(contact?.userId || contact?.user_id || "").toLowerCase()).filter(Boolean)
  );
  const results = [];
  const seenConversations = new Set();

  for (const conversation of conversations) {
    const conversationId = String(conversation?.id || "");
    const peerUserId = String(conversation?.peer_user_id || conversation?.peerUserId || "").toLowerCase();
    if (!conversationId || !peerUserId || !contactIds.has(peerUserId) || seenConversations.has(conversationId)) continue;
    seenConversations.add(conversationId);

    try {
      // Trust is local-device scoped. A failed or missing identity check must
      // never be turned into an automatic approval.
      if (!await isPeerTrusted(peerUserId)) {
        results.push({ conversationId, peerUserId, status: "identity-unverified", mode: null });
        continue;
      }

      let mode = await crypto.getConversationCryptoMode(userId, conversationId);
      if (Number(mode?.protocolVersion || 1) !== 2 && mode?.approvedByMe !== true) {
        mode = await crypto.approveAndPrepareConversation(userId, conversationId, peerUserId);
      }

      // Queries peer devices and creates missing Olm sessions. Room keys are
      // distributed by the existing per-message encryption path, so this
      // maintenance pass does not create unused Megolm sessions.
      await crypto.maintainPeerSessions(userId, peerUserId);
      mode = await crypto.getConversationCryptoMode(userId, conversationId);

      results.push({
        conversationId,
        peerUserId,
        status: Number(mode?.protocolVersion || 1) === 2 ? "v2-ready" : "waiting-for-peer",
        mode
      });
    } catch (error) {
      try { onError(error, conversation); } catch {}
      results.push({ conversationId, peerUserId, status: "error", mode: null, error });
    }
  }

  return results;
}
