# Pegman sprites

Original Google Maps sprite sheets, downloaded from Google's public asset host:

- https://maps.gstatic.com/tactile/pegman_v3/default/runway-2x.png
- https://maps.gstatic.com/tactile/pegman_v3/default/dangling-2x.png
- https://maps.gstatic.com/tactile/pegman_v3/default/dropping-2x.png
- https://maps.gstatic.com/tactile/runway/pegman-fuzz-2x.png

These are Google's artwork. Kept locally to avoid a network dependency during
dragging, and displayed at half their pixel dimensions for high-density screens.

`runway`: four 28×30 CSS-pixel frames (highlighted, standing, empty, tilted).
`dangling`: seventeen 75×75 directional frames, upright at index 8; index 17
contains the target shadow. `dropping`: five 75×75 landing poses.
`pegman-fuzz`: 49×49 ground marker, underneath a dotted search circle.

The drag physics and tile-selection behavior are implemented by this application;
they are not Google's Maps JavaScript implementation.
