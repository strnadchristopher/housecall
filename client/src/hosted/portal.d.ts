declare module '*.mjs' {
  export class Account {
    name: string | null; binding: string | null; revision: number;
    list: { format: 1; servers: string[] } | null;
    authenticate(name: string, password: string, register?: boolean): Promise<void>;
    load(): Promise<{ format: 1; servers: string[] }>;
    save(list: { format: 1; servers: string[] }): Promise<void>;
    remember(): Promise<void>; restore(): Promise<boolean>; forgetDevice(binding?: string | null): Promise<void>;
    clear(): void; logout(): Promise<void>; delete(): Promise<void>;
  }
  export function serverList(value: unknown): { format: 1; servers: string[] };
}
