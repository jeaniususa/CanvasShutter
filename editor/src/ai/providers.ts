/**
 * Talking to the AI provider the user connected. Requests go straight from this browser to the
 * provider with the user's own key; nothing passes through a CanvasShutter server.
 *
 * Two providers, one shape: a Conversation keeps the history in the provider's own format and
 * exposes the same three steps (add what the user said, send, add the results of actions).
 */
import { PROVIDER_NAMES, type ProviderId } from './keys';
import type { ToolCall, ToolDef, ToolOutcome } from './tools';

export interface Reply { text: string; toolCalls: ToolCall[]; /** The answer was cut off by the length limit. */ truncated: boolean }

export interface Conversation {
  addUser(text: string): void;
  /** Sends the conversation so far and records the assistant's answer. */
  send(signal?: AbortSignal): Promise<Reply>;
  addToolResults(results: ToolOutcome[]): void;
}

export interface ModelOption { id: string; name: string; group: string }

/** A problem reported by the provider, already worded for the person using the editor. */
export class AiError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = 'AiError'; }
}

const MAX_OUTPUT_TOKENS = 4096;
const OLD_PREVIEW = '(An earlier preview of the photo was here. It was removed to save cost; call get_preview again if you need to look.)';

function problem(provider: ProviderId, status: number, detail: unknown): AiError {
  const name = PROVIDER_NAMES[provider];
  const said = typeof detail === 'string' && detail ? ` ${name} said: ${detail}` : '';
  if (status === 401) return new AiError(`${name} did not accept this key. It may have been removed or mistyped. Disconnect and connect again.`, status);
  if (status === 402) return new AiError(`This ${name} account or key is out of credit. Add credit with ${name}, then try again.${said}`, status);
  if (status === 429) return new AiError(`${name} is limiting requests right now. Wait a moment and try again.${said}`, status);
  if (status >= 500) return new AiError(`${name} had a problem on its side. Try again in a moment.${said}`, status);
  return new AiError(`${name} could not handle that request.${said}`, status);
}

async function request(provider: ProviderId, url: string, init: RequestInit): Promise<{ status: number; ok: boolean; body: any }> {
  let res: Response;
  try { res = await fetch(url, init); }
  catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new AiError(`Could not reach ${PROVIDER_NAMES[provider]}. Check your internet connection and try again.`);
  }
  let body: any = null;
  try { body = await res.json(); } catch { /* an empty or non-JSON answer is handled by the caller */ }
  return { status: res.status, ok: res.ok, body };
}

// ---------------------------------------------------------------------------------- Anthropic

const anthropicHeaders = (key: string) => ({
  'content-type': 'application/json',
  'x-api-key': key,
  'anthropic-version': '2023-06-01',
  // Anthropic's opt-in for calls made from a web page with the user's own key.
  'anthropic-dangerous-direct-browser-access': 'true',
});

type AnthropicBlock = { type: string; [k: string]: unknown };

export class AnthropicConversation implements Conversation {
  private messages: { role: 'user' | 'assistant'; content: AnthropicBlock[] }[] = [];

  constructor(private key: string, private model: string, private system: string, private tools: ToolDef[]) {}

  addUser(text: string) { this.messages.push({ role: 'user', content: [{ type: 'text', text }] }); }

  async send(signal?: AbortSignal): Promise<Reply> {
    const { ok, status, body } = await request('anthropic', 'https://api.anthropic.com/v1/messages', {
      method: 'POST', signal, headers: anthropicHeaders(this.key),
      body: JSON.stringify({
        model: this.model, max_tokens: MAX_OUTPUT_TOKENS, system: this.system,
        tools: this.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
        messages: this.messages,
      }),
    });
    if (!ok) throw problem('anthropic', status, body?.error?.message);
    const content: AnthropicBlock[] = Array.isArray(body?.content) ? body.content : [];
    // The answer goes back into the history exactly as received (it can hold blocks that must not be altered).
    if (content.length) this.messages.push({ role: 'assistant', content });
    return {
      text: content.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('\n').trim(),
      toolCalls: content.filter((b) => b.type === 'tool_use').map((b) => ({ id: String(b.id), name: String(b.name), args: (b.input ?? {}) as Record<string, unknown> })),
      truncated: body?.stop_reason === 'max_tokens',
    };
  }

  addToolResults(results: ToolOutcome[]) {
    // Only the newest preview is kept; older pictures would be paid for again on every request.
    if (results.some((r) => r.image)) {
      for (const m of this.messages) for (const b of m.content) {
        if (b.type === 'tool_result' && Array.isArray(b.content)) b.content = (b.content as AnthropicBlock[]).map((c) => (c.type === 'image' ? { type: 'text', text: OLD_PREVIEW } : c));
      }
    }
    this.messages.push({
      role: 'user',
      content: results.map((r) => ({
        type: 'tool_result', tool_use_id: r.id, ...(r.isError ? { is_error: true } : {}),
        content: r.image
          ? [{ type: 'text', text: r.text }, { type: 'image', source: { type: 'base64', media_type: r.image.mediaType, data: r.image.base64 } }]
          : r.text,
      })),
    });
  }
}

// --------------------------------------------------------------------------------- OpenRouter

const openRouterHeaders = (key: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${key}` });

type ChatMessage = { role: string; content: unknown; [k: string]: unknown };

export class OpenRouterConversation implements Conversation {
  private messages: ChatMessage[];
  private previews = new Set<ChatMessage>();

  constructor(private key: string, private model: string, system: string, private tools: ToolDef[]) {
    this.messages = [{ role: 'system', content: system }];
  }

  addUser(text: string) { this.messages.push({ role: 'user', content: text }); }

  async send(signal?: AbortSignal): Promise<Reply> {
    const { ok, status, body } = await request('openrouter', 'https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', signal, headers: openRouterHeaders(this.key),
      body: JSON.stringify({
        model: this.model, max_completion_tokens: MAX_OUTPUT_TOKENS, messages: this.messages,
        tools: this.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
      }),
    });
    // OpenRouter can report a failure inside an otherwise successful answer.
    const choice = body?.choices?.[0];
    const failure = body?.error ?? choice?.error;
    if (!ok || (failure && !choice?.message)) throw problem('openrouter', ok ? Number(failure?.code) || 502 : status, failure?.message);
    const message = choice?.message ?? {};
    const text = typeof message.content === 'string' ? message.content
      : Array.isArray(message.content) ? message.content.map((p: { text?: unknown }) => (typeof p?.text === 'string' ? p.text : '')).join('') : '';
    const rawCalls: any[] = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const toolCalls: ToolCall[] = rawCalls.map((c, i) => {
      const call: ToolCall = { id: String(c?.id ?? `call_${i}`), name: String(c?.function?.name ?? ''), args: {} };
      const raw = c?.function?.arguments;
      try { const parsed = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw ?? {}; if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) call.args = parsed; else call.badArgs = 'expected an object'; }
      catch (err) { call.badArgs = (err as Error).message; }
      return call;
    });
    if (text || rawCalls.length) {
      const record: ChatMessage = { role: 'assistant', content: rawCalls.length ? message.content ?? null : text };
      if (rawCalls.length) record.tool_calls = rawCalls;
      // Some models attach reasoning that has to be handed back unchanged for the next step.
      if (message.reasoning_details) record.reasoning_details = message.reasoning_details;
      this.messages.push(record);
    }
    return { text: text.trim(), toolCalls, truncated: choice?.finish_reason === 'length' };
  }

  addToolResults(results: ToolOutcome[]) {
    for (const r of results) this.messages.push({ role: 'tool', tool_call_id: r.id, content: r.isError ? `Error: ${r.text}` : r.text });
    // This API takes pictures only in a user message, so the preview follows the results there.
    const images = results.filter((r) => r.image);
    if (!images.length) return;
    for (const old of this.previews) old.content = OLD_PREVIEW; // only the newest preview is kept
    this.previews.clear();
    const preview: ChatMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'This is the preview from get_preview: the open photo as currently edited.' },
        ...images.slice(-1).map((r) => ({ type: 'image_url', image_url: { url: `data:${r.image!.mediaType};base64,${r.image!.base64}` } })),
      ],
    };
    this.previews.add(preview);
    this.messages.push(preview);
  }
}

// -------------------------------------------------------------------------------------- Models

export function startConversation(provider: ProviderId, key: string, model: string, system: string, tools: ToolDef[]): Conversation {
  return provider === 'anthropic' ? new AnthropicConversation(key, model, system, tools) : new OpenRouterConversation(key, model, system, tools);
}

/** Used when the provider's model list cannot be fetched. */
export const FALLBACK_MODELS: Record<ProviderId, ModelOption[]> = {
  anthropic: [
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', group: 'Claude' },
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', group: 'Claude' },
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', group: 'Claude' },
  ],
  openrouter: [{ id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', group: 'Claude' }],
};

/**
 * The models this key can use that can both look at pictures and take actions. Asking for the list
 * also proves the key works: a key the provider rejects throws an AiError with status 401.
 */
export async function listModels(provider: ProviderId, key: string, signal?: AbortSignal): Promise<ModelOption[]> {
  if (provider === 'anthropic') {
    const { ok, status, body } = await request(provider, 'https://api.anthropic.com/v1/models?limit=100', { signal, headers: anthropicHeaders(key) });
    if (!ok) throw problem(provider, status, body?.error?.message);
    const data: any[] = Array.isArray(body?.data) ? body.data : [];
    return data
      .filter((m) => typeof m?.id === 'string' && (m.lifecycle === undefined || m.lifecycle === 'active') && m.capabilities?.image_input?.supported !== false)
      .map((m) => ({ id: m.id, name: typeof m.display_name === 'string' ? m.display_name : m.id, group: 'Claude' }));
  }
  const { ok, status, body } = await request(provider, 'https://openrouter.ai/api/v1/models?supported_parameters=tools&input_modalities=image', { signal, headers: openRouterHeaders(key) });
  if (!ok) throw problem(provider, status, body?.error?.message);
  const data: any[] = Array.isArray(body?.data) ? body.data : [];
  const usable = data.filter((m) => typeof m?.id === 'string'
    && (!Array.isArray(m.supported_parameters) || m.supported_parameters.includes('tools'))
    && (!Array.isArray(m.architecture?.input_modalities) || m.architecture.input_modalities.includes('image')));
  const newest = (a: any, b: any) => (Number(b.created) || 0) - (Number(a.created) || 0);
  const option = (m: any, group: string): ModelOption => ({ id: m.id, name: typeof m.name === 'string' ? m.name : m.id, group });
  const claude = usable.filter((m) => m.id.startsWith('anthropic/')).sort(newest).map((m) => option(m, 'Claude'));
  const others = usable.filter((m) => !m.id.startsWith('anthropic/')).map((m) => option(m, 'Other models')).sort((a, b) => a.name.localeCompare(b.name));
  return [...claude, ...others];
}

/** The model to start with: the one used last time if it is still offered, otherwise a sensible Claude model. */
export function pickModel(provider: ProviderId, models: ModelOption[], saved: string | null): string {
  if (saved && models.some((m) => m.id === saved)) return saved;
  const first = (test: (id: string) => boolean) => models.find((m) => test(m.id))?.id;
  const sonnet = provider === 'anthropic' ? first((id) => id === 'claude-sonnet-5-5') ?? first((id) => id.includes('sonnet')) : first((id) => id.startsWith('anthropic/claude-sonnet'));
  return sonnet ?? first((id) => id.includes('claude')) ?? models[0]?.id ?? FALLBACK_MODELS[provider][0].id;
}
