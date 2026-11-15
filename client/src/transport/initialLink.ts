import { takeBrowserLinkFragment } from './deepLinks';
// Imported by main before React, effects, session restore or any request. StrictMode cannot consume it twice.
let initial: string | undefined;
export function captureInitialLink() { initial = takeBrowserLinkFragment(); }
export function takeInitialLink() { const value = initial; initial = undefined; return value; }
