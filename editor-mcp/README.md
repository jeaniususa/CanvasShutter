# CanvasShutter: Claude bridge

Lets you tell the photo editor what to do in plain language from Claude Code, for example
"warm this up a little and lift the shadows" or "give all of these the same look".

## How it works
```
You type in Claude Code  ->  Claude picks actions  ->  this program (started by Claude Code)
                                                          |  local connection, this computer only
                                                          v
                                               the editor tab in your browser
```
A web page cannot be reached from outside the browser, so this small program sits in between.
Claude Code starts it automatically; the editor tab connects to it when you switch the link on.

## Using it
1. Build this program once: `cd editor-mcp && npm install && npm run build`
2. Start the editor: `cd editor && npm run dev`, then open http://localhost:5173
3. In the editor's **Claude** section, tick **Let Claude Code control this editor**.
   The dot turns green when it is connected.
4. In Claude Code (opened in this project folder), just ask. The first time, Claude Code asks you
   to approve the `canvasshutter` server.

Things to try:
- "Look at the photo that's open and tell me what you'd change."
- "Warm it up slightly and recover the highlights."
- "Too much. Undo that and go half as far."
- "Apply the same white balance to all the photos."
- "Export this one as a JPEG."

## What Claude can do
| Action | What it does |
|---|---|
| `editor_status` | Connection, open photo, current settings, list of controls and ranges |
| `get_adjustments` | Current Levels, Light and Color settings |
| `set_adjustments` | Set sliders or levels, or nudge them from where they are |
| `reset_adjustments` | Reset everything or one section |
| `undo`, `redo` | Step through the open photo's history |
| `get_preview` | A picture of the open photo as edited, for Claude to look at |
| `get_histogram` | Brightness and clipping numbers per channel |
| `list_photos`, `open_photo` | See the library and switch photos |
| `apply_adjustments_to_photos` | Apply one change to several photos |
| `export_photo` | Export the open photo; the browser saves it to Downloads |

## Privacy and safety
- The link is **off until you tick the box**, and unticking it cuts Claude off immediately.
- Your original photos are never changed. Claude changes settings, exactly as dragging a slider
  does, and you can undo with Cmd+Z.
- When Claude looks at a photo, a small preview (about 1000 pixels wide) is sent to Anthropic as
  part of your conversation, the same as pasting an image into Claude. Histogram numbers and file
  names are sent too. Nothing is sent unless Claude asks for it during a request you made.
- The connection only accepts the editor's own page, and only from this computer.

## Settings (optional environment variables)
| Variable | Default | Purpose |
|---|---|---|
| `EDITOR_URL` | `http://localhost:5173` | Where the editor is served; also the page allowed to connect |
| `EDITOR_ORIGINS` | none | Extra allowed page addresses, comma-separated |
| `EDITOR_BRIDGE_PORT` | `8765` | Local port the editor connects to. If you change it, build or run the editor with `VITE_BRIDGE_PORT` set to the same number |

## Limits
- The editor tab must be open and Claude Code running.
- One Claude Code window at a time: a second copy cannot open the same port.
- Changing many photos opens each one in turn, so it takes about a second per photo.
- The preview is taken from the photo as shown on screen, so its size follows your window.
- `.mcp.json` in the project root uses a path relative to that folder, so Claude Code must be
  opened in the project root.
