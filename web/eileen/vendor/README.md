# Team effects snapshot

`effects.js` is an unmodified copy of Varnika's effects module from
`prakhar2000/FIreDrillAR`, main commit `e906701eaff4fe0c4c14329f89e43aba499a13e7`.
The matching `web/public/textures/flames.png` and `web/public/sounds/fire.mp3`
are included from the same commit. The module credits the flame flipbook to Unity
Labs (CC0); retain those credits when updating the snapshot.

Eileen's adapter in `web/src/eileen-effects.js` integrates the public FireSystem and
Smoke APIs without replacing the team's main.js or effects.js. Update the snapshot
deliberately when the team's effects API changes. Do not edit this copy to add
Eileen-specific UI, transport or coordinate logic.
