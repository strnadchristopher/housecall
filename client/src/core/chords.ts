/**
 * ChordRegistry: the Chords the server reports as configured, and the shared
 * session (watch, music, browser) of the current conversation. A Chord that
 * is not configured never appears in `chords`.
 */
import type { RequestCard } from "./chat";

export type ChordId = "gimme" | "steve" | "browser";

export interface ChordEntry {
  id: ChordId;
  /** True while this Chord has a session running in the current conversation. */
  active: boolean;
}

export interface QueueItem {
  id: string;
  title: string;
  requestedBy: string;
  current: boolean;
}

export interface SharedSession {
  kind: "watch" | "music" | "browser";
  playing: boolean;
  positionMs: number;
  durationMs?: number;
  hasMedia: boolean;
  hostId: string;
  hostName: string;
  isHost: boolean;
  queue: QueueItem[];
  votedSkip: boolean;
}

export interface Library {
  id: string;
  title: string;
}

export interface LibraryItem {
  id: string;
  title: string;
  kind: string;
}

export interface Song {
  index: number;
  title: string;
  seconds: number;
}

export interface BrowserState {
  phase: string;
  canStop: boolean;
  streams: MediaStream[];
  /** Outcome of the last reset the server remembers, if any. */
  resetOutcome?: string;
}

export interface ChordState {
  chords: ChordEntry[];
  /** Shared playback is heard and seen only by people in the call. */
  inCall: boolean;
  session?: SharedSession;
  error: string;
  gimme: { canRequest: boolean; canWatch: boolean; requests: RequestCard[]; libraries: Library[]; items: LibraryItem[]; subtitles: boolean; player?: string };
  steve: { results: Song[]; player?: string };
  browser?: BrowserState;
}

export interface ChordRegistry extends ChordState {
  request(title: string, media: "movie" | "tv"): Promise<void>;
  startWatch(): Promise<void>;
  loadLibraries(): Promise<void>;
  openLibrary(id: string): Promise<void>;
  watch(itemId: string): Promise<void>;
  toggleSubtitles(): void;
  /** Binds the shared film to a player element; returns a disposer. */
  bindWatch(element: HTMLVideoElement): () => void;
  startMusic(): Promise<void>;
  searchSongs(query: string): Promise<void>;
  queueSong(index: number): Promise<void>;
  voteSkip(): Promise<void>;
  bindMusic(element: HTMLAudioElement): () => void;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  handOff(personId: string): Promise<void>;
  stop(): Promise<void>;
  stopBrowser(): Promise<void>;
  checkBrowserReset(): Promise<void>;
}
