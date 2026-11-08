These failure screenshots come from intermediate "after" runs. They were superseded by the final run recorded in `../session.json` (8/8 tasks ok).

Two causes:
1. The sheet-body flex sizing bug. It was fixed in `base.css` (`.cc-sheet__body { flex: 1 1 auto }`).
2. The fixture API kept state between runs, which duplicated message text and the running activity. The script now uses per-run unique text.
