/**
 * Send a link to the user's own browser.
 *
 * In a tab this is just `window.open(…, '_blank')` — the browser showing
 * sheepit *is* the user's browser, so a `_blank` already lands in Brave, or
 * Chrome, or whatever they are reading this in.
 *
 * Inside the desktop shell it is not. There, `target="_blank"` opens another
 * Electron window, which made "open in your own browser" the one button that
 * could not do the single thing it says. The shell hands the URL to the OS
 * instead (`shell:open-external` in `electron/main.cjs`), and the OS opens it
 * with whatever the user's default browser is.
 *
 * **Only web URLs take the OS path.** `mailto:` counts; `vscode:` and every
 * other custom scheme keep the `window.open` they have always had. The strings
 * reaching here come from pull request bodies, CI links and terminal output —
 * none of which we wrote — and handing an arbitrary scheme to the OS is asking
 * it to launch something rather than to show a page. The same allowlist is
 * enforced again in the main process, which is the side that cannot be talked
 * out of it; this copy exists so a scheme it would refuse still falls back to
 * the browser rather than silently doing nothing.
 */

interface DesktopShell { openExternal?: (url: string) => void }

const desktop = (window as unknown as { sheepitDesktop?: DesktopShell }).sheepitDesktop;

function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url, window.location.href);
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:';
  } catch {
    return false;
  }
}

export function openExternal(url: string): void {
  if (!url) return;
  if (desktop?.openExternal && isWebUrl(url)) {
    desktop.openExternal(url);
    return;
  }
  window.open(url, '_blank', 'noopener');
}

/**
 * Click handler for an `<a>` that should leave for the real browser.
 *
 * The anchor keeps its `href`, which is what "copy link address" and the
 * context menu read; this only takes over the plain left click — the one the
 * desktop shell would otherwise turn into an Electron window. A modified or
 * middle click means "new tab", "new window" or "save", and the browser
 * showing the app honours those better than we can.
 */
export function externalClick(url?: string | null) {
  return (e: React.MouseEvent): void => {
    e.stopPropagation();
    if (!url) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    openExternal(url);
  };
}
