# Adversarial UX re-run after UI part 1 (theme, full screen, drawer, settings tree)

Same persona (Linda, 61) and tasks as [the baseline](adversarial-mobile-baseline.md), same candidate setup
(local `housecall-server` + Vite, synthetic accounts), 390×844, touch, dark scheme.
Re-run with `node tests/run-linda.mjs mobile-after-part1/linda` from `client/`. Raw log:
[`mobile-after-part1/linda/result.md`](mobile-after-part1/linda/result.md). No console errors.

| Task | Taps before | Taps after |
|---|---|---|
| Find the main chat and post | 3 | 2 (tap the box, tap send) |
| Come back next day and post | 4 | 3 (sign-in tap, box, send) |
| Leave settings | 1, landed on the list | 2 (one per level), lands in the chat |

## Baseline findings

| # | Finding | Status |
|---|---|---|
| 1 | Opens on the list instead of a chat | **Fixed.** Phones open on the conversation; first open picks the server's general chat |
| 2 | Rows don't look tappable | **Fixed.** 52 px rows with a surface and a chevron; the current one is bold in the accent |
| 3 | Top-left arrow "goes back" to a menu | **Fixed.** Menu button and a slide-out drawer (scrim, Escape, drag or flick to close; focus handled) |
| 4 | Settings is a wrapping row of words | **Fixed.** iOS-style tree: grouped rows (You / server / Help) drilling into each section |
| 5 | Leaving settings lands on the list | **Fixed.** Back from a section returns to the Settings root; Back on the root returns to the chat |
| 6 | No colour choice, amber tint | **Fixed.** Cool blue night, lavender default, Appearance with six accents per device |
| 7 | Band under the iPhone status bar | **Fixed in the web layer**, proven with a simulated 47/34 px notch. Real-device proof is Maya's (Task 2.4) |
| 8 | "Display name" on Join vs "Username" on sign-in | Open, part 2 (Task 5.4, onboarding) |
| 9 | Join doesn't say what she's joining | Open, part 2 (Task 5.4) |
| 10 | Password again the next day | Open, core lane (Addendum A Phase K) |
| 11 | Two different settings entries | **Fixed on phones.** Both open the Settings root |
| 12 | Members can't invite and aren't told why | Open, **unplanned**, reported in the baseline |

## New findings from this run

| Finding | Severity | Status |
|---|---|---|
| Phone settings showed an 8 px strip of page colour on the right edge (also in the baseline) | minor | Fixed (`.hc-center:last-child` margin beat the phone reset) |
| Light scheme: the current drawer row turned a flat neutral grey that read as disabled | minor | Fixed (current row sinks into the page tone) |
| The empty space under the six swatches on a phone | noise | Short pages are normal in a settings tree; nothing to add that is not filler |

No material finding introduced by this part is open.
