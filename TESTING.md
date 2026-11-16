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
- [ ] **Zoom**: Cmd/Ctrl + zooms in on the photo only; the panel and buttons stay the same size.
      Cmd/Ctrl − zooms back out, Cmd/Ctrl 0 fits the photo to the window again. A trackpad pinch
      over the photo zooms the photo, not the page. When zoomed in, scroll to move around.
- [ ] Switch to another photo and back. Each keeps its own settings.
- [ ] Reload the page. The same photo is open and every edit is still there.
- [ ] **Export PNG** and **Export JPEG** save a full-size file that matches what is on screen.
- [ ] **Back up edits** saves a `.json` file. Reset a photo, then **Restore edits** brings it back.
- [ ] **Remove photo** asks for a second click, then removes only that photo.

## AI assistant (needs an OpenRouter or Anthropic account with a little credit)
Best tested on the published site (https://jeaniususa.github.io/CanvasShutter/) or with
`npm run build` and `npx vite preview`, because the security rules are only added to the built page.

- [ ] An **Ask AI** button sits at the top right of the photo. Click it: the chat opens.
- [ ] **Sign in with OpenRouter** goes to OpenRouter, asks you to approve, and comes back to the
      editor with the chat open and connected. The address bar no longer shows `?code=`.
- [ ] Disconnect, then paste an OpenRouter key and click **Connect**. It connects.
- [ ] Disconnect, then paste an Anthropic key (`sk-ant-…`). The provider menu switches to
      Anthropic by itself, and it connects.
- [ ] Paste a made-up key. A clear message says the key was not accepted.
- [ ] With a photo open, ask "What would you change?". The assistant looks at the photo and answers.
- [ ] Ask "Make it black and white". The Saturation slider moves and the photo changes. Undo
      brings the colour back.
- [ ] While it is working, the Send button says **Stop**, and pressing it stops the request.
- [ ] Pick another model in the menu at the top of the chat. A note says it starts fresh.
- [ ] Reload the page. Without **Stay connected on this device** you need to connect again; with
      it ticked you stay connected.
- [ ] Typing in the chat does not trigger the editor's shortcuts (typing "o" does not open the
      file picker).
- [ ] **On a phone:** the chat covers the controls but not the photo. When the keyboard opens, the
      chat moves above it and the message box stays visible.

## Claude Code bridge (advanced; needs Claude Code)
1. In `editor-mcp/`: `npm install`, then `npm run build`.
2. Open Claude Code in the project's top folder and approve the `canvasshutter` server.
3. In the editor, click **Ask AI**, then at the bottom of the chat open **Advanced: use Claude Code instead** and tick
   **Let Claude Code control this editor**.

- [ ] The dot next to "Advanced: use Claude Code instead" turns green.
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
