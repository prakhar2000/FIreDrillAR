---
message: "FireDrill AR turns any real room into a fire drill you can see, hear and feel."
audience: hackathon judges
mode: autonomous
duration: 90
canvas: 1920x1080
---

Monolithic `index.html` (one timeline); scenes are root-level clips. Footage: `assets/*.mp4` from `capture/record.cjs`.
Palette: bg #120f0d, fg #f4eee8, accent fire #ff6a2b; exit green #34e07c only where the app shows an EXIT.
Type: Oswald 700 (headlines), Montserrat 400/700 (body), IBM Plex Mono (labels).

## Frame 1 — Problem (0–9 s)
status: animated · src: index.html#s1 · rules: kinetic-beat-slam, depth-of-field-blur
Three short lines slam in over a blurred, dimmed fire clip: drills are boring, nobody practises a smoky room.

## Frame 2 — Title (9–13 s)
status: animated · src: index.html#s2 · rules: chromatic-glitch (snap-in only), kinetic-beat-slam
FIREDRILL AR wordmark + tagline.

## Frame 3 — Scan (13–22 s)
status: animated · src: index.html#s3 · rules: multi-phase-camera (slow push on the footage)
`01-scan-orbit` full-bleed, STEP 1 chip, scan readout.

## Frame 4 — Ignite + spread (22–36 s)
status: animated · src: index.html#s4 · rules: discrete-text-sequence (voice line), multi-phase-camera
`02-ignite` then `03-spread`; "Pinch or say 'fire'" card; smoke drops caption.

## Frame 5 — Signs + route (36–43 s)
status: animated · src: index.html#s5 · rules: stat-bars-and-fills (route legend)
`04-signs-route`; EXIT / BLOCKED / route legend.

## Frame 6 — Voice coach (43–55 s)
status: animated · src: index.html#s6 · rules: discrete-text-sequence, asr-keyword-glow
`05-pov-escape`; Claude reply typed into a coach card with waveform.

## Frame 7 — Feel it (55–68 s)
status: animated · src: index.html#s7 · rules: stat-bars-and-fills, split-tilt-cards (split frame)
`07-crouch` left; wrist-Dots diagram right: warm on the fire side → buzz in smoke → cool at exit.

## Frame 8 — Review (68–78 s)
status: animated · src: index.html#s8 · rules: counting-dynamic-scale
`06-review` left; escape time / oxygen left / time in smoke count up.

## Frame 9 — Close (78–90 s)
status: animated · src: index.html#s9 · rules: kinetic-beat-slam
Closing line, team, tech, credits.
