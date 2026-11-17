# housecall.chat front door: design and copy notes

Static site, no build step, no JavaScript, no remote requests. Serve `website/` at the domain root.

| Path | What |
|---|---|
| `index.html` | Landing page |
| `privacy.html` | Privacy page. Links point at `/privacy`, so map `/privacy` to this file (or change the two hrefs). |
| `styles.css` | All styles for both pages |
| `assets/fonts/` | Apfel Grotezk Fett, Inria Sans Regular and Bold, copied from `client/src/ui/fonts`, with their OFL licence files |
| `assets/housecall-desktop.png`, `housecall-phone.png` | Copies of `docs/readme/desktop-dark.png` and `phone-chat-dark.png` |
| `assets/icon.svg` | Copy of `docs/readme/icon.svg` (favicon) |

Outbound links go only to `github.com/strnadchristopher/housecall`. `Log in`, the hero door, the "Someone invited you" link and the footer door all go to `/app/`.

## The idea

The app icon is a letter h that is also a house with a lit amber door, and the client's own token file calls its default direction "Doorway". The page is that picture at full size: a house at night, door open, light on the floor. The house is the hero, and the house plus everything in its light is the one link into `/app/`. On hover or keyboard focus the door leaf swings wider and more light reaches the floor. That is the only authored motion besides one small scroll-settle on the phone screenshot. Both are off under `prefers-reduced-motion`, and nothing is ever hidden waiting on an animation.

Below the door you see inside: the real product screenshots from `docs/readme`, shown without any drawn window chrome. They use fixture names (theo, mara, june, felix) and already match the page's black and amber.

## Tokens (for the `/app/` portal to match)

| Token | Value | Use |
|---|---|---|
| `--night` | `#0b0b0b` | Page background. Same black as the icon and the app shell in the screenshots. |
| `--wall` | `#151514` | Raised surface (privacy panel, table stripes, a login card) |
| `--wall-edge` | `#222120` | The surface's own lighter edge: `inset 0 1px 0`, or a 1px outline. Never a contrasting border. |
| `--ink` | `#ededed` | Text; fill of the `Log in` button |
| `--ink-soft` | `#bdb9b1` | Secondary text (about 10:1 on night) |
| `--lamp` / `--lamp-hi` | `#e6a94f` / `#f1bd6c` | Light only: the door, the spill, the single primary action. Hover is `--lamp-hi`. Focus ring is `--lamp-hi`, 3px, offset 3px. |
| `--on-lamp` | `#1f1407` | Text on amber (about 8:1) |
| Display | Apfel Grotezk Fett 700 | Headings, wordmark, button labels |
| Body | Inria Sans 400/700, 17px/1.6 | Everything else. This is the client's own UI face. |
| Shape | `border-radius: 16px 16px 4px 4px` | Round shoulders, square feet, like the door. Buttons, skip link, table head. Panels use a larger top radius with the same 4px feet. |
| Motion | 150ms colour, 320ms door, `cubic-bezier(.2,.8,.2,1)` | State changes are colour shifts. Nothing lifts, scales or grows an underline. |

Patterns: one amber action per view; a second action is an underlined display-weight text link, never an outlined button beside a filled one. No icon tiles, pills, cards with borders, or drop shadows (the one shadow is tight and directional, under the phone screenshot). Touch targets are 44px or taller. Gutter is `clamp(24px, 5vw, 56px)`; content measure 1120px.

A portal login screen in this language: night background, the h mark bare in the top left, one `--wall` panel with door-shaped corners, fields with a `--wall-edge` outline that turns `--ink` on focus, one amber button.

## ui-ux-pro-max search

Ran `search.py "private community chat open source self-hosted landing" --design-system --variance 6 --motion 3 --density 3`.

- Kept: flat style with no shadows or gradients as decoration, a dark base with a gold call to action (which is the brand's own amber), the action in the hero and again at the bottom, 150 to 200ms colour hovers, and its warning against marketing fluff.
- Rejected: the slate-indigo palette (`#020617`, `#0F172A`), Poppins with Open Sans from the Google CDN, the GSAP opacity-from-zero scroll reveal, and the Heroicons or Lucide suggestion. Each conflicts with the brief or with `UIDesignGuidelines.md`.

## Copy

Voice is taken from the README ("for the people you'd actually invite over"): plain, short, no exclamation marks.

- Headline: **Like Discord, on a server you own.** It keeps the social promise and makes the privacy claim structural (who holds the data), which is true for every conversation type. The requested "as private as Telegram" comparison is not supportable: channels, group chats and calls are readable by the host, and there is no outside audit. Evidence that would unlock a stronger line: end-to-end encryption for group conversations and an independent audit report.
- Alternatives: "Your group's Discord, on a server you own." / "A private group chat you host yourself." (the README line).
- "Free and open source" was checked against `LICENSE` (GNU AGPL-3.0).
- Privacy summary on the homepage is four short rows and follows `DM-V1.md` section 14 and the current part of `SECURITY-LEVELS.md`. "End-to-end encrypted" is used only for one-to-one DMs between the apps.
- No testimonials, numbers, awards, prices or download links.

## For the release operator: things to confirm before shipping

1. **Source docs are stale (separate reconciliation, not done here).** `README.md` and `SECURITY.md` still say messages are not end-to-end encrypted, and `DM-V1.md` opens with "Nothing here is built yet". The release operator confirmed the shipped `client/src/crypto/dm.ts` encrypts one-to-one DM text and files (public 984405e equals accepted 277414e). The page states the conditions: both people have security keys and the app has pinned the other person's key. Until the project docs are corrected, the privacy page links to the repository root and not to those documents.
2. **Cross-check the account implementation before enabling signup.** These sentences in `privacy.html` under "Logging in here" describe an implementation that is still being verified: the account stores only an encrypted list of server addresses; it holds no community passwords or messages; login sets one essential secure session cookie; the service sees connection metadata while in use; browser-delivered code means trusting this site. `index.html` has two dependent sentences: the "Someone invited you" paragraph (direct connect needs no account) and the last sentence of `.ways__aside`. Nothing on either page promises zero knowledge or zero metadata; keep it that way.
3. **Hosting paragraph** in `privacy.html` ("This website") reflects the runtime the release operator reported: one VPS, no Cloudflare HTTP proxy, Caddy access logging off, journald in RAM with at most one day of retention configured. It deliberately does not say "we never log". The provider's initial bootstrap journals were not deleted and are not mentioned on the page. Update the paragraph if any of this changes.
4. **"Your devices"** says desktop and phone apps are pre-release with source on GitHub. No download link is offered. Adjust if releases are public.
5. **Name**: the page uses "HouseCall" per the brief; the README and app use "Housecall".
6. **File modes**: `website/` was created `0700`/`0600`; `chmod -R a+rX website` was not permitted in the design session.

Settled: the screenshots byte-match the README fixture images, which a Playwright test seeds with theo, mara, june and felix.

## QA

The release operator rendered desktop 1440x1000 and phone 390x844: no JS errors, no external requests, no horizontal overflow, fonts and images load, links are 44px or taller, the main action is visible at 1280x720 and 390x844, reduced motion resolves to 0s, the skip link works.

One bug came out of that pass and is fixed in `styles.css`: on phones the privacy table's `<caption>` stayed `table-caption` while the table became `block`, so it wrapped in a 46px box. It is now `display: block; width: 100%` in the same media query. The caption element is kept.

Parent rerun after this correction: `check-landing.cjs` exited 0 (`landing-check-04-after-corrections.log`), retaining desktop 1440x1000 and phone 390x844 receipts/screenshots under `landing-visual-01`. The release operator inspected the fresh full phone landing and phone/desktop privacy captures: caption now reads at normal width; longer disclosures and hosting/account text remain contained; no material visible defect. This is static-site acceptance only, not account-service or public deployment acceptance.
