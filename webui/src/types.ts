export type Json = Record<string, unknown>;
export interface Account {
  qqRuntime?: { packageId: string | null; profileId: string; experimental: boolean };
  id: string; label: string; expectedUin?: string; boundUin?: string | null; bridgeInstalled?: boolean; revision?: number; desired: 'running' | 'stopped'; state: string;
  health?: Json; maintenance?: { operation?: string; phase?: string; previous?: string; at?: number } | null; error?: string;
}
export interface Overview { accounts: Account[]; resources: { totalMemory: number; freeMemory: number }; version: string; maxAccounts: number }
export interface NodeConfig {
  id: string; label?: string; type: 'httpApi' | 'httpPost' | 'wsServer' | 'wsClient'; enabled: boolean;
  token?: string; tokenPresent?: boolean; url?: string; role?: 'Universal' | 'Api' | 'Event';
  secret?: string; secretPresent?: boolean; quickOperations?: boolean;
  heartbeatMs?: number; reconnectMinMs?: number; reconnectMaxMs?: number; timeoutMs?: number;
  pingTimeoutMs?: number; maxPending?: number; ratePerSecond?: number; burst?: number;
  eventBufferSize?: number; eventMaxAgeMs?: number;
}
export interface AccountConfig { label: string; expectedUin?: string; nodes: NodeConfig[]; actionTimeoutMs?: number; notifications?: { enabled: boolean; channelIds: string[] } }
export interface AuthState { initialized: boolean; authenticated: boolean; csrf?: string }
export interface RemoteSession { sessionId: string; profileId: string; path: string; password: string; expiresAt: number | string }
export interface RemoteMetadata { active: boolean; expiresAt?: number | string }
export interface Backup { id: string; kind?: string; at?: string | number; bytes?: number; createdAt?: string | number; profileIds?: string[]; size?: number; state?: string }

/** 好友与消息页的页内状态（由 App 持有，页面只读写传入对象）。 */
export interface SocialState {
  tab: 'contacts' | 'messages';
  contacts: Json[]; kind: 'friends' | 'groups'; search: string; detail: unknown;
  queryForm: { kind: string; id: string; member: string };
}
export interface MessageState {
  form: { type: 'private' | 'group'; recipient: string; text: string; at: string; reply: string; advanced: boolean; segments: string };
  actionName: string; actionParams: string; actionResult: unknown; uploadedImage: string;
}
export interface ActionCapability {
  name: string; implemented: boolean; available: boolean; verification: string;
  runtime_verification?: string; availability_basis?: string; reason?: string;
  variants?: { custom_text_image_nodes: boolean; existing_message_id_nodes: boolean; existing_scope: string };
  target_validation?: { qq_version: string; platform: string; date: string; scopes: string[]; reference: string };
}
export interface SegmentCapability {
  name: string; implemented: boolean; send: boolean; receive: boolean; verification: string;
  runtime_verification?: string;
  receive_scope?: string; send_contexts?: string[]; receive_contexts?: string[];
}
export interface CapabilityCatalogue {
  schema_version: 1; qq_version: string | null; ready: boolean;
  runtime_profile?: { profile_id: string; package_id: string | null; platform: string; architecture: string;
    qq_version: string | null; admission: string; evidence: string; native_eligible: boolean; reason: string;
    package_sha256: string | null; wrapper_sha256: string | null; experimental: boolean };
  actions: ActionCapability[]; extensions: ActionCapability[];
  segments: SegmentCapability[]; segment_extensions: SegmentCapability[];
  events: { name: string; implemented: boolean; available: boolean; subtypes: string[] }[];
  notes: string[];
}
export interface CapabilityState { catalogue: CapabilityCatalogue | null; loading: boolean; error: string }
export interface SettingsState {
  text: string; maxAccounts: number; publicBaseUrl: string;
  statusCommand: { enabled: boolean; trigger: string };
  rkey: { fallbackServers: string[] }; musicSignUrl: string;
  musicSignKey: string; hasMusicSignKey: boolean; clearMusicSignKey: boolean;
  passwords: { currentPassword: string; newPassword: string; confirm: string };
}
export interface StoragePolicy { logMaxMiB: number; logRetentionDays: number; enabled: boolean }
export interface StorageUsage { bytes: number; files: number; scanned: boolean; partial: boolean }
export interface StorageAccount {
  profileId: string; label: string; uin?: string; state: string; canClean: boolean; blockedReason: string | null;
  totalBytes: number; logs: StorageUsage; history: StorageUsage; media: StorageUsage;
}
export interface StorageCleanup {
  at: string | number; scope: 'logs' | 'account'; profileId?: string; category?: 'history' | 'media';
  deletedFiles: number; reclaimedBytes: number; skipped: number; partial: boolean;
}
export interface StorageSnapshot {
  policy: StoragePolicy;
  totals: { logsBytes: number; historyBytes: number; mediaBytes: number; totalBytes: number; files: number };
  accounts: StorageAccount[]; scanned: { accounts: number; files: number; entries: number };
  partial: boolean; lastCleanup: StorageCleanup | null;
}
export type StorageCleanupRequest = { scope: 'logs' } | { scope: 'account'; profileId: string; category: 'history' | 'media' };
export interface BackupState {
  list: Backup[];
  form: { profileIds: string[]; kind: 'ordinary' | 'full'; password: string };
  restore: { backupId: string; password: string; previewId: string; preview: unknown };
}
