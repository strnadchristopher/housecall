# Hosted web app (`housecall.chat/app/`): design handoff

Base: `25e7765`. Source plan: `.hermes/plans/2026-11-17_124837-housecall-webapp.md`. Rules: `UIDesignGuidelines.md`, `website/DESIGN.md` (that file also holds the recorded ui-ux-pro-max run; the skill itself was not reachable from this worktree).

Scope: only the screens a hosted user sees before and around the chat shell. The shell itself (`AppShell`, channels, chat, calls) is unchanged. Everything here reuses existing classes and tokens. New CSS is limited to the three rules marked **new CSS**.

## Decisions

1. **The hosted front door is the client's own onboarding (`.hc-onb`), not the portal page.** Same 448px column, fields, buttons and NavRows as server login. `portal/public/index.html` stops being the `/app/` entry. Its account features move to Settings (see §6).
2. **No Welcome scene on the hosted build.** The user already went through the website's door. `/app/` opens directly on **Log in** with the username field focused. The `House()` SVG stays on self-hosted and native Welcome screens.
3. **Two credential forms, never on screen together.** The HouseCall login screen and the friend's-server screen are separate screens, and each title says who gets the password. This is the main protection against typing a server password into the HouseCall form, or the reverse.
4. **The primary action sits directly under the fields on both login screens** (not pinned to the bottom like other onboarding screens), so **Log in** stays above the phone keyboard.
5. **The friend's-server path is a NavRow, not a second button.** That avoids the filled-plus-outlined button pair, and it reuses the "Request access" row pattern on the server door.
6. **Discovery and empty states live in the stage (`.hc-center`).** They are not modals. The picker gets one more row.
7. **Owner listing is a switch in Server profile.** It is off by default, turns on only after inline confirmation, and is hidden from non-owners (not shown disabled).
8. **Recommended, can be vetoed on its own:** when nothing is stored in `hc-accent`, the hosted build defaults to the existing `amber` accent. It matches the `--lamp` door the user just clicked on the website. The background tokens stay as they are, and the user can still change the accent in Appearance.
9. **Open:** product name casing. The app uses `copy.app.name` = "Housecall"; the website and portal use "HouseCall" (`website/DESIGN.md` item 5). Every string below renders the name through `copy.app.name`. Pick one casing before release and do not mix them on one screen.

## 1. Routes and entry

| URL | Opens |
|---|---|
| `/app/`, `/app/#login`, `/app/#account` (already shipped website links) | Log in |
| `/app/#signup` | Create account |
| `/app/#direct` | Friend's server |
| Valid stored HouseCall session, or a stored server session | Existing `Splash` ("Opening Housecall"), then the shell. No login screen flash. |

Switching modes rewrites the hash with `history.replaceState`, so Back leaves the app and does not toggle between modes.

## 2. Login screen layout (hosted, signed out)

Container: `.hc-onb > .hc-onb__screen`, unchanged. Width `min(100%, 448px)` (400px content and 24px gutters plus safe insets). At 47.51em and wider it is vertically centered (existing rule); below that it is top aligned.

Order, top to bottom (`.hc-onb__form`, 16px gap):

1. `.hc-onb__top` (44px): the existing `<Logo>` as a bare link to `/`, `aria-label="Housecall home"`. No tile or box behind it. Where other screens have Back, this screen has the mark.
2. `.hc-onb__title` → `<h1>`: **Log in to Housecall** / **Create a Housecall account**. 26px (`--hc-text-xl`). There is no subtitle on Log in.
3. `Field` **Username**: `autocomplete="username"`, `autocapitalize="none"`, `spellcheck=false`, `enterkeyhint="next"`, `autofocus`.
4. `Field` **Password**: `autocomplete="current-password"` (Create account uses `"new-password"`, `minlength=12`), `enterkeyhint="go"`.
5. Create account only: `.hc-onb__help` under the password field: **3 to 32 letters, numbers or underscores. There's no password reset, so keep your password somewhere safe.**
6. `ErrorLine` (role=alert). It reserves no height and appears only when there is an error.
7. `.hc-onb__actions` with the **new CSS** modifier `.hc-onb__form--compact .hc-onb__actions { margin-top: 0; }`:
   - `Button kind="primary"` full width, 52px: **Log in** / **Create account**. While busy it keeps its label and gets `aria-busy` (existing kit behavior).
   - `Button kind="text" .hc-onb__quiet`: **New here? Create an account** / **Have an account? Log in**. This switches mode, keeps the typed username and clears the password.
8. 32px gap (`--hc-space-6`), then `ul.hc-navgroup.hc-onb__ask` with one `NavRow`: label **Connect directly to a friend's server**, detail **No Housecall account needed**. This is the existing two-line row (64px, chevron centered).

Measured budget at 390×844 without the keyboard: about 480px tall, so every item, including the friend row, is visible without scrolling.

**New CSS (touch fields):** `@media (pointer: coarse) { .hc-onb .hc-field input { min-height: var(--hc-row-touch); } }`. That makes inputs 48px instead of 36px on phones. The 16px input text already prevents iOS zoom.

Not on this screen: the house scene, a tagline, a callout box, privacy paragraphs, "Before you log in", the portal tab strip, a "Saved servers" header link, or a pre-check of the account service.

### Errors and states (HouseCall account)

| Case | Text, in `ErrorLine` unless noted |
|---|---|
| Wrong username or password (one message for both, never says which) | Wrong username or password. |
| Username taken | That username is taken. |
| Username fails the pattern (client-side, on submit) | Use 3 to 32 letters, numbers or underscores. |
| Password too short | Use 12 or more characters. |
| Rate limited | Too many tries. Wait a minute and try again. |
| Account API unreachable or 5xx | Housecall accounts aren't available right now. You can still connect directly to a friend's server. The friend row stays fully enabled. |
| Session expired on reload (muted `role=status` line, not danger color) | You were logged out. Log in again. |

On success, go straight to the shell (§4). There is no "Welcome" interstitial.

## 3. Friend's server screen (`#direct`)

The same container, plus `.hc-onb__form--compact`.

1. `.hc-onb__top`: Back (`IconButton icon="back"`), which returns to Log in.
2. `<h1>` **Connect to a friend's server**
3. `Field` **Server address**: placeholder `chat.example.com`, `inputmode="url"`, `autocomplete="off"`, `enterkeyhint="next"`, `autofocus`.
4. `Field` **Username**: `name="server-username"`, `autocomplete="section-server username"`.
5. `Field` **Password**: `name="server-password"`, `autocomplete="section-server current-password"`, `enterkeyhint="go"`.
6. `.hc-onb__help`: **Your username and password go only to this server.**
7. `ErrorLine`, with failures from §7.
8. Actions: primary **Log in**, then quiet text button **Have an invite? Join instead**. That button opens the existing `SignUp` screen ("Where are you joining?"), with any typed address carried over.

Submit runs the existing `parseServerInput`, then `checkServer` (busy state on the button), then `signIn` against that origin only. After a success, the host's own name replaces the raw address everywhere. Password managers will still store these credentials under `housecall.chat`. The `section-server` token and distinct `name` values keep them apart from the HouseCall account entry in managers that honor them. Note this browser limitation in release notes.

Guest result: the shell opens on that server with no HouseCall account. That is the same path used when the account API is down.

## 4. Shell entry, empty state, switcher

The shell is unchanged. There are only three additions.

**Empty state** (HouseCall account signed in, zero servers): `.hc-center` shows a block centered in the stage, `max-width: 400px`:
- `<h1>` at `--hc-text-lg`: **No servers yet**
- `ul.hc-navgroup` with two NavRows:
  - **Add server**, detail **Address, invite code or link**
  - **Discover servers**, detail **Public servers you can ask to join**

There is no illustration and no paragraph. The left column shows the picker trigger with the existing `<Logo>`, the HouseCall username as the name, and no status line. The channel list area stays blank. At 47.5em and narrower, the shell opens on the stage (`data-screen="chat"`), so the two rows are the first thing a phone user sees. The menu button still opens the drawer.

**Picker** (`ServerPicker`; its keyboard model, animation and rows are unchanged):
- New footer row after **Add server**: `Icon` + **Discover servers**. It opens §5 in the stage. It shows for everyone, guests included.
- **Create server** stays owner-only, as it is now.
- Each row's `small` status line: **Connected** / **Reconnecting** (existing), plus two new values:
  - **Log in needed**, in muted color. The entry is saved in the encrypted list but this browser has no session (for example on a new device). Picking it opens the existing `SignIn` in adding mode: **Log in to {server}**, username prefilled from the identity hint, **Not you?** available, Back returns to the previous server (`cancelAdd`).
  - **Can't reach**, using the existing `data-state="off"` danger color. Picking it shows the host's failure screen (§7).
- With more than one host, the `{host} · ` prefix already shows. That prefix is the only cross-account cue the picker needs.

**Add server → link** (signed in to HouseCall): the existing picker form, then the existing `SignIn` / `Join` / `Server` door. Directly above the actions on that host's login screen goes one `.hc-check` checkbox, checked by default: **Save to my Housecall list**. On success, the entry is saved after the host has authenticated. The checkbox is hidden for guests.

## 5. Discover (stage view)

Layout: the stage, padded like `.hc-settings__pane` (24px sides), content `max-width: 640px`.

1. Header row: Back (`IconButton`, which returns to the previous stage view; Escape does the same), `<h1>` **Discover servers** at `--hc-text-lg`.
2. `Field type="search"` **Search public servers**: `enterkeyhint="search"`, `autofocus`, queries 300ms after typing stops, Enter searches at once. An empty query shows the default first page.
3. `.hc-onb__help`-style muted line, shown once: **Listed by their owners. Joining still needs an invite or the owner's approval.**
4. Results: `.hc-tiles` > `.hc-tile-row`. Each row has `.hc-tile-row__text` holding a `<strong>` name, a description clamped to 2 lines, and a `<small>` host. Its only action is a text button: **Open**. Rows are not cards. There is no icon tile, no tag chips and no hover lift.
5. Below the list: `Button` **Show more** when there is a next page. After it loads, focus moves to the first new row.

States (all in the list slot, `aria-live="polite"`):

| State | Text |
|---|---|
| Loading | Searching |
| Results | (sr only) {n} servers |
| None | No public servers match {query}. |
| Account API down or error | Search isn't available right now. + text button **Retry** |

**Open** behaves like Add server with the listed HTTPS address: it shows the existing server door (`Server` screen) with one added NavRow, **I already have an account** (existing `C.haveAccount`), which leads to `SignIn`. Search never contacts the listed servers. Only Open does, and only through the existing direct flow.

## 6. Settings additions

**You → Housecall account** (new row in the existing "You" group; hosted build only). It uses the existing settings pane, `hc-stack`.

Signed out (guest):
- `.hc-lede`: **Log in to keep your server list on every device.**
- Primary **Log in**, then text button **Create an account**. Both open §2 with Back. On success they return to this pane.

Signed in:
- `.hc-pair`: **Username** / {name}.
- Heading `h2` **Your server list**, then `.hc-tiles`. Each row shows the server name, a `<small>` with {host}, and actions:
  - Saved: text button **Remove**, styled `.hc-btn--danger-text`. It confirms inline: the row text becomes **Remove {server} from your list? Your account on {host} and its messages stay.** with actions **Remove** (danger-text) and **Cancel**. After removing, a status line reads **Removed. Still logged in to {host} in this browser.** That host's own Sign out (existing) is a separate action.
  - Connected but not saved (for example a guest who then logged in): text button **Save**. This is how an active direct session is linked without typing its password again.
- Buttons, in this order: **Download server list** (with the existing plaintext warning as `.hc-note`), **Import server list** (file input; format 1 accepted).
- `.hc-note`: **There's no password reset. If you forget your password, your saved list can't be recovered.** This replaces the portal's "Before you log in" callout.
- `Button kind="danger"` **Log out of Housecall**. It confirms inline: **Log out of Housecall and every server in this browser?** with **Log out** / **Cancel**. It clears local key material and every host session in the tab, then shows §2. *Flag for review: the plan defines clearing on logout, but not server sessions. Signing out of everything is the safer default on shared computers.*
- At the bottom, inside `<details>` (the existing portal pattern): **Delete Housecall account**. The body text and the "Type DELETE to confirm" form are carried over from the portal unchanged.

**Server → Server profile** (owner only; the section is absent for non-owners and absent on servers without directory support):
- `Field` **Public description**, `maxLength=140`. Shown only here, because the server has no description field today.
- `.hc-switchrow` with `role="switch"`: **List this server publicly**, off by default. Existing servers are never published without action.
- Muted line under it, always visible: **Shows the name, description and address {host} in Housecall search. People still need an invite or your approval to join.**
- Turning the switch on does not change it yet. An inline confirmation appears first: **Publish {server} at {host}?** with **Publish** (primary) and **Cancel**.

| Status (muted `role=status` line under the switch) | Text |
|---|---|
| Verifying | Checking {host} |
| Listed | Listed publicly |
| Verify failed (switch returns to off) | Couldn't verify {host}. It must answer at this public HTTPS address. |
| Unlisting | Removing listing |
| Off | (no line) |

## 7. Connection and HTTPS failures (friend's server, Add server, Open, picker)

Each failure shows in `ErrorLine` under the address field. Where shown, the remediation link is a plain `<a>` to the server's own origin, `rel="noreferrer noopener"`, opened as a top-level navigation. Copy must not guess between causes the browser can't tell apart: a TLS error, a CORS or allow-list block, DNS failure and a refused connection all reach the page as the same network error.

| Detected | Text | Link |
|---|---|---|
| Unparseable input | Server address not recognized (existing) | none |
| `http://` typed | This web app needs an https:// address. | **Open {host} directly** |
| Network error (any of the above) | Couldn't reach {host} from this browser. The server needs a trusted HTTPS certificate and must allow the Housecall web app. | **Open {host} directly** |
| Same, and the host is a private or loopback IP | Couldn't reach {host}. Addresses like this only work on the same network, and still need trusted HTTPS. | **Open {host} directly** |
| Redirect refused (credential requests don't follow redirects) | {host} sent this somewhere else. Enter its final address. | none |
| API too old or incompatible | {host} runs an older Housecall. Log in on its own page instead. | **Open {host} directly** |
| No answer within 15 s | {host} took too long to answer. | text button **Retry** |
| Server rejects credentials | the server's own message (existing passthrough) | none |

After a failure, focus stays in the address field and the typed values are kept. Never fall back to `http://`, a proxy, or a VPS-side fetch. Owner setup (`HOUSECALL_CLIENT_ORIGINS=https://housecall.chat`) is documented in `SELF-HOSTING.md`. It does not belong in this end-user copy.

## 8. 390px and keyboard behavior

- **Viewport:** add `interactive-widget=resizes-content` to the hosted build's viewport meta, so Android Chrome resizes the layout and the compact actions stay above the keyboard. iOS doesn't resize the layout, so the compact order (actions right after the fields) is what keeps **Log in** visible there. When a field gets focus on `pointer: coarse`, call `scrollIntoView({ block: "nearest" })` on the primary button.
- **Enter:** Enter in Username moves to Password (`enterkeyhint="next"`). Enter in Password submits. Enter in the search field searches.
- **Tab order** matches the visual order in §2, §3 and §5. The friend row comes after the mode toggle. Nothing is reachable only by pointer.
- **Focus:** each screen focuses its first field on open. On an error, focus moves to the field at fault, with `aria-describedby` pointing at the `ErrorLine`. After Back, focus goes to the control that opened the screen.
- **Picker:** keeps its existing Up, Down, Home, End, type-ahead and Escape behavior. The new Discover row is part of the roving tabindex.
- **Targets:** 52px buttons, 64px friend row, 48px touch inputs, ≥44px text buttons. These are the existing values plus the touch-field rule.
- **Motion:** the existing `hc-anim-slide-*` screen transition only. Content is never hidden behind an animation, and the existing reduced-motion rules apply.
- **Contrast:** existing tokens only. Error text uses `--hc-danger` on `--hc-bg`; muted states use `--hc-text-muted`.

## 9. Do not

- Run the HouseCall login and a server's login in one form, or send a server credential to `housecall.chat`.
- Store passwords, session tokens or raw keys in browser storage. Sync anything beyond the address and the identity hint.
- Show any recovery or "forgot password" control.
- Add tabs, pills, badges, icon tiles, cards with borders, glows, extra shadows, a second display face, or explanatory paragraphs to the login screens.
- Restyle `AppShell`, `ChannelList`, chat, calls, or the self-hosted and native onboarding.

## 10. Playwright checkpoints for this design (desktop 1280 and 390×844)

`#account` opens Log in with Username focused. The friend row is visible without scrolling at 390. With the keyboard open, **Log in** is visible above the fold. Account API down: login shows the unavailable error and the friend flow still works. Each §7 failure renders its row's text. Empty shell shows the two rows and the stage first on phone. Picker shows **Log in needed** on a fresh browser. Remove keeps server membership. The owner switch requires confirmation and a non-owner has no section. Discover shows its none and error states. No horizontal overflow at 390.
