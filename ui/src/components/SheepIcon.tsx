interface SheepIconProps {
  size?: number;
  color?: string;
  className?: string;
}

/** The sheepit mark: a terminal window wearing a fleece.
 *  Curls of wool over the top edge, four legs under it, and a `>` prompt with
 *  a block cursor on the screen. */
export default function SheepIcon({ size = 16, color = 'currentColor', className }: SheepIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 }}
    >
      {/* Fleece — four overlapping curls across the back. */}
      <path
        d="M4.6 10.3a2.7 2.7 0 1 1 2.9-4.1 2.7 2.7 0 0 1 4.4-1.2 2.7 2.7 0 0 1 4.6 1.2 2.7 2.7 0 0 1 2.9 4.1"
        stroke={color}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Body — the terminal window. */}
      <rect x="4.6" y="9.6" width="14.8" height="7.2" rx="2.2" stroke={color} strokeWidth="1.6" />
      {/* Legs. */}
      <path d="M8 16.8v2.6M16 16.8v2.6" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
      {/* Prompt chevron and block cursor on the screen. */}
      <path
        d="M8.6 11.9l1.9 1.4-1.9 1.4"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="12.7" y="12.4" width="2.4" height="2" rx="0.4" fill={color} />
    </svg>
  );
}
