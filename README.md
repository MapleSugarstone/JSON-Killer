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
| `app.js` | UI and music |
| `life.js` | Background Game of Life |
| `style.css` | Styling |
| `Music.mp3` or `Music.ogg` | Background track. The page tries mp3 first, then ogg |

## Credits

Permission granted by Lemonadey for use of music.

## Support

Donate!!: [ko-fi.com/krazvalt](https://ko-fi.com/krazvalt)

## License

MIT. See `LICENSE`.
