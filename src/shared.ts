export interface Message { id: string; text: string; createdAt: string; direction: "outgoing" | "incoming"; delivery: "local" | "queued" | "delivered"; }
export interface Conversation { id: string; title: string; createdAt: string; messages: Message[]; }
export interface QueueEntry { id: string; conversationId: string; messageId: string; createdAt: string; status: "waiting-for-connection" | "blocked"; }
export interface VaultData { schemaVersion: 1; conversations: Conversation[]; outbox: QueueEntry[]; }
export interface DesktopApi {
  createVault(password: string): Promise<void>; unlock(password: string): Promise<void>; lock(): Promise<void>;
  getSnapshot(): Promise<VaultData>; createConversation(title: string): Promise<Conversation>;
  addLocalMessage(conversationId: string, text: string): Promise<Message>;
  getVaultStatus(): Promise<{exists: boolean; unlocked: boolean}>;\n  getConnectionState(): Promise<"online" | "offline" | "reconnecting">;\n  onConnectionState(callback: (state: "online" | "offline" | "reconnecting") => void): void;
}
declare global { interface Window { secureChat: DesktopApi; } }
