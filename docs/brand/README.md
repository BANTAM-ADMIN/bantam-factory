# BANTAM brand mark

`bantam-mark.svg` — a bantam cock in profile: full comb, wattle, tail up.
Single colour (`#e8a33d` amber on the dark ground; it inherits `currentColor`
in the inlined copy on the fight board), with knockouts in the background
colour for the eye and the two quill separations in the tail.

It is **generated**, not hand-drawn: `build-mark.py` integrates each tail
feather as an arc — angle, length, width taper and curl — and emits it as a
sampled polygon, so the geometry is what was computed rather than what a bezier
guessed. Earlier hand-authored attempts all failed the same way, reading as a
round chick with a small fin, because the two things that actually say *rooster*
were undersized: a tail as large as the body, and a serrated comb.

Checked at 96 / 56 / 34 / 20 px and knocked out on an amber ground before
shipping. The inlined copy lives in `bin/fight-replay.template.html`; the fight
board's browser-tab icon is a separate emoji favicon (🥊) and is unrelated.
