/**
 * IdentityProvider: who is signed in on this device, on which host, and the
 * account and server administration that hangs off that identity.
 * adapters/legacy implements it with the current password sessions.
 */
import type { Person } from "./chat";

export interface DeviceSession {
  id: string;
  name: string;
  createdAt: number;
  current: boolean;
}

export interface Notice {
  id: string;
  conversation: string;
  at: number;
}

export interface Role {
  id: string;
  name: string;
  memberIds: string[];
}

export interface ReportRecord {
  id: string;
  kind: string;
  body: string;
  status: string;
  logs?: string;
  hasScreenshot: boolean;
}

export interface ReportInput {
  kind: "bug" | "feature";
  body: string;
  logs: string;
  logsConsent: boolean;
  screenshot?: File;
  screenshotConsent: boolean;
}

export interface InviteResult {
  /** Copyable invite link. */
  link?: string;
  /** Copyable invite code (hc1.…); carries the server address, so it works from the native sign-up field. */
  code?: string;
}

/** One invite as the owner sees it. `null` limits mean unlimited / never expires. */
export interface InviteRecord {
  id: string;
  uses: number;
  maxUses: number | null;
  expiresAt: number | null;
  usedAt: number | null;
  serverId: string;
}

/** What a typed server address turned out to be. */
export interface ServerInfo {
  origin: string;
  name: string;
  /** The owner lets people without an invite ask for access. */
  requestsOpen: boolean;
}

export type RequestStatus = "pending" | "approved" | "declined";

/** An access request this device sent, with its last known state. */
export interface PendingRequest {
  origin: string;
  id: string;
  username: string;
  serverName: string;
  status: RequestStatus;
}

/** An access request as the owner sees it. */
export interface AccessRequestRecord {
  id: string;
  username: string;
  message: string;
  status: RequestStatus;
  createdAt: number;
}

export interface Capability {
  id: string;
  available: boolean;
}

export type UpdateState =
  | { kind: "downloading"; version: string; percent?: number }
  | { kind: "ready"; version: string }
  | { kind: "installing"; version: string }
  | { kind: "failed"; version: string };

export interface IdentityState {
  signedIn: boolean;
  busy: boolean;
  error: string;
  me?: Person;
  owner: boolean;
  /** Desktop or mobile build. The web build is tied to the host that served it. */
  native: boolean;
  /** Host address the forms will use; empty on the web build. */
  address: string;
  /** Invite token delivered by a link, waiting for a name and password. */
  inviteToken: string;
  /** Non-secret hints about accounts used on this device, most recent first (web: this host only). */
  remembered: { origin: string; username: string }[];
  /** Web build with a pending invite: a housecall:// link that opens the same invite in the installed app. */
  inviteAppLink?: string;
  /** A stored session is being reopened (native cold start); show a quiet splash, not Log in. */
  restoring: boolean;
  /** An invite that arrived from outside while signed in; confirm before joining. `host` is for display. */
  pendingJoin?: { host: string };
  /** Access requests this device sent, newest first. Call refreshPending() to update statuses. */
  pendingRequests: PendingRequest[];
  /** Owner: number of access requests waiting for a decision (for a badge). */
  accessRequestsPending: number;
  /** Owner: whether people may request access. */
  accessRequestsOpen: boolean;
  /** True while this host was added from the picker and is not signed in yet. */
  adding: boolean;
  serverName: string;
  /** Id of the server these settings apply to. */
  serverId: string;
  /** Icon media path for the current server, if one is set. */
  serverIconUrl?: string;
  devices: DeviceSession[];
  notices: Notice[];
  roles: Role[];
  reports: ReportRecord[];
  capabilities: Capability[];
  notifications: { desktop: "unsupported" | "default" | "granted" | "denied"; background: "unsupported" | "off" | "on" };
  update?: UpdateState;
}

/** One integration's live state. Names and booleans only; the server never sends a config value. */
export interface SetupRow { id: string; ready: boolean; missing?: string[]; detail?: string }

export interface IdentityProvider extends IdentityState {
  /** Owner only. Readiness is instance-wide (host environment), not per server. */
  loadSetupStatus(): Promise<SetupRow[]>;
  clearError(): void;
  signIn(input: { address: string; username: string; password: string }): Promise<void>;
  join(input: { address: string; token: string; name: string; password: string }): Promise<void>;
  setup(input: { address: string; setupToken: string; username: string; password: string }): Promise<void>;
  signOut(): Promise<void>;
  /** Native builds: connect another host from a server address or an invite link. */
  addServer(addressOrLink: string): void;
  /** Invite code, invite link or (native) server address + code. Throws Error with a user-facing message. Signed in: joins directly. */
  enterInvite(input: string, code?: string): void;
  /** Drop a pending invite without redeeming it. */
  clearInvite(): void;
  /** "Not you?": stop suggesting this account on this device. Non-secret hint only; no session is touched. */
  forgetAccount(origin: string, username: string): void;
  /** Signed in only: join the server from the invite that arrived by link. */
  confirmJoin(): void;
  dismissJoin(): void;
  /** Ask a server (public) what it is. Rejects with a user-facing message when it is not a HouseCall server. */
  checkServer(address: string): Promise<ServerInfo>;
  /** Ask the owner for an account. Resolves true when the request was sent and saved. */
  requestAccess(input: { origin: string; username: string; password: string; message?: string }): Promise<boolean>;
  refreshPending(): Promise<void>;
  /** Forget a request (declined, or approved and no longer needed). */
  dismissPending(id: string): void;
  loadInvites(): Promise<InviteRecord[]>;
  revokeInvite(id: string): Promise<void>;
  /** Owner. Also refreshes accessRequestsPending and accessRequestsOpen. */
  loadAccessRequests(): Promise<AccessRequestRecord[]>;
  approveAccessRequest(id: string): Promise<void>;
  declineAccessRequest(id: string): Promise<void>;
  setAccessRequestsOpen(open: boolean): Promise<boolean>;
  cancelAdd(): void;
  loadDevices(): Promise<void>;
  revokeDevice(id: string): Promise<void>;
  enableNotifications(): Promise<void>;
  disableBackgroundNotifications(): Promise<void>;
  /** `null` expiry = never expires, `null` maxUses = unlimited. */
  createInvite(input: { expiresInSeconds: number | null; maxUses: number | null }): Promise<InviteResult>;
  loadRoles(): Promise<void>;
  createRole(name: string): Promise<boolean>;
  assignRole(roleId: string, personId: string): Promise<void>;
  deleteRole(roleId: string): Promise<void>;
  /** Presentation only; the username stays the sign-in name. Resolves true on success. */
  setDisplayName(name: string | null): Promise<boolean>;
  /** `undefined` removes the avatar. The image must already be small (see resizeImage). */
  setAvatar(image: Blob | undefined): Promise<boolean>;
  /** Server settings (owner only). */
  renameServer(name: string): Promise<boolean>;
  setServerIcon(image: Blob | undefined): Promise<boolean>;
  /** Resolves true when the report was sent, so the form clears only then. */
  submitReport(input: ReportInput): Promise<boolean>;
  loadReports(): Promise<void>;
  resolveReport(id: string): Promise<void>;
  downloadReportScreenshot(id: string): Promise<void>;
  restartToUpdate(): Promise<void>;
  dismissUpdate(): void;
}
