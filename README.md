# JSON Killer

JSON reduction for Scratch games. Shrinks `project.json` inside an
`.sb3` without changing behaviour. Helps for projects exceeding the 5MB limit on
Scratch.mit.edu

## Use

Open the page, drop an `.sb3` in, download the result.


## Method

- Drops `"topLevel":false`, `"shadow":false`, `"next":null`. Every scratch-vm
  reader is a truthy test or null safe.
- Drops empty `"inputs":{}` and `"fields":{}`. The deserializer walks both with
  `for..in`.
- Drops the trailing null id from field arrays, read behind `if (fieldId)`.
- Drops costume `md5ext` when it equals `assetId + "." + dataFormat`, which
  scratch-vm rebuilds. Sound `md5ext` stays, no fallback there.
- Drops `bitmapResolution` from svg costumes that carry the default 1. The
  vector load path never reads it, and `updateSvg` writes it back.
- Rounds rotation centre floats to 3dp.
- Deletes orphaned blocks, reachable from no top level script.
- Keeps `"parent":null`, which `getTopLevelScript` requires.

Output is verified against the input block by block before download. Any
mismatch aborts. If you have an error, please contact me.


## Simplifying svgs

Optional, off by default, and it does not shrink the json. It rewrites svg
costumes with fewer vertices, which is what a complex costume costs at the
moment it appears on screen: scratch-render tessellates every one of them first.

- A run of curves is refitted as the fewest curves that draw the same line. A
  stroke drawn by hand is one cubic per mouse sample.
- Flat curves become lines, straight runs are thinned by Douglas-Peucker,
  coordinates are rounded to a fiftieth of a stage pixel, and path data is
  rewritten in the shorter of absolute and relative per command.
- Strength is a slider: how far a vertex may move, in stage pixels, 0 to 6.
  A costume that fails the check at the chosen strength is retried gentler
  rather than left alone, so nothing is skipped for being too ambitious. On a
  test project the default 0.5 removes 35% of vertices and 3 removes 56%.
- "Also delete parts of SVGs that aren't visible" is on by default. Each shape is
  removed, the costume redrawn, and it only stays removed if every pixel
  matched, so a gradient or a partly transparent fill needs no special case:
  what is under one shows through and is seen to still matter. Only shapes
  hidden behind other shapes go: the shape above keeps drawing the same pixels,
  so looks and collision both survive. A shape that draws nothing at all, like
  an invisible hitbox, stays. Untick it and simplifying only runs on costumes
  carrying more than 400 vertices.
- The costume box is remeasured after every edit. Scratch sizes a costume by the
  geometry that is present, not the geometry that shows, so an invisible shape
  can be holding the box open, and that one stays.
- Every costume is drawn once more at the end and compared with the original.
  Anything that does not come back is handed back untouched and listed.


## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page and documentation |
| `sb3shrink.js` | Zip reader and writer, shrink, verify. No DOM |
| `svgopt.js` | Optional svg simplify and cull pass. Needs the DOM |
| `rasterize.js` | Optional svg to png pass, md5. Needs the DOM |
| `soundconv.js` | Optional sound to mono mp3 pass. Needs the DOM |
| `lame.min.js` | lamejs, vendored unmodified. Fetched only when sounds are converted |
| `app.js` | UI and music |
| `life.js` | Background Game of Life |
| `style.css` | Styling |
| `Music.mp3` | Track by Lemonadey. |

## Credits

Permission granted by Lemonadey for use of music.

Mp3 encoding is [LAME](https://lame.sourceforge.net) by way of
[lamejs](https://github.com/zhuker/lamejs), kept unmodified in `lame.min.js` and
used under the LGPL. See `LICENSE.lamejs`. It is a separate file and replacing it
replaces the encoder; nothing else here is derived from it.

## Support

Donate!!: [ko-fi.com/krazvalt](https://ko-fi.com/krazvalt)

## License

MIT. See `LICENSE`.
