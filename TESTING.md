# Testing CanvasShutter by hand

The automated checks cover installing, building and the unit tests. This checklist covers what
only a person in front of a browser can confirm. It takes about ten minutes.

## Setup
1. Install Node.js 22.12 or newer.
2. In `editor/`: `npm install`, then `npm run dev`. Open http://localhost:5173.

## Editor
- [ ] Drop several photos onto the page. Thumbnails appear in the strip along the bottom.
- [ ] Click a thumbnail. The photo opens the right way up.
- [ ] **Levels**: drag the black, grey and white handles. The photo changes as you drag.
- [ ] Hold Option (Alt on Windows) while dragging the white handle: the photo turns black except
      where it clips. Same key on the black handle: the photo turns white except where it clips.
- [ ] **Light** and **Color**: move each slider. Double-click a slider to reset it.
- [ ] Undo and Redo buttons step through your changes.
- [ ] Hold the **Original** button: the unedited photo shows while held.
- [ ] Switch to another photo and back. Each keeps its own settings.
- [ ] Reload the page. The same photo is open and every edit is still there.
- [ ] **Export PNG** and **Export JPEG** save a full-size file that matches what is on screen.
- [ ] **Back up edits** saves a `.json` file. Reset a photo, then **Restore edits** brings it back.
- [ ] **Remove photo** asks for a second click, then removes only that photo.

## Claude bridge (needs Claude Code)
1. In `editor-mcp/`: `npm install`, then `npm run build`.
2. Open Claude Code in the project's top folder and approve the `canvasshutter` server.
3. In the editor's Claude section, tick **Let Claude Code control this editor**.

- [ ] The dot next to "Claude" turns green.
- [ ] Ask Claude: "What photo is open and what are its settings?" It answers correctly.
- [ ] Ask: "Make this photo black and white." The Saturation slider moves and the photo changes.
- [ ] Ask: "Undo that." The photo returns to colour.
- [ ] Untick the box. Ask for another change: Claude reports that no editor is connected.

## Browsers
Repeat the Editor section in each browser you have. Known difference: HEIC photos open in Safari
but not in Chrome or Firefox.

## Reporting a problem
Note the browser and version, your operating system, what you did, what you expected and what
happened. A screenshot helps.
