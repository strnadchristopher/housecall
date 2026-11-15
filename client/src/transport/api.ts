export interface Session {
  token: string;
  device_key: string;
}
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    readonly sessionGeneration?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
/** Secrets stay in memory. Reload requires authentication; never localStorage/URLs/logs. */
export class Api {
  private session?: Session;
  private sessionGeneration = 0;
  requestGuard?: (path: string, options: RequestInit) => void;
  responseObserver?: (path: string, value: unknown, options: RequestInit) => void;
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
  /** Canonical transport origin, without constructing a credential-bearing Request. */
  serverOrigin(): string { return this.origin || location.origin; }
  authenticate(session?: Session) {
    this.sessionGeneration++; this.session = session;
  }
  isCurrentSessionError(error: ApiError) { return error.sessionGeneration === undefined || error.sessionGeneration === this.sessionGeneration; }
  /** Native/HLS media gets auth headers without exposing credentials to media URLs or redirects. */
  mediaRequest(url: string, init: RequestInit = {}): Request {
    const base = this.origin || location.origin;
    const target = new URL(url, base);
    if (
      target.origin !== new URL(base).origin ||
      !target.pathname.startsWith("/api/") ||
      target.username ||
      target.password
    )
      throw new Error("Authenticated media must remain on this server");
    this.requestGuard?.(target.pathname + target.search, init);
    const headers = new Headers(init.headers);
    if (this.session) {
      headers.set("Authorization", `Bearer ${this.session.token}`);
      headers.set("X-Device-Key", this.session.device_key);
    }
    return new Request(target, {
      ...init,
      headers,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    });
  }
  async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    if (!path.startsWith("/api/") || path.includes("://"))
      throw new Error("API path required");
    this.requestGuard?.(path, options);
    const headers = new Headers(options.headers);
    if (this.session) {
      headers.set("Authorization", `Bearer ${this.session.token}`);
      headers.set("X-Device-Key", this.session.device_key);
    }
    if (options.body && typeof options.body === "string")
      headers.set("Content-Type", "application/json");
    const sessionGeneration = this.sessionGeneration, observer = this.responseObserver;
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
        sessionGeneration,
      );
    }
    if (response.status === 204) return undefined as T;
    const value = await response.json() as T; observer?.(path, value, options); return value;
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
  put<T>(path: string, body: unknown) {
    return this.request<T>(path, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }
  patch<T>(path: string, body: unknown) {
    return this.request<T>(path, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }
  /** Raw binary body, for small images. The blob's own type becomes the content type. */
  putBlob<T>(path: string, body: Blob) {
    return this.request<T>(path, { method: "PUT", body });
  }
  delete<T>(path: string) {
    return this.request<T>(path, { method: "DELETE" });
  }
}
