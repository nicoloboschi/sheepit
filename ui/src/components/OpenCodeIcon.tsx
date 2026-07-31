export default function OpenCodeIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 512 512" width={size} height={size} className={className} style={{ flexShrink: 0 }} aria-hidden="true">
      <rect width="512" height="512" fill="#131010" />
      <path d="M320 224V352H192V224H320Z" fill="#5A5858" />
      <path fillRule="evenodd" clipRule="evenodd" d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z" fill="white" />
    </svg>
  );
}
