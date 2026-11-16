import { describe, expect, it } from 'vitest';
import { AiError, AnthropicConversation, OpenRouterConversation, listModels, pickModel } from '../src/ai/providers';
import { TOOLS, type ToolOutcome } from '../src/ai/tools';

/** Replaces the network for one test: each request gets the next prepared answer. */
function fakeNetwork(answers: { status?: number; body: unknown }[]) {
  const requests: { url: string; headers: Record<string, string>; body: any }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    requests.push({ url: String(url), headers: (init.headers ?? {}) as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : null });
    const a = answers.shift();
    if (!a) throw new TypeError('network down');
    const status = a.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => a.body } as Response;
  }) as typeof fetch;
  return { requests, restore: () => { globalThis.fetch = original; } };
}

const preview: ToolOutcome = { id: 't1', text: '{"photo":"a.jpg"}', image: { base64: 'AAAA', mediaType: 'image/jpeg' }, isError: false, summary: 'Looked at the photo' };

describe('Anthropic', () => {
  it('sends the key straight to Anthropic, reads actions, and keeps only the newest preview', async () => {
    const net = fakeNetwork([
      { body: { stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: '…', signature: 's' }, { type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't1', name: 'get_preview', input: {} }] } },
      { body: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't2', name: 'get_preview', input: { maxSide: 512 } }] } },
      { body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] } },
    ]);
    try {
      const c = new AnthropicConversation('sk-ant-x', 'claude-sonnet-5-5', 'system text', TOOLS);
      c.addUser('hello');
      const first = await c.send();
      expect(first).toEqual({ text: 'Looking.', toolCalls: [{ id: 't1', name: 'get_preview', args: {} }], truncated: false });
      c.addToolResults([preview]);
      const second = await c.send();
      expect(second.toolCalls[0].args).toEqual({ maxSide: 512 });
      c.addToolResults([{ ...preview, id: 't2', image: { base64: 'BBBB', mediaType: 'image/jpeg' } }]);
      expect((await c.send()).text).toBe('Done.');

      const [r1, , r3] = net.requests;
      expect(r1.url).toBe('https://api.anthropic.com/v1/messages');
      expect(r1.headers['x-api-key']).toBe('sk-ant-x');
      expect(r1.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
      expect(r1.body.system).toBe('system text');
      expect(r1.body.tools.length).toBe(TOOLS.length);
      expect(r1.body.tools[0]).toMatchObject({ name: 'editor_status', input_schema: { type: 'object' } });
      // The model's answer goes back unchanged, and results directly follow the actions they answer.
      expect(r3.body.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
      expect(r3.body.messages[1].content[0]).toEqual({ type: 'thinking', thinking: '…', signature: 's' });
      expect(r3.body.messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1' });
      const sent = JSON.stringify(r3.body.messages);
      expect(sent).not.toContain('AAAA'); // the first preview was dropped
      expect(sent).toContain('BBBB');
    } finally { net.restore(); }
  });
  it('explains a rejected key and an unreachable service in plain words', async () => {
    const net = fakeNetwork([{ status: 401, body: { error: { message: 'invalid x-api-key' } } }]);
    try {
      const c = new AnthropicConversation('bad', 'm', 's', TOOLS);
      c.addUser('hi');
      let e1: unknown, e2: unknown;
      try { await c.send(); } catch (err) { e1 = err; }
      try { await c.send(); } catch (err) { e2 = err; }
      expect(e1 instanceof AiError).toBe(true);
      expect((e1 as AiError).status).toBe(401);
      expect((e1 as AiError).message).toMatch(/did not accept this key/);
      expect((e2 as AiError).message).toMatch(/Could not reach Anthropic/);
    } finally { net.restore(); }
  });
});

describe('OpenRouter', () => {
  it('uses the chat format, reads actions, and sends the preview as a picture after the results', async () => {
    const net = fakeNetwork([
      { body: { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, reasoning_details: [{ type: 'x' }], tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'get_preview', arguments: '{}' } },
        { id: 'c2', type: 'function', function: { name: 'set_adjustments', arguments: '{"change":{"temp":10},"mode":"adjust"}' } },
        { id: 'c3', type: 'function', function: { name: 'undo', arguments: '{oops' } },
      ] } }] } },
      { body: { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{ id: 'c4', type: 'function', function: { name: 'get_preview', arguments: '' } }] } }] } },
      { body: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Warmer now.' } }] } },
    ]);
    try {
      const c = new OpenRouterConversation('sk-or-x', 'anthropic/claude-sonnet', 'system text', TOOLS);
      c.addUser('warmer');
      const first = await c.send();
      expect(first.toolCalls.map((t) => t.name)).toEqual(['get_preview', 'set_adjustments', 'undo']);
      expect(first.toolCalls[1].args).toEqual({ change: { temp: 10 }, mode: 'adjust' });
      expect(typeof first.toolCalls[2].badArgs).toBe('string');
      c.addToolResults([{ ...preview, id: 'c1' }, { id: 'c2', text: '{}', isError: false, summary: '' }, { id: 'c3', text: 'bad', isError: true, summary: '' }]);
      expect((await c.send()).toolCalls[0].args).toEqual({});
      c.addToolResults([{ ...preview, id: 'c4', image: { base64: 'BBBB', mediaType: 'image/jpeg' } }]);
      expect(await c.send()).toEqual({ text: 'Warmer now.', toolCalls: [], truncated: false });

      const [r1, r2, r3] = net.requests;
      expect(r1.url).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(r1.headers.Authorization).toBe('Bearer sk-or-x');
      expect(r1.body.messages[0]).toEqual({ role: 'system', content: 'system text' });
      expect(r1.body.tools[0]).toMatchObject({ type: 'function', function: { name: 'editor_status', parameters: { type: 'object' } } });
      expect(r2.body.messages.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'tool', 'tool', 'user']);
      expect(r2.body.messages[2].reasoning_details).toEqual([{ type: 'x' }]);
      expect(r2.body.messages[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '{"photo":"a.jpg"}' });
      expect(r2.body.messages[5].content).toBe('Error: bad');
      expect(r2.body.messages[6].content[1].image_url.url).toBe('data:image/jpeg;base64,AAAA');
      const sent = JSON.stringify(r3.body.messages);
      expect(sent).not.toContain('AAAA');
      expect(sent).toContain('BBBB');
    } finally { net.restore(); }
  });
  it('treats an error inside a successful answer as an error, and names an empty balance', async () => {
    const net = fakeNetwork([{ body: { error: { code: 402, message: 'Insufficient credits' } } }]);
    try {
      const c = new OpenRouterConversation('k', 'm', 's', TOOLS);
      c.addUser('hi');
      let error: unknown;
      try { await c.send(); } catch (err) { error = err; }
      expect((error as AiError).status).toBe(402);
      expect((error as AiError).message).toMatch(/out of credit.*Insufficient credits/);
    } finally { net.restore(); }
  });
});

describe('models', () => {
  const m = (id: string, name: string, created: number, input: string[], params: string[]) => ({ id, name, created, architecture: { input_modalities: input }, supported_parameters: params });
  it('lists OpenRouter models that can see pictures and take actions, Claude first and newest first', async () => {
    const net = fakeNetwork([{ body: { data: [
      m('openai/gpt-x', 'GPT X', 5, ['text', 'image'], ['tools']),
      m('anthropic/claude-sonnet-old', 'Claude Sonnet Old', 1, ['text', 'image'], ['tools']),
      m('anthropic/claude-sonnet-new', 'Claude Sonnet New', 9, ['text', 'image'], ['tools']),
      m('text/only', 'Text Only', 9, ['text'], ['tools']),
      m('no/tools', 'No Tools', 9, ['image'], ['temperature']),
    ] } }]);
    try {
      const models = await listModels('openrouter', 'sk-or-x');
      expect(models.map((x) => x.id)).toEqual(['anthropic/claude-sonnet-new', 'anthropic/claude-sonnet-old', 'openai/gpt-x']);
      expect(net.requests[0].headers.Authorization).toBe('Bearer sk-or-x');
      expect(pickModel('openrouter', models, null)).toBe('anthropic/claude-sonnet-new');
      expect(pickModel('openrouter', models, 'openai/gpt-x')).toBe('openai/gpt-x');
      expect(pickModel('openrouter', models, 'gone/model')).toBe('anthropic/claude-sonnet-new');
    } finally { net.restore(); }
  });
  it('lists current Anthropic models and rejects a bad key', async () => {
    const net = fakeNetwork([
      { body: { data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', lifecycle: 'active' }, { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', lifecycle: 'active' }, { id: 'claude-old', display_name: 'Old', lifecycle: 'retired' }] } },
      { status: 401, body: { error: { message: 'invalid x-api-key' } } },
    ]);
    try {
      const models = await listModels('anthropic', 'sk-ant-x');
      expect(models.map((x) => x.name)).toEqual(['Claude Opus 5.5', 'Claude Sonnet 5.5']);
      expect(pickModel('anthropic', models, null)).toBe('claude-sonnet-5-5');
      let error: unknown;
      try { await listModels('anthropic', 'bad'); } catch (err) { error = err; }
      expect((error as AiError).status).toBe(401);
    } finally { net.restore(); }
  });
  it('still offers a model when the list is empty', () => {
    expect(pickModel('anthropic', [], null)).toBe('claude-sonnet-5-5');
  });
});
