declare const __APP_VERSION__: string;
/** The client's own version, stamped from package.json at build time. */
export const CLIENT_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
