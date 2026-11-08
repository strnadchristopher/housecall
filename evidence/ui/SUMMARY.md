# Chriscord UI: summary (Opus 5.5 lane, branch `ui`, 2026-11-07)

## What was built

The unstyled contract `Screen` is replaced by designed screens for every contract id:
- **Getting in:** setup, invite, login.
- **Chat:** shell, conversation, composer, search, pins, members, direct messages.
- **Media:** uploads, link preview (`media`), GIFs.
- **Together:** voice, activities, Plex, DJ, Gimme.
- **Account:** notifications, settings, devices.
- **Owner:** invitations, report, reports admin, servers, channels and roles admin.

A designed generic page covers any future id. Desktop and phone layouts are both covered. On phones there is a drawer, a bottom tab bar, a bottom-sheet message action menu and 44px targets.

**Themes.** There are five, all in `client/src/ui/tokens/themes.ts`:
- **Basalt** (default): warm stone and brass;
- **Moss**: green-black;
- **Oxblood**: red-black lacquer;
- **Cyanotype**: light, Prussian ink on sun-printed paper;
- **Contrast**: black, white and signal yellow.

Theme choice lives in Settings and is saved on the device.

**Design world.** "Little obelisk":
- **Signature:** the dusk obelisk scene. The wordmark sits between the sky and the stone, lit from the low left.
- **Typography:** the display face is Gambarino (Fontshare, self-hosted); body text is system-ui.
- **Shape and marks:** a house chamfer cut on primary actions, avatars and the composer; a faceted house icon set with no icon pack; diamond presence and status marks; a brass notch for the current place.

**Engineering code is untouched.** `App.tsx`, hooks, state, transport and data are byte-identical to `sprint` at `ebe92bd`. Where the contract only passes text, `parse.ts` recovers structure, and every gap is written up in `docs/UI-REQUESTS.md`.

## Evidence (all in this directory)

| What | Result | Kind |
|---|---|---|
| `screens/basalt/{desktop,mobile}/*.png` | 52 scenes × 2 viewports: every screen plus loading, empty, error, offline, unavailable and permission states | Workbench fixture props in the same DOM shape as App |
| `screens/{moss,oxblood,cyanotype,contrast}/{desktop,mobile}/*.png` | 12 key scenes × 2 viewports × 4 themes | Workbench fixture props |
| `screens/shots-*.json` | 0 page or console errors across the final 200 shots | Runner log |
| `app/*.png`, `app-e2e.txt`, `app-e2e.json` | **6/6 passed** (desktop 1440×900 and Pixel 7): wrong password; send, mention autocomplete, reply, pin, react, edit, unsend; `/gimme` routing; theme switch and persistence; activity start, play, seek, stop; report and resolve; devices; accessible-name sweep; phone drawer and tabs | Real `App.tsx` against the **in-memory fixture API** (`client/src/ui/workbench/fixture-api.mjs`), not the Rust server |
| `adversarial/REPORT.md`, `adversarial/{before,after}/` | **Before:** 3 of 8 persona tasks failed. **After:** 8 of 8 passed. Five RED findings fixed. | Production-built client (`vite preview`), Pixel 7 emulation, fixture API |
| `client-unit.txt` | Engineering's own unit suite: 16/16 passed with this branch | Vitest |
| `client-build.txt` | `npm run build` (tsc + vite) succeeds | Build |
| `contrast.txt` | WCAG token audit: 14 pairs × 5 themes, **0 failing** after three token fixes | Computed |

## What this does not prove

- **Engineering E2E not run here.** I did not run engineering's E2E suite (`client/tests/e2e/*.spec.ts`) against this branch. It needs a compiled `chriscord-server`. In this session that native build could not be launched under the mandatory heavy-build lock without an interactive approval, so I did not build it.
  - The UI keeps every selector those tests use: test ids, accessible names, labels and `li` text. The UI-lane suite exercises the same selector style.
  - **Noah should run** `npm run e2e` (and the voice, Plex and report variants) on this branch before merging.
- **No native or real-backend runs.** Nothing ran on a native device, in Tauri/WebKit, or against real voice, Plex or DJ media. Phone results are Chromium emulation. Call tiles in the screenshots are labelled canvas fixtures.
- **Fixture data.** Workbench and fixture-API content is made up, and it is labelled as fixture where it appears.

## Design-law re-check (point by point, done before handoff)

**Re-checked and clear:**
- **Type and icons:** no Lucide or icon pack; no Inter, Space Grotesk, Fraunces or other listed fonts; mono only for genuine data (IDs, logs, invite link, code).
- **Colour:** no purple or blue-purple anywhere. A violet avatar hue was removed, and poster hues avoid violet. No glow, halo, cut-off glow or radial bloom: the scene's light is a directional dusk band.
- **Surfaces and controls:** no pill eyebrows, no hover boop or lift, no underline animations, no sun-moon toggle (themes are live preview cards), and no icon-in-a-tile.
- **Motion:** no content hidden behind entrance animations. Motion is star twinkle, a pyramidion glint, a slow dusk band, equaliser bars and sliding thumbs, all gated by reduced-motion.
- **Shadows and edges:** shadows are tight and directional; edges are self-coloured inset strokes.

**Fixed during this pass:**
- **Padding:** recovered resets were zeroing button padding.
- **Composition:** the onboarding tablet collided with the wordmark; the username was truncated; the picker column overflowed; posters were monotonous.
- **Colour:** saturated red Revoke buttons were softened, and light-theme avatar chroma was cut.
- **Copy:** ornamental smart quotes were removed.
- **Accessibility:** four contrast pairs were raised to AA.
- **Touch:** the message actions on phones were rebuilt as a bottom sheet.

**Known, outside UI control:**
- em dashes in engineering-supplied status strings (UI-REQUESTS R-3);
- the contract's raw command form for activities, kept and contained as a "Control desk" (R-6).

## Commits for Noah to integrate (branch `ui`)

- `d3ca2ad`: the recovered partial UI, preserved exactly as found.
- `a909f82`: merge of `sprint` (`ebe92bd`) into `ui`; no conflicts, nothing deleted.
- `d3bd642`: the designed UI, themes and workbench.
- The final commit on `ui` (after this file): adversarial fixes, contrast fixes, docs and evidence. See `git log ui`.

Merging `ui` into `sprint` touches only:
- `client/src/ui/**`;
- `docs/UI-REQUESTS.md`;
- `evidence/ui/**`;
- an appended section of `PROGRESS.md`.

The recovered empty `.dockerignore`, `.env.example` and `.df.txt` are preserved in the recovery run directory (`collisions/NOTE.md`). They were empty, so the sprint versions win.
