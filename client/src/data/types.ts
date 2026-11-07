import type { Session } from "../transport/api";
export interface User {
  id: string;
  username: string;
  is_owner: boolean;
}
export interface Auth extends Session {
  user: User;
  expires_at: number;
}
export interface Channel {
  id: string;
  name: string;
  kind: "channel" | "dm" | "group_dm";
  server_id?: string | null;
}
export interface Device {
  id: string;
  device_name: string;
  created_at: number;
  expires_at: number;
  current: boolean;
}
export interface ServerEvent {
  id: number;
  kind: string;
  channel_id?: string;
  payload: Record<string, unknown>;
  created_at: number;
}
export interface Report {
  id: string;
  kind: string;
  body: string;
  status: string;
  logs?: string | null;
}
export interface Server {
  id: string;
  name: string;
  general_channel_id: string;
}
export interface Role {
  id: string;
  name: string;
  member_ids: string[];
}
