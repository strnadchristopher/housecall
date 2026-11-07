export interface Session {
  token: string;
  device_key: string;
}
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
/** Secrets stay in memory. Reload requires authentication; never localStorage/URLs/logs. */
export class Api {
  private session?: Session;
  constructor(private origin = "") {
    this.configure(origin);
  }
  configure(origin: string) {
    if (!origin) {
      this.origin = "";
      return;
    }
    if (origin) {
      const parsed = new URL(origin);
      if (
        parsed.protocol !== "https:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
      )
        throw new Error("The server must use HTTPS");
      if (parsed.username || parsed.password || parsed.search || parsed.hash)
        throw new Error("Invalid server origin");
      this.origin = parsed.origin;
    }
  }
  authenticate(session?: Session) {
    this.session = session;
  }
  async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    if (!path.startsWith("/api/") || path.includes("://"))
      throw new Error("API path required");
    const headers = new Headers(options.headers);
    if (this.session) {
      headers.set("Authorization", `Bearer ${this.session.token}`);
      headers.set("X-Device-Key", this.session.device_key);
    }
    if (options.body && typeof options.body === "string")
      headers.set("Content-Type", "application/json");
    const response = await fetch(this.origin + path, {
      ...options,
      headers,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new ApiError(
        response.status,
        data.error ?? `Request failed (${response.status})`,
      );
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
  get<T>(path: string, signal?: AbortSignal) {
    return this.request<T>(path, { signal });
  }
  post<T>(path: string, body: unknown) {
    return this.request<T>(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
  patch<T>(path: string, body: unknown) {
    return this.request<T>(path, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }
  delete<T>(path: string) {
    return this.request<T>(path, { method: "DELETE" });
  }
}
