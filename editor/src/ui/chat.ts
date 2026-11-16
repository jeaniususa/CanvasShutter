/**
 * The AI chat built into the editor. The person connects their own AI account (signing in with
 * OpenRouter, or pasting a key), asks for edits in plain language, and the assistant carries them
 * out through the same command layer the sliders' other remote controls use.
 *
 * Text from the AI is only ever placed on the page as plain text, never as HTML.
 */
import { SYSTEM_PROMPT, runTurn } from '../ai/agent';
import { PROVIDER_NAMES, clearConnection, guessProvider, loadConnection, modelChoice, saveConnection, type Connection, type ProviderId } from '../ai/keys';
import { beginSignIn, finishSignIn } from '../ai/openrouter-auth';
import { AiError, FALLBACK_MODELS, listModels, pickModel, startConversation, type Conversation, type ModelOption } from '../ai/providers';
import { TOOLS, type CommandRunner } from '../ai/tools';
import { isTouchDevice } from './touch';

const IDEAS = ['What would you change?', 'Make it black and white', 'Warm it up a little', 'Brighten the shadows'];

export function setupChat(commands: CommandRunner) {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const chat = $('chat'), launcher = $('ai-open'), connectView = $('chat-connect'), talkView = $('chat-talk');
  const log = $('chat-log'), ideas = $('chat-ideas'), input = $<HTMLTextAreaElement>('chat-input'), sendBtn = $<HTMLButtonElement>('chat-send');
  const modelSelect = $<HTMLSelectElement>('chat-model'), newBtn = $('chat-new');
  const keyInput = $<HTMLInputElement>('key-input'), keyProvider = $<HTMLSelectElement>('key-provider'), keyConnect = $<HTMLButtonElement>('key-connect');
  const signIn = $<HTMLButtonElement>('or-signin'), remember = $<HTMLInputElement>('ai-remember'), connectStatus = $('connect-status');

  let connection: Connection | null = loadConnection();
  let models: ModelOption[] | null = null;
  let loadingModels: Promise<void> | null = null;
  let model = '';
  let convo: Conversation | null = null;
  let running: AbortController | null = null;
  let chatNumber = 0; // goes up whenever the chat is cleared, so a request that was under way cannot write into the new one

  function render() {
    const name = connection ? PROVIDER_NAMES[connection.provider] : '';
    connectView.hidden = !!connection;
    talkView.hidden = !connection;
    modelSelect.hidden = !connection || !models;
    newBtn.hidden = !connection || !log.childElementCount;
    ideas.hidden = !!log.childElementCount;
    sendBtn.textContent = running ? 'Stop' : 'Send';
    launcher.dataset.state = connection ? 'connected' : 'off';
    launcher.title = connection ? `Ask the AI assistant to edit for you (connected to ${name})` : 'Ask the AI assistant to edit for you';
    $('chat-account').textContent = connection
      ? `Connected to ${name} ${connection.remembered ? 'on this device' : 'until this tab closes'}. You pay ${name} for what you use.`
      : '';
  }

  /** Adds one line to the chat. `before` keeps the "Working…" line at the bottom. */
  function add(kind: string, text: string, before?: Element): HTMLElement {
    const el = document.createElement('div');
    el.className = `msg ${kind}`;
    el.textContent = text;
    if (before?.parentElement === log) log.insertBefore(el, before); else log.append(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  function fillModels() {
    modelSelect.replaceChildren();
    const groups = new Map<string, HTMLOptGroupElement>();
    for (const m of models ?? []) {
      let group = groups.get(m.group);
      if (!group) { group = document.createElement('optgroup'); group.label = m.group; groups.set(m.group, group); modelSelect.append(group); }
      const option = document.createElement('option');
      option.value = m.id; option.textContent = m.name;
      group.append(option);
    }
    modelSelect.value = model;
  }

  function useModels(list: ModelOption[]) {
    if (!connection) return;
    models = list.length ? list : FALLBACK_MODELS[connection.provider];
    model = pickModel(connection.provider, models, modelChoice.get(connection.provider));
    fillModels();
    render();
  }

  /** Fetches the list of models once per connection. A rejected key ends the connection. */
  function ensureModels(): Promise<void> {
    if (!connection || models) return Promise.resolve();
    const { provider, key } = connection;
    loadingModels ??= listModels(provider, key)
      .then((list) => { if (connection?.key === key) useModels(list); })
      .catch((err) => {
        if (connection?.key !== key) return;
        if (err instanceof AiError && err.status === 401) { disconnect(err.message); return; }
        useModels([]); // the list is a convenience; a usual model still works without it
      })
      .finally(() => { loadingModels = null; });
    return loadingModels;
  }

  function connected(provider: ProviderId, key: string, keep: boolean, list?: ModelOption[]) {
    const saved = saveConnection(provider, key, keep);
    connection = { provider, key, remembered: keep && saved };
    models = null; convo = null;
    keyInput.value = '';
    connectStatus.textContent = '';
    if (list) useModels(list); else void ensureModels();
    render();
    if (!saved) add('note', 'This browser is blocking storage for this page, so you will need to connect again after reloading.');
  }

  function disconnect(message = 'Disconnected. The key was removed from this browser.') {
    running?.abort(); chatNumber++;
    clearConnection();
    connection = null; models = null; convo = null;
    log.replaceChildren();
    connectStatus.textContent = message;
    render();
  }

  async function connectWithKey() {
    const key = keyInput.value.trim();
    if (!key) { connectStatus.textContent = 'Paste your key first.'; keyInput.focus(); return; }
    const provider = guessProvider(key) ?? (keyProvider.value as ProviderId);
    keyProvider.value = provider;
    keyConnect.disabled = true;
    connectStatus.textContent = `Checking the key with ${PROVIDER_NAMES[provider]}…`;
    try {
      connected(provider, key, remember.checked, await listModels(provider, key)); // asking for the models proves the key works
    } catch (err) {
      connectStatus.textContent = err instanceof AiError && err.status === 401
        ? `${PROVIDER_NAMES[provider]} did not accept that key. Check that you copied all of it and picked the right provider.`
        : (err as Error).message;
    } finally { keyConnect.disabled = false; }
  }

  function newChat() {
    running?.abort(); chatNumber++;
    convo = null;
    log.replaceChildren();
    render();
  }

  async function ask(text: string) {
    text = text.trim();
    if (!text || running || !connection) return;
    add('user', text);
    input.value = ''; grow();
    if (isTouchDevice()) input.blur(); // puts the keyboard away so the photo is in view while it changes
    const turn = (running = new AbortController()), mine = chatNumber;
    const here = () => mine === chatNumber; // still the same chat?
    const wait = add('wait', 'Working…');
    render();
    try {
      await ensureModels();
      if (!connection) return; // the key was rejected while the models were loading
      convo ??= startConversation(connection.provider, connection.key, model, SYSTEM_PROMPT, TOOLS);
      await runTurn(convo, commands, text, {
        onText: (t) => { if (here()) add('ai', t, wait); },
        onAction: (summary, ok) => { if (here()) add(ok ? 'act' : 'act failed', summary, wait); },
        onNote: (t) => { if (here()) add('note', t, wait); },
      }, turn.signal);
    } catch (err) {
      if (!here()) return; // the chat was cleared or disconnected meanwhile
      if ((err as Error)?.name === 'AbortError') add('note', 'Stopped.', wait);
      else add('note error', err instanceof AiError ? err.message : `Something went wrong: ${(err as Error)?.message ?? String(err)}`, wait);
    } finally {
      wait.remove();
      if (running === turn) running = null;
      render();
    }
  }

  function open() {
    chat.hidden = false; launcher.hidden = true;
    if (connection) { void ensureModels(); if (!isTouchDevice()) input.focus(); }
  }
  function close() { chat.hidden = true; launcher.hidden = false; launcher.focus(); }

  /** The message box grows with its text, up to a few lines. */
  function grow() { input.style.height = 'auto'; input.style.height = `${Math.min(120, input.scrollHeight + 2)}px`; }

  for (const idea of IDEAS) {
    const b = document.createElement('button');
    b.textContent = idea;
    b.addEventListener('click', () => void ask(idea));
    ideas.append(b);
  }

  launcher.addEventListener('click', open);
  $('chat-close').addEventListener('click', close);
  newBtn.addEventListener('click', newChat);
  $('chat-disconnect').addEventListener('click', () => disconnect());
  signIn.addEventListener('click', () => {
    signIn.disabled = true;
    connectStatus.textContent = 'Opening OpenRouter…';
    beginSignIn(remember.checked).catch((err) => { connectStatus.textContent = (err as Error).message; signIn.disabled = false; });
  });
  // Coming back from another page (or the Back button) must not leave the sign-in button switched off.
  addEventListener('pageshow', () => { signIn.disabled = false; });
  keyConnect.addEventListener('click', () => void connectWithKey());
  keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') void connectWithKey(); });
  keyInput.addEventListener('input', () => { const p = guessProvider(keyInput.value); if (p) keyProvider.value = p; });
  sendBtn.addEventListener('click', () => { if (running) running.abort(); else void ask(input.value); });
  input.addEventListener('input', grow);
  input.addEventListener('keydown', (e) => {
    // Enter sends with a keyboard; on a phone Enter makes a new line and the Send button sends.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isTouchDevice()) { e.preventDefault(); void ask(input.value); }
  });
  modelSelect.addEventListener('change', () => {
    if (!connection) return;
    model = modelSelect.value;
    modelChoice.set(connection.provider, model);
    if (convo) { running?.abort(); convo = null; add('note', `Switched to ${modelSelect.selectedOptions[0]?.textContent ?? model}. The assistant starts fresh from here.`); }
  });
  // Typing in the chat must not trigger the editor's keyboard shortcuts (O, \, arrows, undo).
  for (const type of ['keydown', 'keyup'] as const) chat.addEventListener(type, (e) => {
    if (type === 'keydown' && e.key === 'Escape') close();
    e.stopPropagation();
  });

  // Phones: keep the chat above the on-screen keyboard, and give it the whole screen while typing.
  const vv = window.visualViewport;
  if (vv) {
    const fit = () => {
      const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      chat.style.setProperty('--keyboard', `${Math.round(covered)}px`);
      chat.classList.toggle('typing', covered > 120);
    };
    vv.addEventListener('resize', fit);
    vv.addEventListener('scroll', fit);
  }

  render();

  // Back from OpenRouter's approval page? Finish signing in and open the chat.
  finishSignIn()
    .then((result) => { if (result) { connected('openrouter', result.key, result.remember); open(); } })
    .catch((err) => { open(); connectStatus.textContent = (err as Error).message; });

  return { open, close };
}
