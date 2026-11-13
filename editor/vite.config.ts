import { defineConfig } from 'vite';

export default defineConfig({
  // Relative paths, so the built app also works from a subfolder (e.g. GitHub Pages).
  base: './',
  // The photo library belongs to the exact address the app is opened at. A fixed port keeps that
  // address the same every time; if the port is busy, starting fails instead of silently moving.
  server: { port: 5173, strictPort: true },
});
