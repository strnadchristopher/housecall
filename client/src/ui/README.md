# Opus-owned presentation boundary

Claude Opus 5.5 owns all visual and interaction design here. Engineering transport, state and hooks stay outside this directory. Read `../../../docs/UI-CONTRACT.md` for the contract and `../../../docs/UI-REQUESTS.md` for the structured data the UI would like next.

## How it plugs in

`App.tsx` renders every screen through `Screen` (`Screen.tsx`). That function dispatches on `props.id` to a designed screen. Unknown ids get a designed generic page, so a new contract screen works before it has bespoke design.

Contract invariants, which the engineering E2E suite relies on:
- Each `Action` is a `<button>` whose accessible name is `action.label`. Visible text may be shorter, but it is always contained in the label.
- Each `Field` is a labelled control with `name = field.name`. Submit emits `{ action: 'submit', values }`, read exactly as the original fixture did.
- Each `Item` is an `li[data-item-id]` whose text content contains `item.text`. Visual parts are layered on with `aria-hidden` decoration and `.cc-sr` text.
- Test ids stay `screen-<id>`.

## Map

| Path | What it holds |
|---|---|
| `tokens/themes.ts` | The only place theme values live: Basalt (default), Moss, Oxblood, Cyanotype (light) and Contrast. |
| `styles/` | Base, controls, app layout grid, chat, pages, stage, onboarding. Every colour is a token. |
| `Shell.tsx`, `Onboarding.tsx`, `chat/`, `screens/` | The designed screens. |
| `contract.tsx` | Form, field, action and page plumbing that keeps the invariants. |
| `parse.ts` | Recovers structure from App's text strings, with a raw-text fallback. |
| `store.ts` | Presentation-only shared state: view, drawer, theme, call dock. |
| `icons/Icon.tsx` | The house icon set: faceted, chamfered, no icon pack. |
| `model.ts` | The proposed rich view model; see UI-REQUESTS R-1. Not used yet. |
| `workbench/` | Design tooling, not shipped in the client bundle. |

### `workbench/`

| File | Use |
|---|---|
| `vite.config.ts` | Port 1520. Every screen and state with fixture props: `?scene=<name>&theme=<id>`. |
| `shots.mjs` | Screenshot runner, writes to `evidence/ui/screens/`. |
| `fixture-api.mjs` | In-memory mock API on 3131. Not the Rust server. |
| `app.vite.config.ts` | The real `App.tsx` on 1521 (dev) or 1522 (preview), against the fixture API. |
| `playwright.ui.config.ts` + `ui.spec.ts` | UI-lane browser tests. |
| `adversarial.mjs` | The persona UX session. |
| `contrast.mjs` | WCAG audit of the theme tokens. |

## Commands (from `client/`)

```sh
npx vite --config src/ui/workbench/vite.config.ts                 # workbench on :1520
node src/ui/workbench/shots.mjs --themes=basalt --scenes=all      # screenshots
npx playwright test -c src/ui/workbench/playwright.ui.config.ts   # UI-lane tests (starts 3131 + 1521)
node src/ui/workbench/contrast.mjs                                # token contrast audit
```
