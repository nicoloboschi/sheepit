/**
 * The wire between a pane and its tab in the live browser.
 *
 * It is a **separate WebSocket** from `/ws`, on purpose. Frames are tens of
 * kilobytes arriving many times a second, and `/ws` is the socket a keystroke
 * travels down to reach a PTY: putting a screencast on it would make typing
 * queue behind pictures of a web page. One socket per open browser view also
 * means the view dies with the connection, so a closed tab cannot leak a
 * headless page nobody is looking at.
 *
 * The client speaks CDP's own input dialect (`Input.dispatchMouseEvent` and
 * friends) rather than a vocabulary of our own. A browser event already
 * carries exactly what CDP wants; re-encoding it here and decoding it there
 * would only add a second place for a modifier bit to go missing.
 */
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { LiveBrowser, findBrowser, VIEW_TTL_MS } from './live-browser.js';

export const BROWSER_WS_PATH = '/ws/browser';

interface OpenMessage {
  type: 'open';
  url?: string;
  width: number;
  height: number;
  scale?: number;
}

type ClientMessage =
  | OpenMessage
  | { type: 'resize'; width: number; height: number; scale?: number }
  | { type: 'navigate'; url: string }
  | { type: 'reload' }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'focus'; scale?: number }
  // "I am on screen." Sent only while the pane is visible; see VIEW_TTL_MS.
  | { type: 'alive' }
  | { type: 'copy'; id: number }
  | { type: 'screenshot'; id: number }
  | { type: 'paste'; text: string }
  | { type: 'input'; method: string; params: Record<string, unknown> };

/** `noServer`, and the caller routes upgrades to it — see the comment on the
 *  upgrade listener in server.ts. A second path-bound WebSocketServer on the
 *  same HTTP server destroys the first one's sockets. */
export function attachBrowserWs(browser: LiveBrowser, log: (m: string) => void): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  let nextViewId = 1;

  wss.on('connection', (ws: WebSocket) => {
    const viewId = `view-${nextViewId++}`;
    let opened = false;

    const send = (msg: object) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };

    if (!findBrowser()) {
      send({ type: 'error', message: 'No Chromium-family browser found on this machine. Set SHEEPIT_BROWSER to one.' });
      ws.close();
      return;
    }

    ws.on('message', async (raw: RawData) => {
      let msg: ClientMessage;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      // Anything from the pane means somebody is there: a heartbeat, a click,
      // a key. That is what keeps the page from expiring.
      browser.touch(viewId);
      try {
        switch (msg.type) {
          case 'alive': break;
          case 'open': {
            if (opened) return;
            opened = true;
            await browser.openView({
              id: viewId,
              url: msg.url ?? '',
              width: msg.width, height: msg.height, scale: msg.scale ?? 1,
              // Frames go out as JSON base64 rather than binary: it costs a
              // third more bytes on a link that is almost always loopback or
              // LAN, and it keeps one message shape on the socket.
              onFrame: frame => send({ type: 'frame', ...frame }),
              onState: state => send({ type: 'state', ...state }),
              // Only one pane streams at a time (see LiveBrowser.activeViewId),
              // so a pane has to be able to say why it went still.
              onActive: active => send({ type: 'active', active }),
              // What the page says the pointer should look like over it.
              onCursor: cursor => send({ type: 'cursor', cursor }),
              // Out of sight past the TTL: the page is gone, the socket stays,
              // and the pane may ask for it again with another `open`.
              // The TTL travels with it, so the pane's wording cannot disagree
              // with the setting that closed it.
              onExpired: () => { opened = false; send({ type: 'expired', minutes: VIEW_TTL_MS / 60_000 }); },
            });
            send({ type: 'ready' });
            break;
          }
          case 'resize':
            await browser.resizeView(viewId, msg.width, msg.height, msg.scale ?? 1);
            break;
          case 'focus':    await browser.activate(viewId, msg.scale ?? 1); break;
          // Answered with the id it was asked with: the client is holding a
          // clipboard write open on a user gesture and cannot wait on a
          // message it is not sure is its own.
          case 'copy':     send({ type: 'copied', id: msg.id, text: await browser.selection(viewId) }); break;
          // Same shape as `copy`, and for the same reason: the client is
          // waiting on this one answer and cannot take somebody else's.
          case 'screenshot': send({ type: 'shot', id: msg.id, data: await browser.screenshot(viewId) }); break;
          case 'paste':    browser.paste(viewId, msg.text); break;
          case 'navigate': browser.navigate(viewId, msg.url); break;
          case 'reload':   browser.reload(viewId); break;
          case 'back':     await browser.history(viewId, -1); break;
          case 'forward':  await browser.history(viewId, 1); break;
          case 'input':    browser.input(viewId, msg.method, msg.params); break;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`browser ws: ${message}`);
        send({ type: 'error', message });
      }
    });

    ws.on('close', () => { void browser.closeView(viewId); });
    ws.on('error', () => { void browser.closeView(viewId); });
  });

  return wss;
}
