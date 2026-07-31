/** Grok Build's xAI wordmark, kept intentionally monochrome for terminal chrome. */
export default function GrokIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className={className} style={{ flexShrink: 0 }} aria-hidden="true">
      <path fill="currentColor" d="M2.1 1.5h2.45L7.1 5.7l2.55-4.2h2.25L8.42 7.35l3.73 7.15H9.7L7.1 9.3l-2.78 5.2H1.9l3.82-7.16L2.1 1.5Z" />
      <path fill="currentColor" d="M11.2 1.5h2.7v2.7h-2.7z" opacity=".72" />
    </svg>
  );
}
