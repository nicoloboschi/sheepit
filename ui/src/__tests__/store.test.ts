import { describe, it, expect, beforeEach, vi } from 'vitest'
import useStore, {
  assignFields, pensInField, readPersistedWorkspaces, writeWorkspaces, DEFAULT_FIELD_ID,
} from '../store'
import { preferences } from '../preferences'
import type { Session, Workspace } from '../store'

const makeSession = (id: string, name: string, path = '/tmp', gitRoot?: string): Session => ({
  id,
  name,
  path,
  gitRoot,
  username: 'test',
  last_activity: Date.now(),
})

describe('useStore', () => {
  beforeEach(() => {
    // Reset store to initial state
    useStore.setState({
      sessions: [],
      currentSessionId: null,
      sessionBusy: {},
      sessionHasUnseen: {},
      sessionNeedsAttention: {},
      sessionLastEvent: {},
      sessionOrder: [],
      sessionMap: {},
      workspaces: {},
      workspaceOrder: [],
      fields: {},
      fieldOrder: [],
      selectedFieldId: null,
      workspaceZooms: {},
      wsStatus: 'connecting',
      sheetOpen: false,
      confirm: null,
    })
  })

  describe('setWsStatus', () => {
    it('updates ws status', () => {
      useStore.getState().setWsStatus('connected')
      expect(useStore.getState().wsStatus).toBe('connected')
    })
  })

  describe('setSheetOpen', () => {
    it('toggles sheet state', () => {
      useStore.getState().setSheetOpen(true)
      expect(useStore.getState().sheetOpen).toBe(true)

      useStore.getState().setSheetOpen(false)
      expect(useStore.getState().sheetOpen).toBe(false)
    })
  })

  describe('renderSessions', () => {
    it('is a no-op when the session list is unchanged', () => {
      // The server re-publishes this list every 2 seconds. Writing state anyway
      // re-rendered the whole sidebar and re-serialised every workspace to
      // localStorage on a timer, which showed up as periodic 50–124ms
      // main-thread stalls in the browser with the app sitting idle.
      // Pin last_activity: makeSession stamps Date.now(), and two calls a
      // millisecond apart are genuinely different sessions as far as the store
      // is concerned — which would make this assert nothing.
      const at = 1_700_000_000_000
      const list = () => [
        { ...makeSession('$0', 'shell'), last_activity: at },
        { ...makeSession('$1', 'dev'), last_activity: at },
      ]
      useStore.getState().renderSessions(list())
      const first = useStore.getState()

      useStore.getState().renderSessions(list())
      const second = useStore.getState()

      // Same references — nothing downstream has any reason to re-render.
      expect(second.sessions).toBe(first.sessions)
      expect(second.workspaces).toBe(first.workspaces)
      expect(second.workspaceOrder).toBe(first.workspaceOrder)
      expect(second.sessionMap).toBe(first.sessionMap)
    })

    it('keeps the object of every session that did not change', () => {
      // Identity is what every selector downstream reads. One pane moving must
      // re-render that pane, not the whole flock: this used to be
      // all-or-nothing, so a single `last_activity` rebuilt all 54 session
      // objects and every component selecting `sessionMap[id]` re-rendered on a
      // 2-second timer.
      const at = 1_700_000_000_000
      const list = (branch = 'main') => [
        { ...makeSession('$0', 'shell'), last_activity: at },
        { ...makeSession('$1', 'dev'), last_activity: at, gitBranch: branch },
        { ...makeSession('$2', 'test'), last_activity: at },
      ]
      useStore.getState().renderSessions(list())
      const before = useStore.getState().sessionMap

      // Only $1 moved. (A branch, not `last_activity` — that one deliberately
      // does not invalidate identity; see `sameSession`.)
      useStore.getState().renderSessions(list('feature'))
      const after = useStore.getState().sessionMap

      expect(after['$1']).not.toBe(before['$1'])
      expect(after['$1']!.gitBranch).toBe('feature')
      // The two that did not move keep the objects they had.
      expect(after['$0']).toBe(before['$0'])
      expect(after['$2']).toBe(before['$2'])
    })

    it('still updates when a session actually changes', () => {
      useStore.getState().renderSessions([makeSession('$0', 'shell')])
      const before = useStore.getState().sessions

      // A rendered field, deliberately. This used to assert on `cpuPercent`,
      // which is no longer an identity signal at all — see below.
      const renamed = { ...makeSession('$0', 'shell'), name: 'renamed' }
      useStore.getState().renderSessions([renamed])
      const after = useStore.getState()

      expect(after.sessions).not.toBe(before)
      expect(after.sessions[0]!.name).toBe('renamed')
    })

    it('keeps identity when only cpu or memory moved', () => {
      useStore.getState().renderSessions([{ ...makeSession('$0', 'shell'), cpuPercent: 1, memMb: 10 }])
      const before = useStore.getState().sessionMap['$0']

      // These move every sweep for any busy process. Comparing them invalidated
      // 38 of 55 sessions every two seconds and re-rendered every pane card,
      // for two numbers nothing in the UI displays. If this test fails because
      // someone put them back in `sameSession`, read the comment there first.
      useStore.getState().renderSessions([{ ...makeSession('$0', 'shell'), cpuPercent: 99, memMb: 512 }])

      expect(useStore.getState().sessionMap['$0']).toBe(before)
    })

    it('still updates when a session appears or disappears', () => {
      useStore.getState().renderSessions([makeSession('$0', 'shell')])
      const before = useStore.getState().workspaces

      useStore.getState().renderSessions([makeSession('$0', 'shell'), makeSession('$1', 'new')])
      expect(useStore.getState().workspaces).not.toBe(before)
      expect(Object.keys(useStore.getState().workspaces)).toHaveLength(2)

      useStore.getState().renderSessions([makeSession('$0', 'shell')])
      expect(Object.keys(useStore.getState().workspaces)).toHaveLength(1)
    })

    it('keeps the identity of workspaces it did not touch', () => {
      useStore.getState().renderSessions([makeSession('$0', 'a'), makeSession('$1', 'b')])
      const { workspaceOrder, workspaces } = useStore.getState()
      const untouched = workspaceOrder[0]!
      const untouchedWs = workspaces[untouched]

      // A third session arrives: the other workspaces must not be rebuilt.
      useStore.getState().renderSessions([makeSession('$0', 'a'), makeSession('$1', 'b'), makeSession('$2', 'c')])
      expect(useStore.getState().workspaces[untouched]).toBe(untouchedWs)
    })

    it('stores sessions and builds sessionMap', () => {
      const sessions = [makeSession('$0', 'shell'), makeSession('$1', 'dev')]
      useStore.getState().renderSessions(sessions)

      const state = useStore.getState()
      expect(state.sessions).toHaveLength(2)
      expect(state.sessionMap['$0']).toBeDefined()
      expect(state.sessionMap['$0']!.name).toBe('shell')
      expect(state.sessionMap['$1']!.name).toBe('dev')
    })

    it('keeps a headless session live in state without creating a workspace for it', () => {
      const headless = { ...makeSession('$headless', 'background'), isHeadless: true }
      useStore.getState().renderSessions([makeSession('$0', 'shell'), headless])

      const state = useStore.getState()
      expect(state.sessions).toHaveLength(2)
      expect(state.sessionMap.$headless?.isHeadless).toBe(true)
      expect(state.workspaceOrder).toHaveLength(1)
      expect(state.workspaces[state.workspaceOrder[0]!]!.cells).toEqual(['$0'])
    })

    it('builds sessionOrder sorted by id', () => {
      const sessions = [makeSession('$2', 'c'), makeSession('$0', 'a'), makeSession('$1', 'b')]
      useStore.getState().renderSessions(sessions)

      const { sessionOrder } = useStore.getState()
      expect(sessionOrder).toEqual(['$0', '$1', '$2'])
    })
  })

  describe('setCurrentSessionId', () => {
    it('sets current session', () => {
      useStore.getState().setCurrentSessionId('$0')
      expect(useStore.getState().currentSessionId).toBe('$0')
    })

    // Read means typed into, not selected — see clearUnseen in TerminalCell.
    it('keeps unseen and bleating when switching to session', () => {
      useStore.getState().sessionAttention('$0', 'Waiting for input')
      useStore.getState().setCurrentSessionId('$0')
      expect(useStore.getState().sessionHasUnseen['$0']).toBe(true)
      expect(useStore.getState().sessionNeedsAttention['$0']).toBe(true)

      useStore.getState().clearUnseen('$0')
      expect(useStore.getState().sessionHasUnseen['$0']).toBeUndefined()
      expect(useStore.getState().sessionNeedsAttention['$0']).toBeUndefined()
    })
  })

  describe('updateActivity', () => {
    it('marks unseen and notifies when a background session finishes', () => {
      useStore.getState().setCurrentSessionId('$1')
      useStore.setState({ sessionBusy: { $0: true } })
      useStore.getState().updateActivity('$0', false)

      expect(useStore.getState().sessionBusy['$0']).toBe(false)
      expect(useStore.getState().sessionHasUnseen['$0']).toBe(true)
    })

    it('leaves the active session alone when it finishes — you are looking at it', () => {
      useStore.getState().setCurrentSessionId('$0')
      useStore.setState({ sessionBusy: { $0: true } })
      useStore.getState().updateActivity('$0', false)

      expect(useStore.getState().sessionHasUnseen['$0']).toBeUndefined()
    })

    it('clears a pending attention request when work resumes', () => {
      useStore.getState().sessionAttention('$0', 'Waiting for input')
      useStore.getState().updateActivity('$0', true)

      expect(useStore.getState().sessionNeedsAttention['$0']).toBeUndefined()
    })
  })

  // Folding a pen is a display choice about the sidebar list, not about the
  // workspace: it must not move, close or reorder anything.
  describe('folding a pen', () => {
    beforeEach(() => {
      useStore.getState().renderSessions([makeSession('$0', 'a'), makeSession('$1', 'b')])
    })

    it('folds and opens the same pen', () => {
      const id = useStore.getState().workspaceOrder[0]!
      expect(useStore.getState().workspaces[id]!.collapsed).toBeFalsy()

      useStore.getState().toggleWorkspaceCollapsed(id)
      expect(useStore.getState().workspaces[id]!.collapsed).toBe(true)

      useStore.getState().toggleWorkspaceCollapsed(id)
      expect(useStore.getState().workspaces[id]!.collapsed).toBe(false)
    })

    it('leaves every other pen, and the order, alone', () => {
      const [first, second] = useStore.getState().workspaceOrder
      const before = useStore.getState().workspaces[second!]
      const orderBefore = useStore.getState().workspaceOrder

      useStore.getState().toggleWorkspaceCollapsed(first!)

      expect(useStore.getState().workspaces[second!]).toBe(before)
      expect(useStore.getState().workspaceOrder).toEqual(orderBefore)
    })

    it('keeps the panes — folding closes nothing', () => {
      const id = useStore.getState().workspaceOrder[0]!
      const { cells, activeCell } = useStore.getState().workspaces[id]!
      useStore.getState().toggleWorkspaceCollapsed(id)
      expect(useStore.getState().workspaces[id]).toMatchObject({ cells, activeCell })
    })

    it('does nothing for a workspace that does not exist', () => {
      const before = useStore.getState().workspaces
      useStore.getState().toggleWorkspaceCollapsed('nope')
      expect(useStore.getState().workspaces).toBe(before)
    })
  })

// A field is the ground several pens share — one level above a pen, one below
// the flock. Membership lives on the pen, so there is exactly one list of pens
// and no second ordering to drift out of step with it.
describe('fields', () => {
  const ws = (id: string, cells: string[], fieldId?: string): Workspace =>
    ({ id, cells, activeCell: 0, ...(fieldId ? { fieldId } : {}) })

  describe('assignFields', () => {
    // One field to begin with, holding everything. An earlier cut derived a
    // field per repository from gitRoot; a grouping you did not ask for is one
    // you then have to undo.
    it('puts every pen in one field to start with', () => {
      const out = assignFields({ a: ws('a', ['$0']), b: ws('b', ['$1']) }, ['a', 'b'], {}, [])
      expect(out.workspaces.a!.fieldId).toBe(DEFAULT_FIELD_ID)
      expect(out.workspaces.b!.fieldId).toBe(DEFAULT_FIELD_ID)
      expect(out.fieldOrder).toEqual([DEFAULT_FIELD_ID])
    })

    it('leaves a pen that already has a field where it is', () => {
      const fields = { f1: { id: 'f1', name: 'one' } }
      const out = assignFields({ a: ws('a', ['$0'], 'f1') }, ['a'], fields, ['f1'])
      expect(out.workspaces.a!.fieldId).toBe('f1')
      expect(out.fieldOrder).toEqual(['f1'])
    })

    // A pen whose field was deleted out from under it is homeless in exactly
    // the same way as one that never had a field.
    it('rehomes a pen whose field has gone', () => {
      const out = assignFields({ a: ws('a', ['$0'], 'deleted') }, ['a'], {}, [])
      expect(out.workspaces.a!.fieldId).toBe(DEFAULT_FIELD_ID)
    })

    // It runs every two seconds against every pen, so an unchanged sweep has
    // to be free — the caller compares by identity and skips the write.
    it('returns what it was given when there is nothing to place', () => {
      const workspaces = { a: ws('a', ['$0'], 'f1') }
      const fields = { f1: { id: 'f1', name: 'x' } }
      const out = assignFields(workspaces, ['a'], fields, ['f1'])
      expect(out.workspaces).toBe(workspaces)
      expect(out.fields).toBe(fields)
    })

    it('is the migration: a pen saved before fields existed just has none', () => {
      const out = assignFields({ a: ws('a', ['$0']) }, ['a'], {}, [])
      expect(out.workspaces.a!.fieldId).toBeTruthy()
    })
  })

  describe('membership and order', () => {
    beforeEach(() => {
      useStore.setState({
        workspaces: { a: ws('a', ['$0'], 'f1'), b: ws('b', ['$1'], 'f1'), c: ws('c', ['$2'], 'f2') },
        workspaceOrder: ['a', 'b', 'c'],
        fields: { f1: { id: 'f1', name: 'one' }, f2: { id: 'f2', name: 'two' } },
        fieldOrder: ['f1', 'f2'],
      })
    })

    it('reads the pens of a field off the one list of pens', () => {
      const { workspaces, workspaceOrder } = useStore.getState()
      expect(pensInField('f1', workspaces, workspaceOrder)).toEqual(['a', 'b'])
      expect(pensInField('f2', workspaces, workspaceOrder)).toEqual(['c'])
    })

    // Membership and position are one move: a pen that changed field but not
    // position would draw itself among pens it no longer belongs to.
    it('moves a pen into a field and positions it there', () => {
      useStore.getState().moveWorkspaceToField('a', 'f2')
      const { workspaces, workspaceOrder } = useStore.getState()
      expect(workspaces.a!.fieldId).toBe('f2')
      expect(pensInField('f2', workspaces, workspaceOrder)).toEqual(['c', 'a'])
      expect(pensInField('f1', workspaces, workspaceOrder)).toEqual(['b'])
    })

    it('drops a pen in front of the one it was dropped on', () => {
      useStore.getState().moveWorkspaceToField('a', 'f2', 'c')
      const { workspaces, workspaceOrder } = useStore.getState()
      expect(pensInField('f2', workspaces, workspaceOrder)).toEqual(['a', 'c'])
    })

    // Deleting a field must never close a pen. Losing work to a tidy-up is
    // the worst possible reading of "delete".
    it('sends the pens of a deleted field to the default one', () => {
      useStore.getState().deleteField('f1')
      const { workspaces, workspaceOrder, fields, fieldOrder } = useStore.getState()
      expect(fields.f1).toBeUndefined()
      expect(fieldOrder).not.toContain('f1')
      expect(Object.keys(workspaces).sort()).toEqual(['a', 'b', 'c'])
      expect(pensInField(DEFAULT_FIELD_ID, workspaces, workspaceOrder)).toEqual(['a', 'b'])
    })

    it('renames and folds a field', () => {
      useStore.getState().renameField('f1', '  hindsight  ')
      expect(useStore.getState().fields.f1!.name).toBe('hindsight')

      useStore.getState().toggleFieldCollapsed('f1')
      expect(useStore.getState().fields.f1!.collapsed).toBe(true)
    })

    it('reorders fields', () => {
      useStore.getState().reorderFields('f2', 0)
      expect(useStore.getState().fieldOrder).toEqual(['f2', 'f1'])
    })

    // The sidebar shows one field, so the active pen must be in it: a jump
    // from ⌘K or from a bleating sheep can cross fields, and landing on a pane
    // the list is not showing is how you lose track of where you are.
    it('pulls the sidebar to the field of the pen you select', () => {
      useStore.getState().setSelectedField('f1')
      useStore.getState().setCurrentSessionId('c')
      expect(useStore.getState().selectedFieldId).toBe('f2')
    })

    it('leaves the selection alone when the pen is already in view', () => {
      useStore.getState().setSelectedField('f1')
      useStore.getState().setCurrentSessionId('b')
      expect(useStore.getState().selectedFieldId).toBe('f1')
    })

    // The URL carries the field (see buildHash in App.tsx), so two tabs can
    // stand in two fields at once. A localStorage key could not say that — the
    // second tab would drag the first.
    it('does not persist the shown field itself', () => {
      useStore.getState().setSelectedField('f2')
      expect(useStore.getState().selectedFieldId).toBe('f2')
      // Nothing written: the URL is the only home for this.
      expect(localStorage.getItem('sheepit:selected-field')).toBeNull()
    })

    // ⌘↑/↓ has to walk the screen, not the store's own order.
    it('navigates in field order, not workspace order', () => {
      useStore.setState({ currentSessionId: 'c' })
      useStore.getState().reorderFields('f2', 0)   // f2 (c) now above f1 (a, b)
      expect(useStore.getState().navigateSession('down')).toMatchObject({ workspaceId: 'a' })
    })
  })
})

  describe('unseen tracking', () => {
    it('marks and clears unseen', () => {
      useStore.getState().markUnseen('$0')
      expect(useStore.getState().sessionHasUnseen['$0']).toBe(true)

      useStore.getState().clearUnseen('$0')
      // clearUnseen deletes the key
      expect(useStore.getState().sessionHasUnseen['$0']).toBeUndefined()
    })

    it('does not mark current session as unseen', () => {
      useStore.getState().setCurrentSessionId('$0')
      useStore.getState().markUnseen('$0')
      expect(useStore.getState().sessionHasUnseen['$0']).toBeUndefined()
    })
  })

  describe('attention tracking', () => {
    it('marks an explicit attention request and clears it when typed into', () => {
      useStore.getState().sessionAttention('$0', 'Waiting for input')
      expect(useStore.getState().sessionNeedsAttention['$0']).toBe(true)

      useStore.getState().clearUnseen('$0')
      expect(useStore.getState().sessionNeedsAttention['$0']).toBeUndefined()
    })
  })

  describe('busy flags', () => {
    it('writes every pane that went busy together in one update', async () => {
      // Agents start work together, so their 2200ms timers fire together. Each
      // one writing on its own meant N full store writes and N full React
      // commits in a row — measured as a 412ms frame.
      vi.useFakeTimers()
      try {
        const store = useStore.getState()
        store.renderSessions([makeSession('$0', 'a'), makeSession('$1', 'b'), makeSession('$2', 'c')])

        let writes = 0
        const unsub = useStore.subscribe(() => { writes++ })
        store.updateActivity('$0', true)
        store.updateActivity('$1', true)
        store.updateActivity('$2', true)
        vi.advanceTimersByTime(2200)   // the per-pane timers
        vi.advanceTimersByTime(1)      // the shared flush
        unsub()

        const busy = useStore.getState().sessionBusy
        expect([busy['$0'], busy['$1'], busy['$2']]).toEqual([true, true, true])
        expect(writes).toBe(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not mark a pane busy that finished while the flush was pending', () => {
      vi.useFakeTimers()
      try {
        const store = useStore.getState()
        store.renderSessions([makeSession('$0', 'a')])
        store.updateActivity('$0', true)
        vi.advanceTimersByTime(2200)   // timer fired; the flush has not run yet
        store.updateActivity('$0', false)
        vi.advanceTimersByTime(1)
        expect(useStore.getState().sessionBusy['$0']).not.toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('workspaces', () => {
    it('createWorkspace mints a synthetic id and stores the cells', () => {
      const id = useStore.getState().createWorkspace(['$0'])
      expect(id).toMatch(/^ws-/)
      const ws = useStore.getState().workspaces[id]
      expect(ws).toBeDefined()
      expect(ws!.cells).toEqual(['$0'])
      expect(ws!.activeCell).toBe(0)
      expect(useStore.getState().workspaceOrder).toContain(id)
    })

    it('appendPaneToWorkspace grows cells and shows the new pane', () => {
      const id = useStore.getState().createWorkspace(['$0'])
      useStore.getState().appendPaneToWorkspace(id, '$1')
      const ws = useStore.getState().workspaces[id]!
      expect(ws.cells).toEqual(['$0', '$1'])
      expect(ws.activeCell).toBe(1) // shows the newly-added pane
    })

    // A pen holds as many sheep as you like: the old cap of four was the size
    // of a 2x2 grid, and there is no grid left to be the size of.
    it('a pen takes more sheep than the old four', () => {
      const id = useStore.getState().createWorkspace(['$0'])
      for (const sid of ['$1', '$2', '$3', '$4', '$5']) {
        useStore.getState().appendPaneToWorkspace(id, sid)
      }
      expect(useStore.getState().workspaces[id]!.cells).toHaveLength(6)
      expect(useStore.getState().workspaces[id]!.activeCell).toBe(5)
    })

    it('removePaneFromWorkspace preserves the shown pane', () => {
      const id = useStore.getState().createWorkspace(['$0', '$1', '$2', '$3'])
      useStore.getState().setActivePane(id, 2)
      const survivorId = useStore.getState().removePaneFromWorkspace(id, 1)
      expect(survivorId).toBe(id)
      const ws = useStore.getState().workspaces[id]!
      expect(ws.cells).toEqual(['$0', '$2', '$3'])
      // The shown pane was $2 (index 2). $1 went, so $2 is now at index 1.
      expect(ws.activeCell).toBe(1)
    })

    it('removePaneFromWorkspace deletes the workspace when the last pane leaves', () => {
      const id = useStore.getState().createWorkspace(['$0'])
      const survivorId = useStore.getState().removePaneFromWorkspace(id, 0)
      expect(survivorId).toBeNull()
      expect(useStore.getState().workspaces[id]).toBeUndefined()
      expect(useStore.getState().workspaceOrder).not.toContain(id)
    })

    it('movePaneBetweenWorkspaces moves a pane and shrinks the source', () => {
      const a = useStore.getState().createWorkspace(['$0', '$1'])
      const b = useStore.getState().createWorkspace(['$2'])
      const ok = useStore.getState().movePaneBetweenWorkspaces({
        sourceId: a, sourceIdx: 1, targetId: b,
      })
      expect(ok).toBe(true)
      expect(useStore.getState().workspaces[a]!.cells).toEqual(['$0'])
      expect(useStore.getState().workspaces[b]!.cells).toEqual(['$2', '$1'])
      expect(useStore.getState().workspaces[b]!.activeCell).toBe(1) // the moved pane is shown
    })

    it('extractPaneToNewWorkspace empties a pen without stranding a pane', () => {
      // Taking every sheep but one out of a pen, one at a time. A pane that
      // left `cells` without landing in another pen would keep its PTY alive,
      // hidden from the sidebar, with no way to close it.
      const id = useStore.getState().createWorkspace(['$0', '$1', '$2', '$3'])
      const insertAt = useStore.getState().workspaceOrder.indexOf(id) + 1
      for (let i = 3; i >= 1; i--) {
        useStore.getState().extractPaneToNewWorkspace({ sourceId: id, sourceIdx: i, insertAt })
      }
      const ws = useStore.getState().workspaces[id]!
      expect(ws.cells).toEqual(['$0'])

      // Each evicted pane owns exactly one workspace — nothing stranded.
      const all = useStore.getState().workspaceOrder
        .flatMap(wid => useStore.getState().workspaces[wid]!.cells)
      expect(all.sort()).toEqual(['$0', '$1', '$2', '$3'])
      // …and they sit next to the workspace they came from, not at the end.
      expect(useStore.getState().workspaceOrder.indexOf(id)).toBe(insertAt - 1)
    })

    it('movePaneBetweenWorkspaces allows moving cell 0 (no more root restriction)', () => {
      const a = useStore.getState().createWorkspace(['$0', '$1'])
      const b = useStore.getState().createWorkspace(['$2'])
      const ok = useStore.getState().movePaneBetweenWorkspaces({
        sourceId: a, sourceIdx: 0, targetId: b,
      })
      expect(ok).toBe(true)
      // Source still has $1, promoted to cell 0
      expect(useStore.getState().workspaces[a]!.cells).toEqual(['$1'])
      // Target gained $0
      expect(useStore.getState().workspaces[b]!.cells).toEqual(['$2', '$0'])
    })

    it('movePaneBetweenWorkspaces dissolves the source when it empties', () => {
      const a = useStore.getState().createWorkspace(['$0'])
      const b = useStore.getState().createWorkspace(['$1'])
      useStore.getState().setCurrentSessionId(a)
      const ok = useStore.getState().movePaneBetweenWorkspaces({
        sourceId: a, sourceIdx: 0, targetId: b,
      })
      expect(ok).toBe(true)
      // Source workspace is gone (Android folder dissolved)
      expect(useStore.getState().workspaces[a]).toBeUndefined()
      // Target has both panes
      expect(useStore.getState().workspaces[b]!.cells).toEqual(['$1', '$0'])
      // Selection jumped to the target since the user was viewing the source
      expect(useStore.getState().currentSessionId).toBe(b)
    })

    // There is no "full" any more: the cap of four was the size of a 2x2
    // grid, and a pen with no grid in it has no size to be.
    it('movePaneBetweenWorkspaces accepts a pen that already holds four', () => {
      const a = useStore.getState().createWorkspace(['$0'])
      const b = useStore.getState().createWorkspace(['$1', '$2', '$3', '$4'])
      const ok = useStore.getState().movePaneBetweenWorkspaces({
        sourceId: a, sourceIdx: 0, targetId: b,
      })
      expect(ok).toBe(true)
      expect(useStore.getState().workspaces[a]).toBeUndefined()
      expect(useStore.getState().workspaces[b]!.cells).toEqual(['$1', '$2', '$3', '$4', '$0'])
    })
  })

  describe('renderSessions reconciliation', () => {
    it('wraps fresh sessions in single-pane workspaces', () => {
      useStore.getState().renderSessions([
        makeSession('$0', 'a'),
        makeSession('$1', 'b'),
      ])
      const { workspaces, workspaceOrder } = useStore.getState()
      expect(workspaceOrder).toHaveLength(2)
      const ids = workspaceOrder.map(id => workspaces[id]!.cells[0])
      expect(ids).toEqual(expect.arrayContaining(['$0', '$1']))
    })

    it('prunes dead sessions and deletes empty workspaces', () => {
      const id = useStore.getState().createWorkspace(['$0', '$1'])
      useStore.getState().renderSessions([makeSession('$0', 'a')])
      // $1 is gone — the pen keeps $0 only
      const ws = useStore.getState().workspaces[id]!
      expect(ws.cells).toEqual(['$0'])

      // Now $0 vanishes too — workspace should be deleted entirely
      useStore.getState().renderSessions([])
      expect(useStore.getState().workspaces[id]).toBeUndefined()
    })

    it('preserves existing workspaces across a session refresh', () => {
      const id = useStore.getState().createWorkspace(['$0', '$1'])
      useStore.getState().renderSessions([
        makeSession('$0', 'a'),
        makeSession('$1', 'b'),
      ])
      // Workspace shape is unchanged
      const ws = useStore.getState().workspaces[id]!
      expect(ws.cells).toEqual(['$0', '$1'])
      // And no bonus workspace was minted for $0 or $1
      expect(useStore.getState().workspaceOrder).toEqual([id])
    })
  })

  describe('confirm dialog', () => {
    it('showConfirm sets confirm state', async () => {
      const promise = useStore.getState().showConfirm('Delete session?')

      const { confirm } = useStore.getState()
      const c = confirm
      expect(c).not.toBeNull()
      expect(c!.message).toBe('Delete session?')

      // Resolve it
      useStore.getState().dismissConfirm(true)
      const result = await promise
      expect(result).toBe(true)
    })

    it('dismissConfirm with false rejects', async () => {
      const promise = useStore.getState().showConfirm('Are you sure?')
      useStore.getState().dismissConfirm(false)
      const result = await promise
      expect(result).toBe(false)
    })

    it('dismissConfirm clears confirm state', () => {
      useStore.getState().showConfirm('test')
      useStore.getState().dismissConfirm(true)
      expect(useStore.getState().confirm).toBeNull()
    })
  })

  describe('navigateSession', () => {
    it('returns null when no sessions', () => {
      const result = useStore.getState().navigateSession('down')
      expect(result).toBeNull()
    })

    it('returns null when only one workspace exists', () => {
      useStore.getState().renderSessions([makeSession('$0', 'a')])
      // Exactly one workspace was auto-minted — nowhere to navigate to.
      expect(useStore.getState().navigateSession('down')).toBeNull()
    })

    it('walks forward across workspaces in order', () => {
      useStore.getState().renderSessions([
        makeSession('$0', 'a'),
        makeSession('$1', 'b'),
      ])
      const [firstId, secondId] = useStore.getState().workspaceOrder
      useStore.getState().setCurrentSessionId(firstId!)
      const next = useStore.getState().navigateSession('down')
      expect(next?.workspaceId).toBe(secondId)
    })

    it('walks into each pane of a multi-pane workspace', () => {
      const id = useStore.getState().createWorkspace(['$0', '$1'])
      useStore.getState().createWorkspace(['$2'])
      useStore.getState().setCurrentSessionId(id)
      // First call from cell 0 should land on cell 1 of the same workspace.
      const next = useStore.getState().navigateSession('down')
      expect(next?.workspaceId).toBe(id)
      expect(next?.paneIndex).toBe(1)
    })
  })
})

// The sidebar is one preference key per pen, not one blob holding all of them.
// A blob is written whole from a snapshot read at startup, so two browsers each
// restated every pen on every save and the last one to write won — which is how
// a pen came to stand in one field in one browser and another field in the next.
describe('workspace persistence', () => {
  const pen = (id: string, fieldId?: string): Workspace =>
    ({ id, cells: ['$' + id], activeCell: 0, ...(fieldId ? { fieldId } : {}) })

  const fields = { [DEFAULT_FIELD_ID]: { id: DEFAULT_FIELD_ID, name: 'All pens' } }

  beforeEach(() => {
    for (const key of preferences.keys('sheepit:')) preferences.removeItem(key)
    // Clear the snapshot the diff is taken against, too.
    readPersistedWorkspaces()
  })

  it('writes one key per pen, plus the flock shape', () => {
    writeWorkspaces({ a: pen('a'), b: pen('b') }, ['a', 'b'], fields, [DEFAULT_FIELD_ID])
    expect(preferences.keys('sheepit:pen:').sort()).toEqual(['sheepit:pen:a', 'sheepit:pen:b'])
    expect(JSON.parse(preferences.getItem('sheepit:flock')!).order).toEqual(['a', 'b'])
  })

  // The whole point: a tab that changes one pen speaks for that pen alone, so a
  // second tab's idea of every other pen cannot ride along and undo an edit.
  it('re-sends only the pen that moved', () => {
    writeWorkspaces({ a: pen('a'), b: pen('b') }, ['a', 'b'], fields, [DEFAULT_FIELD_ID])
    const write = vi.spyOn(preferences, 'setItem')
    writeWorkspaces({ a: pen('a'), b: pen('b', 'f2') }, ['a', 'b'], fields, [DEFAULT_FIELD_ID])
    expect(write.mock.calls.map(c => c[0])).toEqual(['sheepit:pen:b'])
    write.mockRestore()
  })

  it('writes nothing at all when nothing changed', () => {
    writeWorkspaces({ a: pen('a') }, ['a'], fields, [DEFAULT_FIELD_ID])
    const write = vi.spyOn(preferences, 'setItem')
    writeWorkspaces({ a: pen('a') }, ['a'], fields, [DEFAULT_FIELD_ID])
    expect(write).not.toHaveBeenCalled()
    write.mockRestore()
  })

  it('removes the key of a pen that has been closed', () => {
    writeWorkspaces({ a: pen('a'), b: pen('b') }, ['a', 'b'], fields, [DEFAULT_FIELD_ID])
    writeWorkspaces({ a: pen('a') }, ['a'], fields, [DEFAULT_FIELD_ID], ['b'])
    expect(preferences.keys('sheepit:pen:')).toEqual(['sheepit:pen:a'])
  })

  // The incident: a client mid-reconnect reconciled the session list against an
  // empty pen map and saved it. Absence alone must never delete, or that one
  // tab takes every other tab's pens with it.
  it('keeps pens the caller never mentioned', () => {
    writeWorkspaces({ a: pen('a'), b: pen('b') }, ['a', 'b'], fields, [DEFAULT_FIELD_ID])
    writeWorkspaces({}, [], fields, [DEFAULT_FIELD_ID])
    expect(preferences.keys('sheepit:pen:').sort()).toEqual(['sheepit:pen:a', 'sheepit:pen:b'])
  })

  // A pen named as removed but still in the map was re-added in the same tick.
  it('does not remove a pen that is still in the map', () => {
    writeWorkspaces({ a: pen('a') }, ['a'], fields, [DEFAULT_FIELD_ID])
    writeWorkspaces({ a: pen('a') }, ['a'], fields, [DEFAULT_FIELD_ID], ['a'])
    expect(preferences.keys('sheepit:pen:')).toEqual(['sheepit:pen:a'])
  })

  it('reads back what it wrote', () => {
    writeWorkspaces({ a: pen('a', 'f2'), b: pen('b') }, ['b', 'a'], fields, [DEFAULT_FIELD_ID])
    const back = readPersistedWorkspaces()!
    expect(back.order).toEqual(['b', 'a'])
    expect(back.workspaces.a!.fieldId).toBe('f2')
    expect(back.fields).toEqual(fields)
  })

  // A pen the order has not heard of was made by another client while this list
  // was being written. Dropping it would lose a sidebar row outright.
  it('keeps a pen that is missing from the order', () => {
    writeWorkspaces({ a: pen('a') }, ['a'], fields, [DEFAULT_FIELD_ID])
    preferences.setItem('sheepit:pen:c', JSON.stringify(pen('c')))
    const back = readPersistedWorkspaces()!
    expect(back.order).toEqual(['a', 'c'])
  })

  it('has nothing to say about a profile with no pens in it', () => {
    expect(readPersistedWorkspaces()).toBeNull()
  })
})

// Two clients can both notice an unclaimed session and both make a pen for it.
// The whole-blob write used to hide that by erasing one client's pens wholesale;
// per-pen keys keep both, and the same sheep would stand in the flock twice.
describe('duplicate pens', () => {
  const pen = (id: string, cells: string[]): Workspace =>
    ({ id, cells, activeCell: 0, fieldId: DEFAULT_FIELD_ID })
  const fields = { [DEFAULT_FIELD_ID]: { id: DEFAULT_FIELD_ID, name: 'All pens' } }

  beforeEach(() => {
    for (const key of preferences.keys('sheepit:')) preferences.removeItem(key)
    readPersistedWorkspaces()
  })

  // The pen somebody built beats the one the sweep made for them.
  it('keeps the bigger pen and drops the single that duplicates it', () => {
    writeWorkspaces({
      grid: pen('grid', ['s1', 's2']),
      auto1: pen('auto1', ['s1']),
      auto2: pen('auto2', ['s2']),
    }, ['auto1', 'auto2', 'grid'], fields, [DEFAULT_FIELD_ID])

    const back = readPersistedWorkspaces()!
    expect(Object.keys(back.workspaces)).toEqual(['grid'])
    expect(back.workspaces.grid!.cells).toEqual(['s1', 's2'])
    expect(back.order).toEqual(['grid'])
  })

  it('takes the duplicates off the profile instead of re-reading them for ever', () => {
    writeWorkspaces({
      grid: pen('grid', ['s1', 's2']),
      auto1: pen('auto1', ['s1']),
    }, ['auto1', 'grid'], fields, [DEFAULT_FIELD_ID])
    readPersistedWorkspaces()
    expect(preferences.keys('sheepit:pen:')).toEqual(['sheepit:pen:grid'])
  })

  // Ties go to the shared order, so every client discards the same pen without
  // having to agree on anything else first.
  it('breaks a tie between two same-sized pens on the order', () => {
    writeWorkspaces({
      a: pen('a', ['s1']),
      b: pen('b', ['s1']),
    }, ['b', 'a'], fields, [DEFAULT_FIELD_ID])
    expect(Object.keys(readPersistedWorkspaces()!.workspaces)).toEqual(['b'])
  })

  // A pen that loses one sheep to a bigger neighbour keeps the rest, and an
  // activeCell that still points inside it.
  it('trims a pen that overlaps rather than dropping it whole', () => {
    writeWorkspaces({
      quad: pen('quad', ['s1', 's2', 's3', 's4']),
      pair: { ...pen('pair', ['s4', 's5']), activeCell: 1 },
    }, ['quad', 'pair'], fields, [DEFAULT_FIELD_ID])

    const back = readPersistedWorkspaces()!
    expect(back.workspaces.pair!.cells).toEqual(['s5'])
    expect(back.workspaces.pair!.activeCell).toBe(0)
    expect(back.workspaces.quad!.cells).toHaveLength(4)
  })

  it('leaves a flock with no duplicates exactly as it found it', () => {
    writeWorkspaces({ a: pen('a', ['s1']), b: pen('b', ['s2']) }, ['a', 'b'], fields, [DEFAULT_FIELD_ID])
    const write = vi.spyOn(preferences, 'setItem')
    const back = readPersistedWorkspaces()!
    expect(back.order).toEqual(['a', 'b'])
    expect(write).not.toHaveBeenCalled()
    write.mockRestore()
  })
})
