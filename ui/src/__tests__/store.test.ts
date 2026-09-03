import { describe, it, expect, beforeEach } from 'vitest'
import useStore from '../store'
import type { Session } from '../store'

const makeSession = (id: string, name: string, path = '/tmp'): Session => ({
  id,
  name,
  path,
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
      sessionCurrentInput: {},
      workspaces: {},
      workspaceOrder: [],
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

    it('still updates when a session actually changes', () => {
      useStore.getState().renderSessions([makeSession('$0', 'shell')])
      const before = useStore.getState().sessions

      const busier = { ...makeSession('$0', 'shell'), cpuPercent: 42 }
      useStore.getState().renderSessions([busier])
      const after = useStore.getState()

      expect(after.sessions).not.toBe(before)
      expect(after.sessions[0]!.cpuPercent).toBe(42)
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

    it('clears unseen when switching to session', () => {
      useStore.getState().markUnseen('$0')
      expect(useStore.getState().sessionHasUnseen['$0']).toBe(true)

      useStore.getState().setCurrentSessionId('$0')
      expect(useStore.getState().sessionHasUnseen['$0']).toBeFalsy()
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

    it('keeps the panes and the layout — folding closes nothing', () => {
      const id = useStore.getState().workspaceOrder[0]!
      const { cells, layout, activeCell } = useStore.getState().workspaces[id]!
      useStore.getState().toggleWorkspaceCollapsed(id)
      expect(useStore.getState().workspaces[id]).toMatchObject({ cells, layout, activeCell })
    })

    it('does nothing for a workspace that does not exist', () => {
      const before = useStore.getState().workspaces
      useStore.getState().toggleWorkspaceCollapsed('nope')
      expect(useStore.getState().workspaces).toBe(before)
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
    it('marks an explicit attention request and clears it when opened', () => {
      useStore.getState().sessionAttention('$0', 'Waiting for input')
      expect(useStore.getState().sessionNeedsAttention['$0']).toBe(true)

      useStore.getState().setCurrentSessionId('$0')
      expect(useStore.getState().sessionNeedsAttention['$0']).toBeUndefined()
    })
  })

  describe('current input', () => {
    it('stores current input per session', () => {
      useStore.getState().setCurrentInput('$0', 'git st')
      expect(useStore.getState().sessionCurrentInput['$0']).toBe('git st')
    })
  })

  describe('workspaces', () => {
    it('createWorkspace mints a synthetic id and stores the cells', () => {
      const id = useStore.getState().createWorkspace(['$0'])
      expect(id).toMatch(/^ws-/)
      const ws = useStore.getState().workspaces[id]
      expect(ws).toBeDefined()
      expect(ws!.cells).toEqual(['$0'])
      expect(ws!.layout).toBe('single')
      expect(ws!.activeCell).toBe(0)
      expect(useStore.getState().workspaceOrder).toContain(id)
    })

    it('appendPaneToWorkspace grows cells and auto-upgrades the layout', () => {
      const id = useStore.getState().createWorkspace(['$0'])
      useStore.getState().appendPaneToWorkspace(id, '$1')
      const ws = useStore.getState().workspaces[id]!
      expect(ws.cells).toEqual(['$0', '$1'])
      expect(ws.layout).toBe('horizontal') // upgraded from 'single'
      expect(ws.activeCell).toBe(1)        // focuses the newly-added pane
    })

    it('appendPaneToWorkspace respects an intentionally-larger layout', () => {
      const id = useStore.getState().createWorkspace(['$0'])
      // User switched to quad before panes populated — setGridState bumps layout.
      useStore.getState().setGridState(id, 'quad', ['$0'], 0)
      useStore.getState().appendPaneToWorkspace(id, '$1')
      expect(useStore.getState().workspaces[id]!.layout).toBe('quad')
    })

    it('removePaneFromWorkspace downgrades layout and preserves active cell', () => {
      const id = useStore.getState().createWorkspace(['$0', '$1', '$2', '$3'])
      useStore.getState().setActivePane(id, 2)
      const survivorId = useStore.getState().removePaneFromWorkspace(id, 1)
      expect(survivorId).toBe(id)
      const ws = useStore.getState().workspaces[id]!
      expect(ws.cells).toEqual(['$0', '$2', '$3'])
      expect(ws.layout).toBe('three')
      // Active cell was $2 (index 2). $1 was removed, so $2 is now at index 1.
      expect(ws.activeCell).toBe(1)
    })

    it('removePaneFromWorkspace deletes the workspace when the last pane leaves', () => {
      const id = useStore.getState().createWorkspace(['$0'])
      const survivorId = useStore.getState().removePaneFromWorkspace(id, 0)
      expect(survivorId).toBeNull()
      expect(useStore.getState().workspaces[id]).toBeUndefined()
      expect(useStore.getState().workspaceOrder).not.toContain(id)
    })

    it('movePaneBetweenWorkspaces moves a pane and downgrades the source', () => {
      const a = useStore.getState().createWorkspace(['$0', '$1'])
      const b = useStore.getState().createWorkspace(['$2'])
      const ok = useStore.getState().movePaneBetweenWorkspaces({
        sourceId: a, sourceIdx: 1, targetId: b,
      })
      expect(ok).toBe(true)
      expect(useStore.getState().workspaces[a]!.cells).toEqual(['$0'])
      expect(useStore.getState().workspaces[a]!.layout).toBe('single')
      expect(useStore.getState().workspaces[b]!.cells).toEqual(['$2', '$1'])
      expect(useStore.getState().workspaces[b]!.layout).toBe('horizontal')
      expect(useStore.getState().workspaces[b]!.activeCell).toBe(1) // moved pane gets focus
    })

    it('extractPaneToNewWorkspace re-homes every pane past a downgraded layout', () => {
      // The sequence TerminalGrid.changeLayout runs on quad → single. Panes
      // beyond the new capacity must end up in their own workspaces: left in
      // `cells` they would never render, yet their PTYs would stay alive and
      // hidden from the sidebar with no way to close them.
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

    it('movePaneBetweenWorkspaces rejects when the target is full', () => {
      const a = useStore.getState().createWorkspace(['$0'])
      const b = useStore.getState().createWorkspace(['$1', '$2', '$3', '$4'])
      const ok = useStore.getState().movePaneBetweenWorkspaces({
        sourceId: a, sourceIdx: 0, targetId: b,
      })
      expect(ok).toBe(false)
      expect(useStore.getState().workspaces[a]!.cells).toEqual(['$0'])
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
      // $1 is gone — workspace keeps $0 only, layout shrinks to single
      const ws = useStore.getState().workspaces[id]!
      expect(ws.cells).toEqual(['$0'])
      expect(ws.layout).toBe('single')

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
