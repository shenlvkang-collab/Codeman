/**
 * Claude opens a complete, refreshing transcript; the last-turn selector remains
 * available to API consumers. Exercise history preservation, live appends,
 * reader scroll position, delayed transcripts and stale request isolation.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectLastAnsweredTurn } from '../src/web/response-viewer-transcript.js';

describe('selectLastAnsweredTurn', () => {
  const user = (text: string, turn: number) => ({ role: 'user', text, turn });
  const assistant = (text: string, turn: number) => ({ role: 'assistant', text, turn });

  it('returns every assistant message of the highest answered turn', () => {
    const messages = [
      user('a', 1),
      assistant('a1', 1),
      user('b', 2),
      assistant('b1', 2),
      assistant('b2', 2),
      user('c', 3),
    ];
    expect(selectLastAnsweredTurn(messages).map((m) => m.text)).toEqual(['b1', 'b2']);
  });

  it('yields nothing for messages without numeric turns, so callers fall back to text', () => {
    const messages = [
      { role: 'user', text: 'a' },
      { role: 'assistant', text: 'a1' },
      { role: 'assistant', text: 'a2' },
    ];
    expect(selectLastAnsweredTurn(messages)).toEqual([]);
    expect(selectLastAnsweredTurn([])).toEqual([]);
  });

  it('keeps turn-0 output emitted before the first prompt', () => {
    expect(selectLastAnsweredTurn([assistant('hello', 0)]).map((m) => m.text)).toEqual(['hello']);
  });
});

describe('Claude response viewer history', () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  const { document, NodeFilter } = dom.window;

  function loadCodemanAppClass() {
    const constants = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    const context = vm.createContext({
      console,
      performance,
      setInterval: vi.fn(),
      clearInterval: vi.fn(),
      setTimeout,
      clearTimeout,
      requestAnimationFrame: vi.fn(),
      HTMLCanvasElement: class HTMLCanvasElement {},
      fetch: vi.fn(),
      AbortController,
      document,
      NodeFilter,
      localStorage: { length: 0, key: vi.fn(), getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
      window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
      MobileDetection: {},
    });
    vm.runInContext(`${constants}\n${source}\nglobalThis.__CodemanApp = CodemanApp;`, context);
    return { CodemanApp: (context as { __CodemanApp: { prototype: object } }).__CodemanApp, context };
  }

  const { CodemanApp, context: appContext } = loadCodemanAppClass();

  interface ViewerApp {
    toggleResponseViewer(): Promise<void>;
    _refreshClaudeResponseHistory(generation: number, initial?: boolean): Promise<void>;
    _responseViewerGeneration: number;
    activeSessionId?: string;
    sessions?: Map<string, { mode: string }>;
  }

  function mountViewer() {
    const viewer = document.createElement('div');
    viewer.id = 'responseViewer';
    const backdrop = document.createElement('div');
    backdrop.id = 'responseViewerBackdrop';
    const body = document.createElement('div');
    body.id = 'responseViewerBody';
    const title = document.createElement('div');
    title.id = 'responseViewerTitle';
    const more = document.createElement('button');
    more.id = 'responseViewerMore';
    document.body.append(viewer, backdrop, body, title, more);
    return { viewer, body, title, more };
  }

  function makeApp(payload: unknown): { app: ViewerApp; fetchMock: ReturnType<typeof vi.fn> } {
    vi.useFakeTimers();
    (appContext as { setTimeout: unknown }).setTimeout = setTimeout;
    (appContext as { clearTimeout: unknown }).clearTimeout = clearTimeout;
    const app = Object.create(CodemanApp.prototype) as ViewerApp;
    app.activeSessionId = 's1';
    app.sessions = new Map([['s1', { mode: 'claude' }]]);
    const fetchMock = vi.fn(async () => ({ json: async () => ({ data: payload }) }));
    (appContext as { fetch: unknown }).fetch = fetchMock;
    return { app, fetchMock };
  }

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('opens the full history and renders a turn as one badged card with segments', async () => {
    const { body, viewer } = mountViewer();
    const { app, fetchMock } = makeApp({
      text: 'Done.',
      timestamp: 't',
      messages: [
        { role: 'assistant', text: 'Looking at the file.', turn: 2 },
        { role: 'assistant', text: 'The bug is on line 3.', turn: 2 },
        { role: 'assistant', text: 'Done.', turn: 2 },
      ],
    });

    await app.toggleResponseViewer();

    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/sessions/s1/last-response?context=full');
    const cards = body.querySelectorAll('.rv-message');
    expect(cards).toHaveLength(3);
    expect(body.querySelectorAll('.rv-role')).toHaveLength(1);
    expect(cards[0].classList.contains('rv-msg-cont')).toBe(false);
    expect(cards[1].classList.contains('rv-msg-cont')).toBe(true);
    expect(cards[2].classList.contains('rv-msg-cont')).toBe(true);
    expect(body.textContent).toContain('The bug is on line 3.');
    expect(viewer.classList.contains('visible')).toBe(true);
  });

  it('opens history at its newest text', async () => {
    // `body.scrollTop = 0` was right when the brief view was one card holding
    // the last row. With the whole turn rendered, the top of the scroller is
    // the turn's FIRST narration line and the answer the eye button exists to
    // show can be several screens below it; loadFullContext already scrolls to
    // the bottom for the same turn, so the two views disagreed.
    // jsdom does no layout, so scrollHeight is stubbed and the write recorded.
    const spyScroll = (body: HTMLElement) => {
      const writes: number[] = [];
      Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => 4200 });
      Object.defineProperty(body, 'scrollTop', {
        configurable: true,
        get: () => writes[writes.length - 1] ?? 0,
        set: (v: number) => void writes.push(v),
      });
      return writes;
    };

    const many = mountViewer();
    const manyWrites = spyScroll(many.body);
    await makeApp({
      text: 'Done.',
      timestamp: 't',
      messages: [
        { role: 'assistant', text: 'Looking at the file.', turn: 2 },
        { role: 'assistant', text: 'Done.', turn: 2 },
      ],
    }).app.toggleResponseViewer();
    expect(manyWrites.at(-1)).toBe(4200);

    document.body.innerHTML = '';
    const one = mountViewer();
    const oneWrites = spyScroll(one.body);
    await makeApp({
      text: 'Done.',
      timestamp: 't',
      messages: [{ role: 'assistant', text: 'Done.', turn: 2 }],
    }).app.toggleResponseViewer();
    expect(oneWrites.at(-1)).toBe(4200);
  });

  it('falls back to text when the server sends no messages, keeping one badged card', async () => {
    const { body } = mountViewer();
    const { app } = makeApp({ text: 'Only the last row.', timestamp: 't' });

    await app.toggleResponseViewer();

    expect(body.querySelectorAll('.rv-message')).toHaveLength(1);
    expect(body.querySelectorAll('.rv-role')).toHaveLength(1);
    expect(body.textContent).toContain('Only the last row.');
  });

  it('includes human prompts and ignores blank rows in history', async () => {
    const { body } = mountViewer();
    const { app } = makeApp({
      text: 'answer',
      timestamp: 't',
      messages: [
        { role: 'user', text: 'prompt', turn: 1 },
        { role: 'assistant', text: '   ', turn: 1 },
        { role: 'assistant', text: 'answer', turn: 1 },
      ],
    });

    await app.toggleResponseViewer();

    expect(body.querySelectorAll('.rv-message')).toHaveLength(2);
    expect(body.textContent).toContain('prompt');
    expect(body.textContent).toContain('answer');
  });

  it('appends new replies without duplicating history or moving a reader who scrolled up', async () => {
    const { body } = mountViewer();
    const messages = [
      { role: 'user', text: 'old question', turn: 1 },
      { role: 'assistant', text: 'important intermediate result', turn: 1 },
    ];
    const { app, fetchMock } = makeApp({ messages });
    await app.toggleResponseViewer();
    const first = body.firstElementChild;
    Object.defineProperty(body, 'scrollHeight', { get: () => 3000 });
    Object.defineProperty(body, 'clientHeight', { get: () => 500 });
    body.scrollTop = 200;
    fetchMock.mockResolvedValue({
      json: async () => ({ data: { messages: [...messages, { role: 'assistant', text: 'final answer', turn: 1 }] } }),
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(body.querySelectorAll('.rv-message')).toHaveLength(3);
    expect(body.firstElementChild).toBe(first);
    expect(body.scrollTop).toBe(200);
    await vi.advanceTimersByTimeAsync(5000);
    expect(body.querySelectorAll('.rv-message')).toHaveLength(3);
    await app.toggleResponseViewer();
    const count = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(15000);
    expect(fetchMock).toHaveBeenCalledTimes(count);
  });

  it('never substitutes a raw terminal dump when a resumed transcript is temporarily missing', async () => {
    const { body } = mountViewer();
    const { app, fetchMock } = makeApp({ messages: [], text: '' });
    await app.toggleResponseViewer();
    expect(body.textContent).toContain('Waiting for the transcript');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValue({
      json: async () => ({ data: { messages: [{ role: 'assistant', text: 'Recovered history', turn: 1 }] } }),
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(body.textContent).toContain('Recovered history');
    expect(body.textContent).not.toContain('Waiting for the transcript');
  });

  it('does not reopen a closed overlay when an in-flight history request finishes', async () => {
    const { body, viewer } = mountViewer();
    const { app, fetchMock } = makeApp({ messages: [] });
    let finish!: (value: unknown) => void;
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const opening = app.toggleResponseViewer();
    await app.toggleResponseViewer();
    finish({ json: async () => ({ data: { messages: [{ role: 'assistant', text: 'late reply' }] } }) });
    await opening;
    expect(viewer.classList.contains('visible')).toBe(false);
    expect(body.textContent).not.toContain('late reply');
  });

  it('does not render a late response from a different tab', async () => {
    const { body } = mountViewer();
    const { app, fetchMock } = makeApp({ messages: [] });
    let finish!: (value: unknown) => void;
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const opening = app.toggleResponseViewer();
    app.activeSessionId = 'other';
    finish({ json: async () => ({ data: { messages: [{ role: 'assistant', text: 'wrong conversation' }] } }) });
    await opening;
    expect(body.textContent).not.toContain('wrong conversation');
  });
});
