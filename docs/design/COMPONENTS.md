# Components

Tokens only: colour, size, radius, motion and the initial-letter face come from `client/src/ui/tokens/`. Strings come from `copy.ts`.

## Kit (`ui/kit.tsx`)

| Component | Notes |
|---|---|
| `Icon` | 20 unit stroke icons, decorative (`aria-hidden`); `off` draws a slash |
| `IconButton` | Icon only; `label` is the accessible name and the tooltip. 44 px on phones |
| `Button` | `kind`: plain, primary, danger, text. `busy` sets `aria-busy` |
| `Field` | Label plus input; `hideLabel` keeps the name for assistive tech |
| `Avatar` | Initial in a doorway arch, six tones; initials use `--hc-font-initial` so "O" is not a zero. Decorative |
| `ErrorLine` | `role="alert"`, optional dismiss |
| `brand/Logo` | The mark of the active direction. Named (`role="img"`) unless `label=""`, then hidden |

## Shell

| Component | Notes |
|---|---|
| `AppShell` | Three columns, two with a sheet, or phone stack; owns `Nav` state and Escape |
| `ServerPicker` | Listbox with arrows, Home, End, type-ahead, Escape; focus returns to the trigger |
| `ChannelList`, `UserBar` | Conversations with counts; user name, state, direct messages and settings |
| `CallDock` | Name of the call, count, and `CallControls`; opens the call's conversation |

## Conversation

| Component | Notes |
|---|---|
| `MessageList` | One tab stop (roving tabindex on the newest row); Up, Down, Home, End move between rows; "Skip to message box" appears on focus |
| `Message` | Row with day label when a new day starts. Enter enters its toolbar, Escape leaves it. Toolbar is hover, focus or tap on phones |
| `EmojiPicker` | Group of plain buttons; takes focus on open, Escape closes and returns focus |
| `Composer` | Attach, text, emoji, GIF, send. Focus ring on the whole row; height follows text (native `field-sizing`, script fallback) |
| `CallBar` | Idle (Join), live (people, duration, controls), elsewhere (where, controls, Switch call) |
| `CallControls` | Mute, deafen (also closes the microphone, restored on undeafen), camera, share, leave |

## Right column and Chords

| Component | Notes |
|---|---|
| `RightPanel` | WAI-ARIA tabs (arrow keys, roving tabindex, `aria-controls`) when more than one tab; otherwise a plain People heading |
| `PeopleTab`, `ChordsTab`, `SearchPanel` | Lists; Chords lists only configured Chords |
| `GimmePanel`, `StevePanel`, `SharedBrowserPanel`, `SessionControls` | Chord panels. Server enums (browser phase, reset outcome) map through `copy.ts`; "Check reset" only with the capability |
