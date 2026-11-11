# Housecall design directions

Three directions ship as switchable token sets in the real app. Default: **A**.
Switch with `?direction=b` or `?direction=c` in the URL (remembered in localStorage); `?direction=a` returns to the default.
Token files: `client/src/ui/tokens/tokens.css` (A), `client/src/ui/tokens/directions/b.css`, `c.css`.
Screenshots: `design/shots/`.

## A. Doorway (default)

- Logo (`a/logo.svg`): a lowercase h whose counter is a lit doorway with the door ajar. The door swings wider when the server picker opens.
- Typeface: Inria Sans (OFL, Black[Foundry]). A humanist sans with cut, slightly calligraphic terminals; warm at chat sizes, two weights only, which forces hierarchy by size and tone.
- Palette: warm charcoal at night, one amber that means "the light is on" (live call, primary action). Light scheme is fired clay, deliberately not cream or kit gray.
- Shape and motion: arch silhouette (flat base, round top) for avatars and the live mark; radii 6/10/18; 110/190/320 ms with a small overshoot on enter, plain ease-in on exit.
- Why default: it is the only direction where logo, colour, avatar shape and the live state are one idea (a lit doorway means someone is home), so the call state reads without words.

## B. Ledger

- Logo (`b/logo.svg`): the double l of the wordmark as two parallel strokes with cut tops.
- Typeface: Martian Grotesk (OFL, Evil Martians), variable, set at 87.5% width. Compact, squared, even vertical metrics that centre cleanly in controls.
- Palette: true-neutral ink and paper, light-first with a matching dark. Green appears only for a live call.
- Shape and motion: square corners (0/2/4), 70/130/210 ms, no overshoot.
- Weaker as default: fastest and most legible, least warm; nothing in it says "home".

## C. Roofline

- Logo (`c/logo.svg`): a roofline over a single dot (someone under a roof).
- Typeface: Apfel Grotezk (OFL, Collletttivo). A grotesque with visible character in the medium and bold cuts.
- Palette: green-black with one terracotta accent; light scheme is pale sage.
- Shape and motion: tight controls (3/7) inside large 24 px panels; 140/260/440 ms with a visible overshoot.
- Weaker as default: the most atmospheric, but terracotta sits close to the danger hue and the slower motion costs speed in a chat app.
