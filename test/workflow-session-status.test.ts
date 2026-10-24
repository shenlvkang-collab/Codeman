import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');

function loadApp() {
  const CodemanApp = function CodemanApp(this: any) {};
  const context = vm.createContext({
    CodemanApp,
    window: {},
    console,
    setTimeout: () => 0,
    requestAnimationFrame: (fn: () => void) => fn(),
  });
  for (const file of ['constants.js', 'mobile-overview.js', 'home-sessions.js', 'panels-ui.js']) {
    vm.runInContext(readFileSync(resolve(PUBLIC, file), 'utf8'), context, { filename: file });
  }
  const app = new (CodemanApp as any)();
  Object.assign(app, {
    sessions: new Map(),
    subagents: new Map(),
    subagentActivity: new Map(),
    subagentToolResults: new Map(),
    subagentWindows: new Map(),
    subagentParentMap: new Map(),
    sessionOrder: [],
    renderSubagentPanel: vi.fn(),
    renderSessionTabs: vi.fn(),
    updateSubagentWindows: vi.fn(),
    updateConnectionLines: vi.fn(),
    findParentSessionForSubagent: vi.fn(),
    _notifySession: vi.fn(),
  });
  return { app, order: context.window.CodemanSessionOrder, triage: context.window.CodemanTabTriage };
}

const parent = { id: 'tab-a', mode: 'claude', claudeSessionId: 'conversation-a', status: 'idle' };
const child = {
  agentId: 'child',
  sessionId: 'conversation-a',
  status: 'active',
  startedAt: '2026-10-24T01:00:00Z',
  lastActivityAt: Date.parse('2026-10-24T01:10:00Z'),
};

describe('session Workflow status', () => {
  it.each(['active', 'idle'])('keeps an unfinished %s child in progress on both home screens', (status) => {
    const { app, triage } = loadApp();
    app.sessions.set(parent.id, parent);
    app.subagents.set(child.agentId, { ...child, status });
    const phone = app.buildMobileOverviewModel({ sessions: app.sessions, subagents: app.subagents });
    const desktop = app.buildHomeSessionRows();
    for (const row of [phone.current[0], desktop[0]]) {
      expect(row.state).toBe('workflow');
      expect(row.pill).toBe('workflow');
      expect(row.since).toEqual({ key: 'workflow', at: Date.parse(child.startedAt) });
      expect(triage.groupFor(row.state, false)).toBe('working');
    }
  });

  it('uses exact recorded conversation ownership and ignores window-placement guesses', () => {
    const { app } = loadApp();
    app.activeSessionId = parent.id;
    app.subagents.set('other', { ...child, sessionId: 'another-conversation', parentSessionId: parent.id });
    app.subagentParentMap.set('other', parent.id);
    expect(app._mobileOverviewState(parent)).toBe('idle');
    expect(app._mobileOverviewState({ ...parent, claudeSessionId: undefined })).toBe('idle');
    app.subagents.set('previous', { ...child, sessionId: 'previous-conversation' });
    expect(app._mobileOverviewState({ ...parent, claudeSessionChain: ['previous-conversation'] })).toBe('workflow');
  });

  it('keeps errors, stopped/exited panes, questions and the main running turn distinct', () => {
    const { app } = loadApp();
    app.subagents.set(child.agentId, child);
    expect(app._mobileOverviewState(parent, new Set(['permission_prompt']))).toBe('needs');
    expect(app._mobileOverviewState(parent, new Set(['elicitation_dialog']))).toBe('needs');
    expect(app._mobileOverviewState({ ...parent, status: 'error' })).toBe('error');
    expect(app._mobileOverviewState({ ...parent, status: 'stopped' })).toBe('done');
    expect(app._mobileOverviewState({ ...parent, paneExit: { status: 0 } })).toBe('idle');
    expect(app._mobileOverviewState({ ...parent, status: 'busy' })).toBe('working');
    expect(app._mobileOverviewState(parent, new Set(['idle_prompt']))).toBe('workflow');
    app.subagents.clear();
    expect(app._mobileOverviewState(parent, new Set(['idle_prompt']))).toBe('waiting');
  });

  it('returns to idle only when the last child completes and refreshes for each lifecycle event', async () => {
    const { app } = loadApp();
    const states: string[] = [];
    app.renderSessionTabs.mockImplementation(() => states.push(app._mobileOverviewState(parent)));
    app._onSubagentDiscovered({ ...child });
    app._onSubagentDiscovered({ ...child, agentId: 'second' });
    await app._onSubagentCompleted({ agentId: child.agentId });
    app._onSubagentUpdated({ agentId: 'second', status: 'idle' });
    await app._onSubagentCompleted({ agentId: 'second' });
    expect(states).toEqual(['workflow', 'workflow', 'workflow', 'workflow', 'idle']);
    app._onSubagentUpdated({ ...child });
    expect(states.at(-1)).toBe('workflow');
  });

  it('classifies reconnect snapshots without depending on discovery events or mutable app maps', () => {
    const { app } = loadApp();
    app.subagents.set(child.agentId, child);
    const withoutSnapshot = app.buildMobileOverviewModel({ sessions: [parent] });
    expect(withoutSnapshot.current[0].state).toBe('idle');
    const snapshot = app.buildMobileOverviewModel({ sessions: [parent], subagents: [child] });
    expect(snapshot.current[0].state).toBe('workflow');
  });

  it('sorts workflows ahead of idle, oldest unfinished start first, without repaint drift', () => {
    const { app, order } = loadApp();
    const early = Date.parse(child.startedAt);
    app.subagents.set('early', child);
    app.subagents.set('late', { ...child, startedAt: '2026-10-24T01:05:00Z' });
    expect(app._sessionWorkflowActivity(parent).at).toBe(early);
    app.subagents.get('early').lastActivityAt += 60_000;
    expect(app._sessionWorkflowActivity(parent).at).toBe(early);
    expect(
      order
        .sort([
          { id: 'idle', state: 'idle' },
          { id: 'late', state: 'workflow', workflowStartedAt: early + 1 },
          { id: 'early', state: 'workflow', workflowStartedAt: early },
          { id: 'main', state: 'working' },
        ])
        .map((row: any) => row.id)
    ).toEqual(['main', 'early', 'late', 'idle']);
    app.subagents.get('early').status = 'completed';
    expect(app._sessionWorkflowActivity(parent).at).toBe(Date.parse('2026-10-24T01:05:00Z'));
  });
});
