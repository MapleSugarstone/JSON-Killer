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


## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page and documentation |
| `sb3shrink.js` | Zip reader and writer, shrink, verify. No DOM |
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
