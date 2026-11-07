/** A labelled toolbar button, the System dock's style at toolbar size: an
 *  icon with its name under it, so an action says what it does without a
 *  hover. `on` marks a toggle that is currently active. */
export default function DockButton({ icon, label, title, on, danger, disabled, onClick, className }: {
  icon: React.ReactNode;
  label: string;
  title?: string;
  on?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`dock-btn${on ? ' is-on' : ''}${danger ? ' is-danger' : ''}${className ? ` ${className}` : ''}`}
      title={title ?? label}
      aria-label={title ?? label}
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="dock-btn-icon">{icon}</span>
      <span className="dock-btn-label">{label}</span>
    </button>
  );
}
