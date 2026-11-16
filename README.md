# CanvasShutter

A photo editor that runs in your browser, with an optional AI assistant you can direct in plain
language.

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
- **Zoom in on the photo** with Cmd/Ctrl + and − (Cmd/Ctrl 0 fits it again) or a trackpad pinch.
  Only the photo is magnified; the rest of the editor stays the same size.
- **AI assistant**: ask for edits in plain language, using your own AI account (optional, off until you connect one).

## Add AI (optional)
Ask for edits in plain language, such as "make this black and white" or "give the other photos the
same look". The assistant is built into the editor. It works in any browser, on a computer or a
phone, and there is nothing to install. You connect your own AI account, and you pay that provider
for what you use.

1. Open the editor and click **Ask AI**.
2. Connect an account, one of two ways:
   - **Sign in with OpenRouter.** [OpenRouter](https://openrouter.ai) gives you Claude and other AI
     models on one pay-as-you-go account. You approve the editor on OpenRouter's own page, where
     you can also set a spending limit, and you are sent back ready to go.
   - **Paste an API key** from [OpenRouter](https://openrouter.ai/keys) or
     [Anthropic](https://platform.claude.com) (Claude).
3. Ask for what you want. The photo changes as the assistant works, and every change can be undone.

Things to try:

- "Look at the open photo and tell me what you'd change."
- "Make this black and white."
- "Too much. Undo that and go half as far."
- "Give the other photos the same look."

**Good to know about cost:** a Claude subscription (Pro or Max) does not include this kind of use;
it needs API credit with OpenRouter or Anthropic. Each request costs a small amount, mostly for the
times the assistant looks at your photo. You can pick a cheaper or a stronger model at the top of
the chat.

**Your key:** it is kept in your browser only and is forgotten when you close the tab, unless you
tick **Stay connected on this device**. **Disconnect** removes it. See [Privacy](#privacy).

### Advanced: use Claude Code instead
If you already use [Claude Code](https://claude.com/claude-code) and would rather use your Claude
subscription, the editor can also be driven from Claude Code through a small bridge program. This
runs on your own computer, so it needs a little setup once:

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
5. Open the editor ([online](https://jeaniususa.github.io/CanvasShutter/) or your own copy, below).
   Click **Ask AI**, then at the bottom of the chat open **Advanced: use Claude Code instead** and tick
   **Let Claude Code control this editor**. The dot turns green when Claude Code is connected.

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
- Photos and adjustments are stored in your browser on your own device. Original photos are never
  modified; edits are settings applied on top.
- CanvasShutter has no server. Its makers never receive your photos, your chat or your AI key.
- The AI assistant is off until you connect an account. When it needs to look at a photo, a small
  preview (about 1000 pixels wide) goes straight from your browser to the AI provider you connected
  (OpenRouter, which passes it to the model you picked, or Anthropic), together with your messages,
  file names and slider settings. That provider's privacy policy applies to it.
- Your AI key stays in your browser. By default it is forgotten when the tab closes. If you choose
  to stay connected, it is kept in this browser on this device, where anyone who uses the same
  browser could use it, and so could a browser extension you have given access to the page.
  A key with a spending limit keeps any damage small, and **Disconnect** removes it.
- The published editor only loads its own code, and its page is only allowed to contact
  OpenRouter, Anthropic and the Claude Code bridge on your own computer.
- The Claude Code bridge is off until you switch it on. It sends the same small preview to
  Anthropic as part of your Claude Code conversation.

If you publish your own copy: every page under one `github.io` address shares the same browser
storage, so another project of yours at that address could read a saved key. A custom domain for
the editor avoids that.

## Good to know
- The editor needs WebGL2, which every current browser has. Very old browsers will show a message instead.
- The AI assistant needs an internet connection and credit with your AI provider. Editing alone needs neither.
- The Claude Code bridge needs Claude Code and Node.js on the same computer as the browser.
- Clearing the browser's website data erases the library. Safari can also clear a site's data by
  itself after about a week without a visit. Use **Back up edits** now and then; with the backup
  file and your original photos you can rebuild everything.
- Files your browser cannot display are skipped and named in a notice. HEIC photos open in Safari but not in Chrome or Firefox.
- The Claude Code bridge works with one Claude Code window at a time.

## Tests
```
cd editor
npx vitest run
```
A hands-on checklist for trying the app in a browser is in [TESTING.md](TESTING.md).

## Licence
MIT. See [LICENSE](LICENSE).
