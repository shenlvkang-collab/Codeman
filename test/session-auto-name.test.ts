import { describe, expect, it } from 'vitest';
import { Session } from '../src/session.js';
import { deriveAutoSessionName, SubmittedPromptTracker } from '../src/session-auto-name.js';

describe('automatic session names', () => {
  it('derives a short local title and ignores slash commands', () => {
    expect(deriveAutoSessionName('  修复登录跳转问题。\n不要改数据库')).toBe('修复登录跳转问题。');
    expect(deriveAutoSessionName('/clear')).toBeNull();
    expect(Array.from(deriveAutoSessionName('a'.repeat(200)) ?? '')).toHaveLength(72);
  });

  it('tracks chunked typing and terminal editing until Enter', () => {
    const tracker = new SubmittedPromptTracker();
    expect(tracker.feed('修复登')).toEqual([]);
    expect(tracker.feed('录跳转\x7f问题\r')).toEqual(['修复登录跳问题']);
    expect(tracker.feed('旧内容\x1b[A新内容\r')).toEqual(['新内容']);
  });

  it('does not overwrite an explicitly named session', () => {
    const generated = new Session({ workingDir: '/tmp', name: 'w1-demo' });
    expect(generated.nameSource).toBe('auto');
    expect(generated.applyAutoName('修复登录')).toBe(true);

    const manual = new Session({ workingDir: '/tmp', name: '我的工作窗口' });
    expect(manual.nameSource).toBe('manual');
    expect(manual.applyAutoName('不应覆盖')).toBe(false);
  });
});
