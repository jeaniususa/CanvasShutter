# CanvasShutter

A photo editor that runs in your browser, with an optional bridge that lets you direct it in plain
language from Claude Code.

### [Open CanvasShutter](https://jeaniususa.github.io/CanvasShutter/)

Nothing to install, no account. Click the link, drop in your photos and start editing.

Your photos stay on your computer. Editing happens on your own computer's graphics chip, inside the
browser; nothing is uploaded to a server.

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

## Add Claude (optional)
Ask for edits in plain language, such as "make this black and white" or "give the other photos the
same look". This part runs on your own computer, so it needs a little setup once:

1. Install [Node.js](https://nodejs.org) 22.12 or newer and
   [Claude Code](https://claude.com/claude-code).
2. Download this project (green **Code** button, then **Download ZIP**, and unzip it), or clone it.
3. In a terminal, inside the project folder, build the bridge:
   ```
   cd editor-mcp
   npm install
   npm run build
   ```
4. Open Claude Code in the project folder (not inside `editor-mcp`). It reads `.mcp.json` and asks
   you to approve the `canvasshutter` server.
5. Open the editor ([online](https://jeaniususa.github.io/CanvasShutter/) or your own copy, below)
   and tick **Let Claude Code control this editor** in its Claude section. The dot turns on when
   Claude is connected.

Then ask things like:

- "Look at the open photo and tell me what you'd change."
- "Make this black and white."
- "Give the other photos the same look."

**Browsers:** with the online editor, Chrome and Edge may ask once whether the page may connect to
apps on this computer; choose Allow. Firefox works as is. If the dot never turns on in your
browser (Safari is the most likely to block it), use the online editor in Chrome, or run your own
copy as below, which works in every browser.

Details, the full list of actions and settings are in [editor-mcp/README.md](editor-mcp/README.md).

## Run your own copy (for developers)
You need [Node.js](https://nodejs.org) 22.12 or newer.

```
cd editor
npm install
npm run dev
```

Open http://localhost:5173. Always open it at the same address: the library is stored per address,
so a different one will look empty. For the same reason, photos added to the online editor do not
appear in your own copy; move edits between them with **Back up edits** and restore.

Every push to `main` rebuilds the online editor through GitHub Actions
(`.github/workflows/pages.yml`).

## Privacy
- Photos and adjustments are stored in your browser on your own computer.
- The Claude bridge is off until you switch it on. When Claude is asked to look at a photo, a small
  preview (about 1000 pixels wide) is sent to Anthropic as part of your conversation.
- Original photos are never modified. Edits are settings applied on top.

## Good to know
- The editor needs WebGL2, which every current browser has. Very old browsers will show a message instead.
- The Claude bridge needs Claude Code and Node.js on the same computer as the browser. Editing alone needs neither.
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
