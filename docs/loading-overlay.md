# The loading overlay

Whenever the page cannot take input because something is loading, a progress
bar in the middle of the screen says what, and how far it has got
(`src/app/busy.ts`). It covers the page, which is made `inert`, so nothing
can be clicked or typed until it is done. A task of known progress shows a
filling bar and its percentage; one of unknown progress, a bar moving to and
fro. Tasks over in less than a quarter of a second show nothing (input is
still held), except work that holds the browser's main thread, which shows the
overlay at once and waits for it to be drawn before starting.

Where it appears:

| What is loading                                                                                                                                                                                              | Progress                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| A bundled battlefield fetched on a first visit (docs/bundled-battlefields.md)                                                                                                                                | The download                                                                                                         |
| A battlefield opened or previewed: read back, or its terrain prepared on its first opening                                                                                                                   | The terrain preparation, band by band (`authoritativeTerrain`)                                                       |
| The 3D view, on the battle page and in the terrain preview, until it is all in: the ground, buildings and roads, trees, the ground's textures, the finest ground tiles near the camera, the soldiers' models | Each part as it arrives, and between them the time the last 3D view took in this browser (`src/app/view-loading.ts`) |
| A battle starting (its worker preparing the battlefield before the first tick)                                                                                                                               | Unknown                                                                                                              |
| A battle ended, until the review is open                                                                                                                                                                     | Unknown                                                                                                              |

Loading a scenario whose battlefield must be generated again already shows a
dialog (with Cancel): it now has the same progress bar, from the generation's
steps (`generationFraction`). Generating a new battlefield from terrain
selection does not block the page (it can be cancelled, and other battlefields
browsed meanwhile), so it keeps its step list instead.
