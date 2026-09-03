/**
 * Which field the sidebar is showing.
 *
 * Fields group pens by the repository they are in, but stacking every field
 * with its own header just makes the same long list with bands in it. So the
 * sidebar shows **one field at a time** and this says which — the list stays
 * as short as it was before fields existed.
 *
 * Hiding pens is the risk, and it is the same one the old All/Active/Favourites
 * toggle failed at: a list that hides things is one you must remember the state
 * of. Two things answer that here, and both are load-bearing:
 *
 *   - the selector always names the field you are in, so the state is on
 *     screen rather than in your memory;
 *   - every other field shows its own bleating count in the menu, and the
 *     selector carries a mark when any of them wants you — so a sheep calling
 *     from a field you are not looking at is never silent.
 *
 * Selecting a pen also pulls the sidebar to its field (see setCurrentSessionId),
 * so a ⌘K jump can never land you on a pane the list is not showing.
 */
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check, Pencil, Trash2, FolderPlus } from 'lucide-react';
import useStore, { pensInField, UNSORTED_FIELD_ID } from '../store';
import { useFlockCounts, plural } from '../flock';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator,
} from './ui/dropdown-menu';

/** One row in the menu: a field, what stands in it, and whether it wants you. */
function FieldRow({ fieldId, name, selected, onPick }: {
  fieldId: string; name: string; selected: boolean; onPick: () => void;
}): React.ReactElement {
  const penIds = useStore(s => pensInField(fieldId, s.workspaces, s.workspaceOrder));
  const { pens, bleating } = useFlockCounts(penIds);
  return (
    <DropdownMenuItem onClick={onPick} style={{ fontSize: 12, gap: 8 }}>
      <Check size={12} style={{ opacity: selected ? 1 : 0, flexShrink: 0 }} />
      <span className="field-pick-name">{name}</span>
      <span className="field-pick-tally">
        {bleating > 0 && <span className="field-bleating">{bleating} bleating</span>}
        {plural(pens, 'pen')}
      </span>
    </DropdownMenuItem>
  );
}

export default function FieldSelector(): React.ReactElement | null {
  const fields = useStore(s => s.fields);
  const fieldOrder = useStore(s => s.fieldOrder);
  const selectedFieldId = useStore(s => s.selectedFieldId);
  const penIds = useStore(s => (s.selectedFieldId
    ? pensInField(s.selectedFieldId, s.workspaces, s.workspaceOrder)
    : s.workspaceOrder));
  const counts = useFlockCounts(penIds);
  const elsewhere = useFlockCounts();

  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (renaming) { inputRef.current?.focus(); inputRef.current?.select(); }
  }, [renaming]);

  const shown = fieldOrder.filter(id => fields[id]);
  // Nothing to choose between: one field is just the sidebar, and a selector
  // that only ever says one thing is a row of pixels doing no work.
  if (shown.length < 2 && !renaming) return null;

  const current = selectedFieldId ? fields[selectedFieldId] : undefined;
  // A sheep bleating in a field you are not looking at must not be silent.
  const bleatingElsewhere = Math.max(0, elsewhere.bleating - counts.bleating);

  function commitRename(): void {
    if (current) useStore.getState().renameField(current.id, draft);
    setRenaming(false);
  }

  return (
    <div className="field-selector">
      {renaming ? (
        <input
          ref={inputRef}
          className="field-name-input"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={e => {
            if (e.key === 'Enter') commitRename();
            if (e.key === 'Escape') setRenaming(false);
          }}
        />
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="field-pick" title="Which field the sidebar is showing">
              <ChevronDown size={12} />
              <span className="field-pick-current">{current?.name ?? 'All pens'}</span>
              <span className="field-pick-count">{plural(counts.pens, 'pen')}</span>
              {bleatingElsewhere > 0 && (
                <span
                  className="field-elsewhere"
                  title={`${bleatingElsewhere} bleating in other fields`}
                >
                  +{bleatingElsewhere}
                </span>
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="bottom" className="w-60">
            {shown.map(id => (
              <FieldRow
                key={id}
                fieldId={id}
                name={fields[id]!.name}
                selected={id === selectedFieldId}
                onPick={() => useStore.getState().setSelectedField(id)}
              />
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                const id = useStore.getState().createField('New field');
                useStore.getState().setSelectedField(id);
                setDraft('New field');
                setRenaming(true);
              }}
              style={{ fontSize: 12 }}
            >
              <FolderPlus size={13} /> New field
            </DropdownMenuItem>
            {current && (
              <DropdownMenuItem
                onClick={() => { setDraft(current.name); setRenaming(true); }}
                style={{ fontSize: 12 }}
              >
                <Pencil size={13} /> Rename &ldquo;{current.name}&rdquo;
              </DropdownMenuItem>
            )}
            {current && current.id !== UNSORTED_FIELD_ID && (
              <DropdownMenuItem
                onClick={() => {
                  useStore.getState().deleteField(current.id);
                  useStore.getState().setSelectedField(useStore.getState().fieldOrder[0] ?? null);
                }}
                className="text-destructive focus:text-destructive"
                style={{ fontSize: 12 }}
              >
                {/* The pens are not deleted with it — they fall back to
                    Unsorted. A field is a label on the ground. */}
                <Trash2 size={13} /> Delete field
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
