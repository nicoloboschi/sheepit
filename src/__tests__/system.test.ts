import { describe, it, expect } from 'vitest'
import { parsePs, parseVmStat, tagSessions, parseArgs, addDuLine } from '../system.js'

describe('parsePs', () => {
  it('keeps spaces in the command and names it by its last part', () => {
    const rows = parsePs('  412     1   3.5  204800 nico   /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n')
    expect(rows).toEqual([{ pid: 412, ppid: 1, cpu: 3.5, memMb: 200, user: 'nico', name: 'Google Chrome',
      path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', app: '/Applications/Google Chrome.app' }])
  })
  it('gives a helper deep in the bundle the outer app', () => {
    const [row] = parsePs('  9 1 0.0 1024 nico /Applications/Brave Browser.app/Contents/Frameworks/B.framework/Helpers/Brave Helper.app/Contents/MacOS/Brave Helper\n')
    expect(row!.app).toBe('/Applications/Brave Browser.app')
    expect(parsePs('  5 1 0.0 1024 root /usr/sbin/syslogd\n')[0]!.app).toBeUndefined()
  })
  it('skips lines that are not rows', () => {
    expect(parsePs('\ngarbage\n')).toEqual([])
  })
})

describe('parseVmStat', () => {
  it('counts active + wired + compressed pages', () => {
    const out = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 100.\nPages active: 10.\nPages wired down: 5.\nPages occupied by compressor: 1.\n'
    expect(parseVmStat(out)).toBe(16 * 16384)
  })
})

describe('tagSessions', () => {
  it('finds the pane a process descends from', () => {
    const p = (pid: number, ppid: number) => ({ pid, ppid, cpu: 0, memMb: 0, user: 'u', name: 'x', path: 'x' }) as any
    const procs = [p(10, 1), p(20, 10), p(30, 20), p(40, 1)]
    tagSessions(procs, new Map([[10, 'direct-1']]))
    expect(procs.map(x => x.sessionId)).toEqual(['direct-1', 'direct-1', 'direct-1', undefined])
  })
})

describe('parseArgs', () => {
  it('keeps the whole command line', () => {
    expect(parseArgs('  7 node /x/y.js --port 4445\n').get(7)).toBe('node /x/y.js --port 4445')
  })
})

describe('addDuLine', () => {
  it('keeps big folders under their parent, drops small ones, always keeps the root', () => {
    const s = { root: '/r', sizes: new Map<string, number>(), kids: new Map<string, string[]>() };
    addDuLine(s, '10\t/r/a/tiny');
    addDuLine(s, '2048\t/r/a');
    addDuLine(s, '4096\t/r/b c');
    addDuLine(s, '6200\t/r');
    expect(s.sizes.has('/r/a/tiny')).toBe(false);
    expect(s.kids.get('/r')).toEqual(['/r/a', '/r/b c']);
    expect(s.sizes.get('/r/b c')).toBe(4096 * 1024);
    expect(s.sizes.get('/r')).toBe(6200 * 1024);
  });
});
