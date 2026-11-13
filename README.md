# CanvasShutter

A photo editor that runs in your browser, with a bridge that lets you direct it in plain language
from Claude Code.

Your photos stay on your computer. Nothing is uploaded to a server, and there are no accounts.

## Features
- **Levels** with black, midtone and white handles per channel (RGB, Red, Green, Blue), an Auto
  button, and a clipping view: hold Option/Alt while dragging the white or black handle to see
  only what is clipping.
- **Light**: Exposure, Contrast, Highlights, Shadows, Whites, Blacks. The five tone sliders share
  one response, so they cannot fight each other.
- **Color**: Temp, Tint, Vibrance, Saturation.
- **Photo library**: add many photos at once; each keeps its own adjustments, saved automatically
  in the browser. A filmstrip switches between them.
- **Backup** of all adjustments to one small file, and restore from it.
- **Export** to PNG or JPEG at full size.
- **Undo and redo**, a hold-to-compare original view, and live histograms.
- **Claude bridge**: ask for edits in plain language from Claude Code (optional, off by default).

## Run it
You need [Node.js](https://nodejs.org) 22.12 or newer and a current browser (Chrome, Safari, Firefox or Edge).

```
cd editor
npm install
npm run dev
```

Open http://localhost:5173 and drop in some photos. Always open the editor at the same address:
the library is stored per address, so a different one will look empty.

## Talk to it with Claude Code
```
cd editor-mcp
npm install
npm run build
```

Then open Claude Code in this folder (it reads `.mcp.json` and asks you to approve the
`canvasshutter` server), start the editor, and tick **Let Claude Code control this editor** in the
editor's Claude section. After that you can ask things like:

- "Look at the open photo and tell me what you'd change."
- "Make this black and white."
- "Give the other photos the same look."

Details, the full list of actions and settings are in [editor-mcp/README.md](editor-mcp/README.md).

## Privacy
- Photos and adjustments are stored in your browser on your own computer.
- The Claude bridge is off until you switch it on. When Claude is asked to look at a photo, a small
  preview (about 1000 pixels wide) is sent to Anthropic as part of your conversation.
- Original photos are never modified. Edits are settings applied on top.

## Good to know
- The editor needs WebGL2, which every current browser has. Very old browsers will show a message instead.
- The Claude bridge needs Claude Code and Node.js on the same computer as the browser.
- Clearing the browser's website data erases the library. Safari can also clear a site's data by
  itself after about a week without a visit. Use **Back up edits** now and then; with the backup
  file and your original photos you can rebuild everything.
- Files your browser cannot display are skipped and named in a notice. HEIC photos open in Safari but not in Chrome or Firefox.
- The bridge works with one Claude Code window at a time.

## Tests
```
cd editor
npx vitest run
```
A hands-on checklist for trying the app in a browser is in [TESTING.md](TESTING.md).

## Licence
MIT. See [LICENSE](LICENSE).
