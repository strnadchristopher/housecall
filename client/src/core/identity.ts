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

export interface IdentityProvider extends IdentityState {
  clearError(): void;
  signIn(input: { address: string; username: string; password: string }): Promise<void>;
  join(input: { address: string; token: string; name: string; password: string }): Promise<void>;
  setup(input: { address: string; setupToken: string; username: string; password: string }): Promise<void>;
  signOut(): Promise<void>;
  /** Native builds: connect another host from a server address or an invite link. */
  addServer(addressOrLink: string): void;
  cancelAdd(): void;
  loadDevices(): Promise<void>;
  revokeDevice(id: string): Promise<void>;
  enableNotifications(): Promise<void>;
  disableBackgroundNotifications(): Promise<void>;
  createInvite(input: { expiresInSeconds: number }): Promise<InviteResult>;
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
