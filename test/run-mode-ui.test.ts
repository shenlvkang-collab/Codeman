/**
 * @fileoverview Unit tests for the Codex run-mode UI surface in session-ui.js /
 * settings-ui.js / index.html. Loads the browser modules into a vm sandbox (no
 * real DOM) and exercises run-mode selection + Codex quick-start wiring.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadRunModeHarness() {
  const elements: Record<string, any> = {};
  const storage = new Map<string, string>();
  const CodemanApp = function CodemanApp(this: any) {};

  const context = vm.createContext({
    CodemanApp,
    VoiceInput: {},
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    document: {
      getElementById: (id: string) => elements[id] ?? null,
    },
    console,
  });

  const settingsUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/settings-ui.js'), 'utf8');
  const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
  vm.runInContext(settingsUi, context, { filename: 'settings-ui.js' });
  vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

  const runModeMenu = { classList: { remove: () => {} } };
  const gearBtn = { className: '' };
  const runBtn = { className: '', nextElementSibling: gearBtn };
  const runBtnLabel = { textContent: '' };
  elements.runModeMenu = runModeMenu;
  elements.runBtn = runBtn;
  elements.runBtnLabel = runBtnLabel;

  const app = new (CodemanApp as any)();
  app.loadAppSettingsFromStorage = () => ({});
  app.saveAppSettingsToStorage = () => {};
  app._apiPut = () => Promise.resolve();

  return { app, storage, runBtnLabel };
}

describe('run mode UI', () => {
  it('updates the visible mode when selecting Claude after server sync set Codex', async () => {
    const { app, storage, runBtnLabel } = loadRunModeHarness();

    storage.set('codeman_runMode', 'claude');
    await app.loadAppSettingsFromServer(Promise.resolve({ runMode: 'codex' }));
    expect(app.runMode).toBe('codex');
    expect(runBtnLabel.textContent).toBe('Run CX');

    app.setRunMode('claude');

    expect(app.runMode).toBe('claude');
    expect(runBtnLabel.textContent).toBe('Run');
  });

  it('accepts Gemini mode from server sync and updates the run button label', async () => {
    const { app, storage, runBtnLabel } = loadRunModeHarness();

    storage.set('codeman_runMode', 'claude');
    await app.loadAppSettingsFromServer(Promise.resolve({ runMode: 'gemini' }));

    expect(app.runMode).toBe('gemini');
    expect(runBtnLabel.textContent).toBe('Run GM');
  });
});

describe('Codex quick start settings', () => {
  it('renders Codex CLI settings in a dedicated app settings tab', () => {
    const html = readFileSync(resolve(import.meta.dirname, '../src/web/public/index.html'), 'utf8');

    expect(html).toContain('data-tab="settings-codex">Codex CLI</button>');

    const claudeTab = html.match(
      /<div class="modal-tab-content hidden" id="settings-claude">([\s\S]*?)<!-- Codex CLI Tab -->/
    );
    expect(claudeTab?.[1]).not.toContain('appSettingsCodexDangerouslyBypassApprovals');

    const codexTab = html.match(
      /<div class="modal-tab-content hidden" id="settings-codex">([\s\S]*?)<\/div>\s*<!-- Models Tab -->/
    );
    expect(codexTab?.[1]).toContain('appSettingsCodexDangerouslyBypassApprovals');
    expect(codexTab?.[1]).not.toContain('appSettingsCodexRenderMode');
  });

  it('passes global Codex settings into quick-start config for new sessions', async () => {
    const elements: Record<string, any> = {
      quickStartCase: { value: 'codex-case' },
    };
    const requests: Array<{ url: string; body?: any }> = [];
    const CodemanApp = function CodemanApp(this: any) {};

    const context = vm.createContext({
      CodemanApp,
      localStorage: {
        getItem: () => null,
        setItem: () => {},
      },
      document: {
        getElementById: (id: string) => elements[id] ?? null,
      },
      // Mock responses use the real wire shape: the global preSerialization hook in
      // server.ts wraps route payloads into the { success, data } envelope.
      fetch: async (url: string, init?: { body?: string }) => {
        requests.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
        if (url === '/api/codex/status') return { json: async () => ({ success: true, data: { available: true } }) };
        if (url === '/api/quick-start') return { json: async () => ({ success: true, data: { sessionId: 'sess-1' } }) };
        throw new Error(`unexpected fetch: ${url}`);
      },
      console,
    });

    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    app.terminal = { clear: () => {}, writeln: () => {}, focus: () => {} };
    app.sessions = new Map([
      ['existing-codex-case', { name: 'w1-codex-case' }],
      ['existing-other-case', { name: 'w7-other-case' }],
    ]);
    app.loadAppSettingsFromStorage = () => ({
      codexDangerouslyBypassApprovals: true,
    });
    app.getCaseSettings = () => ({});
    app.buildEnvOverrides = () => ({});
    const selected: string[] = [];
    app.selectSession = async (id: string) => {
      selected.push(id);
    };

    await app.runCodex();

    expect(requests.find((req) => req.url === '/api/quick-start')?.body).toMatchObject({
      caseName: 'codex-case',
      name: 'w2-codex-case',
      mode: 'codex',
      codexConfig: { dangerouslyBypassApprovals: true, renderMode: 'hybrid' },
    });
    expect(selected).toEqual(['sess-1']);
  });

  it('uses Codex history endpoint and resumes history sessions as Codex in Codex mode', async () => {
    const elements: Record<string, any> = {
      runModeMenu: { classList: { remove: vi.fn() } },
    };
    const requests: Array<{ url: string; body?: any; method?: string }> = [];
    const CodemanApp = function CodemanApp(this: any) {};

    const context = vm.createContext({
      CodemanApp,
      localStorage: {
        getItem: () => 'codex',
        setItem: () => {},
      },
      document: {
        getElementById: (id: string) => elements[id] ?? null,
        removeEventListener: () => {},
      },
      fetch: async (url: string, init?: { method?: string; body?: string }) => {
        requests.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined });
        if (url === '/api/codex/history/sessions') {
          return {
            json: async () => ({
              success: true,
              data: {
                sessions: [
                  {
                    sessionId: '019eb6fc-c4d6-7573-943a-6e33bb08bf75',
                    workingDir: '/mnt/d/AI',
                    projectKey: '019eb6fc-c4d6-7573-943a-6e33bb08bf75',
                    sizeBytes: 10000,
                    lastModified: '2026-06-11T14:03:29.731Z',
                  },
                ],
              },
            }),
          };
        }
        if (url === '/api/sessions') {
          return { json: async () => ({ success: true, data: { session: { id: 'new-codex-session' } } }) };
        }
        if (url === '/api/sessions/new-codex-session/interactive') {
          return { json: async () => ({ success: true }) };
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
      console,
    }) as any;
    context.window = context;

    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    const terminalUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });
    vm.runInContext(terminalUi, context, { filename: 'terminal-ui.js' });

    const app = new (CodemanApp as any)();
    app._runMode = 'codex';
    app.sessions = new Map();
    app.cases = [{ name: 'normal-use', path: '/mnt/d/AI' }];
    app.terminal = { clear: vi.fn(), writeln: vi.fn(), focus: vi.fn() };
    app.loadAppSettingsFromStorage = () => ({ codexDangerouslyBypassApprovals: true });
    app.getCaseSettings = () => ({});
    app.buildEnvOverrides = () => ({});
    app.getEffortSetting = () => 'high';
    app._closeFolderHistoryModal = vi.fn();
    app.selectSession = vi.fn();

    await expect(app._fetchHistorySessions()).resolves.toHaveLength(1);
    await app.resumeHistorySession('019eb6fc-c4d6-7573-943a-6e33bb08bf75', '/mnt/d/AI');

    expect(requests[0].url).toBe('/api/codex/history/sessions');
    expect(requests.find((req) => req.url === '/api/sessions')?.body).toMatchObject({
      workingDir: '/mnt/d/AI',
      mode: 'codex',
      codexConfig: {
        resumeSessionId: '019eb6fc-c4d6-7573-943a-6e33bb08bf75',
        dangerouslyBypassApprovals: true,
        renderMode: 'hybrid',
      },
    });
    expect(requests.find((req) => req.url === '/api/sessions')?.body).not.toHaveProperty('resumeSessionId');
  });
});

describe('Gemini quick start', () => {
  // Regression guard for the ApiResponse-envelope unwrap in runGemini(): the
  // status check must read `.data.available` and the quick-start response must
  // read `.data.sessionId`. Reading the raw shape (pre-fix) silently bails on
  // the status check and never selects the new tab — exactly the two blockers
  // caught in PR #134 review.
  it('drives runGemini() through the {success,data} envelope and selects the new session', async () => {
    const elements: Record<string, any> = {
      quickStartCase: { value: 'gemini-case' },
    };
    const requests: Array<{ url: string; body?: any }> = [];
    const CodemanApp = function CodemanApp(this: any) {};

    const context = vm.createContext({
      CodemanApp,
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { getElementById: (id: string) => elements[id] ?? null },
      // Mock responses use the real wire shape: the server.ts preSerialization
      // hook wraps raw route payloads into the { success, data } envelope.
      fetch: async (url: string, init?: { body?: string }) => {
        requests.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
        if (url === '/api/gemini/status') return { json: async () => ({ success: true, data: { available: true } }) };
        if (url === '/api/quick-start')
          return { json: async () => ({ success: true, data: { sessionId: 'sess-gm' } }) };
        throw new Error(`unexpected fetch: ${url}`);
      },
      console,
    });

    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    app.terminal = { clear: () => {}, writeln: () => {}, focus: () => {} };
    app.loadAppSettingsFromStorage = () => ({});
    app.getCaseSettings = () => ({});
    app.buildEnvOverrides = () => ({});
    const selected: string[] = [];
    app.selectSession = async (id: string) => {
      selected.push(id);
    };

    await app.runGemini();

    expect(requests.find((req) => req.url === '/api/quick-start')?.body).toMatchObject({
      caseName: 'gemini-case',
      mode: 'gemini',
      geminiConfig: { approvalMode: 'yolo' },
    });
    expect(selected).toEqual(['sess-gm']);
  });
});
