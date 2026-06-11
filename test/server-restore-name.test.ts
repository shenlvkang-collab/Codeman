import { describe, expect, it } from 'vitest';
import { getRestoredSessionDisplayName } from '../src/web/server.js';

describe('getRestoredSessionDisplayName', () => {
  it('prefers a saved user-visible session name', () => {
    expect(
      getRestoredSessionDisplayName({
        savedName: 'w2-normal-use',
        muxDisplayName: 'codeman-abc12345',
        muxName: 'codeman-abc12345',
        workingDir: '/mnt/d/AI',
      })
    ).toBe('w2-normal-use');
  });

  it('does not expose internal codeman mux names as browser tab titles', () => {
    expect(
      getRestoredSessionDisplayName({
        savedName: '',
        muxDisplayName: '',
        muxName: 'codeman-abc12345',
        workingDir: '/mnt/d/AI/文档',
      })
    ).toBe('文档');
  });

  it('does not keep a previously persisted internal codeman name', () => {
    expect(
      getRestoredSessionDisplayName({
        savedName: 'codeman-00bf5d43',
        muxDisplayName: 'codeman-00bf5d43',
        muxName: 'codeman-00bf5d43',
        workingDir: '/mnt/d/AI/文档',
      })
    ).toBe('文档');
  });

  it('turns discovered Restored placeholders into readable folder names', () => {
    expect(
      getRestoredSessionDisplayName({
        muxDisplayName: 'Restored: codeman-abc12345',
        muxName: 'codeman-abc12345',
        workingDir: '/mnt/d/AI',
      })
    ).toBe('AI');
  });
});
