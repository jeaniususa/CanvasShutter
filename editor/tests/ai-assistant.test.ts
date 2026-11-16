import { describe, expect, it } from 'vitest';
import { MAX_STEPS, runTurn } from '../src/ai/agent';
import { guessProvider } from '../src/ai/keys';
import { base64url, challengeFor } from '../src/ai/openrouter-auth';
import type { Conversation, Reply } from '../src/ai/providers';
import { TOOLS, runTool, type CommandRunner } from '../src/ai/tools';

/** Stands in for the editor: records what was asked and answers from a table. */
function fakeEditor(answers: Record<string, unknown> = {}) {
  const calls: { method: string; params: unknown }[] = [];
  const commands: CommandRunner = {
    async run(method, params) {
      calls.push({ method, params });
      const a = answers[method];
      if (a === undefined) throw new Error('No photo is open in the editor.');
      return typeof a === 'function' ? (a as () => unknown)() : a;
    },
  };
  return { commands, calls };
}

describe('keys', () => {
  it('recognises a provider from how a key starts', () => {
    expect(guessProvider('  sk-or-v1-abc ')).toBe('openrouter');
    expect(guessProvider('sk-ant-api03-abc')).toBe('anthropic');
    expect(guessProvider('abc')).toBe(null);
  });
});

describe('OpenRouter sign-in', () => {
  it('encodes without the characters that are unsafe in an address', () => {
    expect(base64url(new Uint8Array([251, 255, 254]))).toBe('-__-');
    expect(base64url(new Uint8Array([1]))).toBe('AQ');
  });
  it('makes the standard S256 challenge', async () => {
    // The worked example from the PKCE standard (RFC 7636, appendix B).
    expect(await challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('tools', () => {
  it('have unique names and a schema each', () => {
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
    for (const t of TOOLS) { expect(t.parameters.type).toBe('object'); expect(t.name.length).toBeLessThanOrEqual(64); }
  });
  it('runs the matching editor command and says what happened in a few words', async () => {
    const { commands, calls } = fakeEditor({ set_adjustments: { changed: { exposure: 0.3, saturation: -100, 'levels.rgb.black': 12 }, notes: [] } });
    const o = await runTool(commands, { id: 'a', name: 'set_adjustments', args: { change: { exposure: 0.3 } } });
    expect(calls).toEqual([{ method: 'set_adjustments', params: { change: { exposure: 0.3 } } }]);
    expect(o.isError).toBe(false);
    expect(o.summary).toBe('Set exposure +0.3, saturation -100, rgb black 12');
    expect(JSON.parse(o.text).changed.exposure).toBe(0.3);
  });
  it('hands the preview over as a picture, not as text', async () => {
    const { commands } = fakeEditor({ get_preview: { photo: 'a.jpg', jpegBase64: 'AAAA', width: 10, height: 5 } });
    const o = await runTool(commands, { id: 'a', name: 'get_preview', args: {} });
    expect(o.image).toEqual({ base64: 'AAAA', mediaType: 'image/jpeg' });
    expect(o.text).not.toContain('AAAA');
    expect(JSON.parse(o.text)).toEqual({ photo: 'a.jpg', width: 10, height: 5 });
  });
  it('turns ["all"] into the word the command expects, and exports JPEG unless told otherwise', async () => {
    const { commands, calls } = fakeEditor({ apply_to_photos: { requested: 3, updated: 3, results: [] }, export: { fileName: 'a-edited.jpg' } });
    const o = await runTool(commands, { id: 'a', name: 'apply_adjustments_to_photos', args: { photos: ['all'], change: { temp: 5 }, mode: 'adjust' } });
    await runTool(commands, { id: 'b', name: 'export_photo', args: {} });
    expect(calls[0].params).toEqual({ photos: 'all', change: { temp: 5 }, mode: 'adjust' });
    expect(calls[1]).toEqual({ method: 'export', params: { format: 'jpeg' } });
    expect(o.summary).toBe('Updated 3 of 3 photos');
  });
  it('reports a failure to the model instead of throwing', async () => {
    const { commands } = fakeEditor();
    const failed = await runTool(commands, { id: 'a', name: 'undo', args: {} });
    expect(failed).toMatchObject({ id: 'a', isError: true, text: 'No photo is open in the editor.' });
    expect((await runTool(commands, { id: 'b', name: 'delete_everything', args: {} })).isError).toBe(true);
    expect((await runTool(commands, { id: 'c', name: 'undo', args: {}, badArgs: 'Unexpected token' })).text).toMatch(/not valid JSON/);
  });
});

describe('a turn', () => {
  /** A conversation that plays back prepared answers. */
  function scripted(replies: Reply[]) {
    const seen: string[] = [];
    const convo: Conversation = {
      addUser: (t) => { seen.push(`user:${t}`); },
      send: async () => { seen.push('send'); return replies.shift() ?? { text: '', toolCalls: [], truncated: false }; },
      addToolResults: (r) => { seen.push(`results:${r.map((o) => `${o.id}${o.isError ? '!' : ''}`).join(',')}`); },
    };
    return { convo, seen };
  }
  const collect = () => {
    const lines: string[] = [];
    return { lines, events: { onText: (t: string) => { lines.push(`ai:${t}`); }, onAction: (s: string, ok: boolean) => { lines.push(`${ok ? 'ok' : 'failed'}:${s}`); }, onNote: (t: string) => { lines.push(`note:${t}`); } } };
  };

  it('runs the actions the model asks for, returns the results, and stops when it is done', async () => {
    const { commands } = fakeEditor({ get_preview: { photo: 'a.jpg', jpegBase64: 'AAAA', width: 1, height: 1 }, set_adjustments: { changed: { saturation: -100 } } });
    const { convo, seen } = scripted([
      { text: 'Let me look.', toolCalls: [{ id: '1', name: 'get_preview', args: {} }], truncated: false },
      { text: '', toolCalls: [{ id: '2', name: 'set_adjustments', args: { change: { saturation: -100 } } }, { id: '3', name: 'redo', args: {} }], truncated: false },
      { text: 'It is black and white now.', toolCalls: [], truncated: false },
    ]);
    const { lines, events } = collect();
    await runTurn(convo, commands, 'make it black and white', events);
    expect(seen).toEqual(['user:make it black and white', 'send', 'results:1', 'send', 'results:2,3!', 'send']);
    expect(lines).toEqual(['ai:Let me look.', 'ok:Looked at the photo', 'ok:Set saturation -100', 'failed:No photo is open in the editor.', 'ai:It is black and white now.']);
  });
  it('gives up after a fixed number of steps', async () => {
    const { commands } = fakeEditor({ status: {} });
    const loop: Reply = { text: '', toolCalls: [{ id: 'x', name: 'editor_status', args: {} }], truncated: false };
    const { convo, seen } = scripted(Array.from({ length: 50 }, () => loop));
    const { lines, events } = collect();
    await runTurn(convo, commands, 'hi', events);
    expect(seen.filter((s) => s === 'send').length).toBe(MAX_STEPS);
    expect(lines[lines.length - 1]).toMatch(/^note:Stopped after/);
  });
  it('stops when asked, without leaving an action unanswered', async () => {
    const stop = new AbortController();
    const { commands } = fakeEditor({ status: () => { stop.abort(); return {}; } });
    const { convo, seen } = scripted([{ text: '', toolCalls: [{ id: '1', name: 'editor_status', args: {} }], truncated: false }]);
    let error: unknown;
    try { await runTurn(convo, commands, 'hi', collect().events, stop.signal); } catch (err) { error = err; }
    expect((error as Error).name).toBe('AbortError');
    expect(seen).toEqual(['user:hi', 'send', 'results:1']);
  });
});
