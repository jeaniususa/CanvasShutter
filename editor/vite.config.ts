import { defineConfig, type Plugin } from 'vite';

/**
 * A browser rule (Content Security Policy) for the published editor: the page may run only its own
 * code, and may talk only to the AI providers a user can connect and to the local Claude Code
 * bridge. If unwanted code ever got onto the page, this makes it much harder for it to send a
 * user's AI key or photos anywhere else. Added to the built page only, because the development
 * server needs looser rules for live reloading.
 */
const POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "connect-src 'self' https://openrouter.ai https://api.anthropic.com ws://127.0.0.1:* ws://localhost:*",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

const contentSecurityPolicy = (): Plugin => ({
  name: 'canvasshutter-content-security-policy',
  apply: 'build',
  transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: POLICY }, injectTo: 'head-prepend' }],
});

export default defineConfig({
  // Relative paths, so the built app also works from a subfolder (e.g. GitHub Pages).
  base: './',
  // The photo library belongs to the exact address the app is opened at. A fixed port keeps that
  // address the same every time; if the port is busy, starting fails instead of silently moving.
  server: { port: 5173, strictPort: true },
  plugins: [contentSecurityPolicy()],
});
