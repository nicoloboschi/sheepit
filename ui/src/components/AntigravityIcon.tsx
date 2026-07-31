/** Official Google Antigravity mark, served from its press-asset collection. */
export default function AntigravityIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <img
      src="https://antigravity.google/assets/image/brand/antigravity-icon__full-color.png"
      alt=""
      width={size}
      height={size}
      className={className}
      style={{ flexShrink: 0, objectFit: 'contain' }}
    />
  );
}
