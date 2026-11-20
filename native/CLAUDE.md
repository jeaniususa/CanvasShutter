# CanvasShutter native (Rust)

The desktop rewrite of CanvasShutter. The web editor in `../editor` stays live
and is the reference for how every adjustment must look until this reaches parity.

Follow the guidelines in the repo's root `CLAUDE.md` as well.

## Who you're working with
Jean is the product owner and tester and is new to Rust. Explain Rust-specific
choices in a sentence of plain English when they come up. Prefer simple,
readable code over clever code.

## Run it
```
cargo run            # open the app
cargo test           # unit tests
cargo fmt            # format
cargo clippy --all-targets -- -D warnings
```

## Layout
- `apps/canvasshutter` – the app: egui window, panels, wgpu drawing (`photo.wgsl`).
- `crates/cs-io` – reading photos from disk (JPEG, PNG).
- Add new crates only when a sprint needs them. The planned split is
  `cs-core` (edit recipes, undo; no UI or GPU code), `cs-gpu` (wgpu passes),
  `cs-io` (decode/encode), `cs-catalog` (SQLite library), `cs-ai`.

## Rules
- UI: egui/eframe. GPU: wgpu with WGSL shaders, drawn through
  `egui_wgpu::Callback`.
- Licences: no GPL dependencies, ever. LGPL only behind a Cargo feature with a
  `deny.toml` exception. CI runs `cargo deny check licenses`.
- No `unwrap()`/`expect()` on anything that comes from the user (files, input,
  network). They're fine for programmer errors at start-up.
- Never block the UI thread on file or network work.
- Pixel work must match the web editor: oracle tests compare Rust output with
  reference PNGs exported from `../editor` (±1/255) once Sprint 3 adds them.
- Must work with no network connection.

## Definition of Done
fmt, clippy, test and the licence check pass in CI on macOS, Windows and Linux;
acceptance criteria shown working in the app; works offline.
