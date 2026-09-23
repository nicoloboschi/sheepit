import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/**
 * A panel that floats over everything, including zen.
 *
 * The things it holds are *globals* — the headless shell, the sheepdog, the
 * file browser, Knowledge. None of them belong to a pane, and none of them is
 * what you are working in: they are things you keep beside the work. A
 * full-screen dialog says the opposite, and zen's own occupant was worse
 * still, because then reading one pane and watching a shell were the same
 * slot.
 *
 * So: draggable, resizable, and above zen (which sits at 1000). Several can be
 * open at once and the one you touched last comes to the front.
 *
 * **It is portalled to `body`, and must stay that way.** A panel is opened
 * from a button in the workspace bar, so that is where it was rendered — and a
 * `position: fixed` child is laid out and *stacked* inside the nearest
 * ancestor that has a transform, a filter or a z-index of its own. The panel
 * drew on top of most things and still sat underneath a pane's own controls:
 * a click on its title bar reached the input behind it, so dragging and the
 * double-press below silently did nothing. Being a child of `body` is what
 * makes the z-index below mean what it says.
 */

/** Rising z-index, so clicking a panel brings it forward. Starts above zen's
 *  pane (1000) and its backdrop (999). */
let topZ = 1002;

/** How close two presses on the handle have to be to mean "put this away".
 *  Matches the usual system double-click window. */
const DOUBLE_MS = 400;

interface FloatingPanelProps {
  /** A header with this name and a close button. Omit it for a panel whose
   *  contents carry their own chrome — a terminal has a pane bar already, and
   *  two title rows over one terminal is one too many. */
  title?: string;
  icon?: React.ReactNode;
  onClose: () => void;
  width?: number;
  height?: number;
  /** Where a drag starts, as a CSS selector. Defaults to the panel's own
   *  header; a terminal panel passes its pane bar instead. */
  dragHandle?: string;
  children: React.ReactNode;
}

export default function FloatingPanel({
  title, icon, onClose, width = 520, height = 340,
  dragHandle = '.floating-panel-head', children,
}: FloatingPanelProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const grabRef = useRef<{ dx: number; dy: number } | null>(null);
  // Until it is dragged the panel has no position of its own and stays parked
  // in the bottom-right corner.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [z, setZ] = useState(() => ++topZ);
  /** When the handle was last pressed, for the double-press that puts the
   *  panel away. */
  const lastDownRef = useRef(0);
  const toFront = () => setZ(z === topZ ? z : ++topZ);

  // Escape closes a panel that has a header — one with a close button is one
  // you put away. A terminal panel has neither, because Escape belongs to
  // whatever is running inside it.
  useEffect(() => {
    if (!title) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [title, onClose]);

  const onPointerDown = (e: React.PointerEvent) => {
    toFront();
    const el = e.target as HTMLElement;
    if (!el.closest(dragHandle) || el.closest('button, input, a, [role="button"]')) return;
    const box = boxRef.current;
    if (!box) return;

    // The second press of a double-click puts the panel away — counted here
    // rather than with an `ondblclick`, which never fires: the
    // `preventDefault()` below is what stops a drag selecting text, and it
    // also cancels the compatibility mouse events a double-click is made of.
    const now = e.timeStamp;
    if (now - lastDownRef.current < DOUBLE_MS) { lastDownRef.current = 0; onClose(); return; }
    lastDownRef.current = now;

    const r = box.getBoundingClientRect();
    grabRef.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    setPos({ x: r.left, y: r.top });
    box.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const grab = grabRef.current, box = boxRef.current;
    if (!grab || !box) return;
    const r = box.getBoundingClientRect();
    const clamp = (v: number, max: number) => Math.max(0, Math.min(v, max));
    setPos({
      x: clamp(e.clientX - grab.dx, window.innerWidth - r.width),
      y: clamp(e.clientY - grab.dy, window.innerHeight - r.height),
    });
  };

  return createPortal(
    <div
      ref={boxRef}
      className="floating-panel"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => { grabRef.current = null; }}
      onPointerCancel={() => { grabRef.current = null; }}
      style={{
        position: 'fixed', zIndex: z,
        ...(pos ? { left: pos.x, top: pos.y } : { right: 24, bottom: 24 }),
        // Never taller or wider than the window, however big the default is.
        width: `min(${width}px, calc(100vw - 48px))`,
        height: `min(${height}px, calc(100vh - 48px))`,
        minWidth: 260, minHeight: 160,
        // Native resize handle — the browser already has one.
        resize: 'both', overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
        background: 'var(--border)', padding: 1, borderRadius: 6,
        boxShadow: '0 20px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4)',
      }}
    >
      {title && (
        <div
          className="floating-panel-head"
          style={{
            display: 'flex', alignItems: 'center', gap: 7,
            padding: '6px 8px 6px 10px', flexShrink: 0,
            background: 'linear-gradient(135deg, rgba(156, 188, 127,0.10) 0%, rgba(111, 169, 140,0.07) 100%), var(--chrome)',
            borderBottom: '1px solid var(--border)',
          }}
        >
          {icon}
          <span
            title="Drag to move · double-click to put away"
            style={{ fontSize: 12, fontWeight: 600, color: 'var(--foreground)', flex: 1, minWidth: 0 }}
          >
            {title}
          </span>
          <button
            onClick={onClose}
            title="Close"
            aria-label="Close"
            style={{ display: 'flex', background: 'none', border: 'none', padding: 2, cursor: 'pointer', color: 'var(--muted-foreground)' }}
          >
            <X size={13} />
          </button>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--background)', overflow: 'hidden' }}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
