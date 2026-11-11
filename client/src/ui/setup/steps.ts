/**
 * Copy for the integration cards. Every variable named in a `{ code }` step is a real key in
 * .env.example (tests/setup-steps.test.ts enforces it) and no step carries a real value.
 * Readiness is instance-wide: these are host settings, not per-server ones.
 */
export type Step = string | { code: string };

export type IntegrationId = "calls" | "media" | "scanner" | "transcode" | "dj" | "gimme" | "plex" | "giphy" | "vm";

export interface IntegrationCopy { title: string; why: string; steps: Step[] }

const restart: Step[] = ["Restart Housecall:", { code: "docker compose up -d app" }, "Press Check again."];

export const INTEGRATIONS: Record<IntegrationId, IntegrationCopy> = {
  calls: {
    title: "Calls", why: "Voice and video between people in a channel.",
    steps: [
      "Open the call port on the host firewall and forward it (UDP) from your router. Calls skip the web proxy.",
      "In .env, set the address people can reach and the port:",
      { code: "SFU_PUBLIC_IP=203.0.113.10\nSFU_PORT=50000" },
      "Use SFU_HOST_BIND=0.0.0.0 to publish the port beyond this machine.",
      ...restart,
    ],
  },
  media: {
    title: "Uploads", why: "Files, pictures and video in chat, encrypted on disk.",
    steps: [
      "Create a key with python3 scripts/init-env.py, or set your own 64 hex characters:",
      { code: "HOUSECALL_MEDIA_KEY=" },
      ...restart,
    ],
  },
  scanner: {
    title: "Virus scan", why: "Every upload is scanned before anyone can open it.",
    steps: [
      "The default image runs ClamAV for you. Keep this set:",
      { code: "HOUSECALL_MEDIA_SCANNER=clamav" },
      "Give the scanner a minute to download its signatures on first start.",
      ...restart,
    ],
  },
  transcode: {
    title: "Video processing", why: "Makes uploaded video play in the browser and adds thumbnails.",
    steps: [
      "Uploads must be on first. The default image includes ffmpeg. For another path:",
      { code: "HOUSECALL_FFMPEG=/usr/bin/ffmpeg" },
      ...restart,
    ],
  },
  dj: {
    title: "DJ", why: "Play music into a voice channel for everyone.",
    steps: [
      "Calls and uploads must be ready first.",
      "On the Housecall host, add to .env, with the address of your chat-completions endpoint:",
      { code: "DJ_ENABLED=true\nSWITCHBOARD_URL=" },
      "If that endpoint needs a key:",
      { code: "SWITCHBOARD_API_KEY=" },
      ...restart,
    ],
  },
  gimme: {
    title: "Gimme", why: "Request media from chat and follow it to done.",
    steps: [
      "The standard Compose file keeps requests in test mode: they are recorded in chat but not sent.",
      "To send real requests, run Housecall with these set (HTTPS only):",
      { code: "GIMME_BASE_URL=\nGIMME_AGENT_API_KEY=\nGIMME_DRY_RUN=false" },
      "Press Check again.",
    ],
  },
  plex: {
    title: "Plex", why: "Watch your Plex library together in a call.",
    steps: [
      "Calls must be ready first. Set both, or neither:",
      { code: "PLEX_URL=\nPLEX_TOKEN=" },
      ...restart,
    ],
  },
  giphy: {
    title: "GIFs", why: "Search and send GIFs from the message box.",
    steps: [
      "Create a free key at developers.giphy.com, then add:",
      { code: "GIPHY_API_KEY=" },
      ...restart,
    ],
  },
  vm: {
    title: "Shared browser", why: "A virtual machine everyone in a call can watch and use.",
    steps: [
      "Calls must be ready first. Follow docs/VM.md to prepare the base disk, then start the vm profile.",
      "Choose the one channel that may use it:",
      { code: "HOUSECALL_VM_CHANNEL_ID=general" },
      "Start it:",
      { code: "docker compose --profile vm up -d" },
      "Press Check again.",
    ],
  },
};

/** The wizard splits the cards across two steps. */
export const CALL_CARDS: IntegrationId[] = ["calls"];
export const EXTRA_CARDS: IntegrationId[] = ["dj", "gimme", "plex", "giphy", "vm", "transcode"];
/** Features other things depend on: not being ready is a problem. Everything else is optional and only "not set up". */
export const CORE_CARDS: IntegrationId[] = ["calls", "media", "scanner"];
export const ALL_CARDS: IntegrationId[] = ["calls", "media", "scanner", "transcode", "dj", "gimme", "plex", "giphy", "vm"];
