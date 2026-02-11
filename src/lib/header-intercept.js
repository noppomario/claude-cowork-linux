/**
 * Anthropic desktop headers
 *
 * Intercepts onBeforeSendHeaders to:
 *   - Remove lowercase anthropic-* headers set by the web code
 *     (prevents server seeing "web_claude_ai" instead of "desktop_app")
 *   - Log API request headers for diagnostics
 */

'use strict';

/**
 * @param {{ app: Electron.App, session: typeof Electron.session }} deps
 */
module.exports = function({ app, session }) {
  app.whenReady().then(() => {
    try {
      const webReq = session.defaultSession.webRequest;
      const origOnBefore = webReq.onBeforeSendHeaders.bind(webReq);
      let headerLogCount = 0;

      webReq.onBeforeSendHeaders = function(...args) {
        const listener = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
        if (!listener) return origOnBefore(...args);

        const wrappedListener = (details, callback) => {
          listener(details, (result) => {
            const headers = result?.requestHeaders || details.requestHeaders;
            try {
              const url = new URL(details.url);
              if (url.host === 'claude.ai' || url.host.endsWith('.claude.ai')) {
                // Remove lowercase anthropic-* headers from web code
                for (const key of Object.keys(headers)) {
                  if (key.startsWith('anthropic-') && key === key.toLowerCase()) {
                    delete headers[key];
                  }
                }

                // Log first 5 API requests for diagnostics
                if (url.pathname.startsWith('/api/') && headerLogCount < 5) {
                  headerLogCount++;
                  const anthHeaders = Object.entries(headers)
                    .filter(([k]) => k.toLowerCase().startsWith('anthropic'))
                    .map(([k, v]) => `${k}: ${v}`);
                  const ua = headers['User-Agent'] || headers['user-agent'] || '';
                  const uaShort = ua.includes('ClaudeNest') ? 'ClaudeNest/' + (ua.match(/ClaudeNest\/(\S+)/)?.[1] || '?')
                    : ua.includes('Claude/') ? 'Claude/' + (ua.match(/Claude\/(\S+)/)?.[1] || '?')
                    : 'no-Claude-in-UA';
                  console.log(`[Headers] ${url.pathname} => ${anthHeaders.join(', ')} | UA: ${uaShort}`);
                }
              }
            } catch (e) { /* URL parse error */ }
            callback({ requestHeaders: headers });
          });
        };

        args[args.length - 1] = wrappedListener;
        return origOnBefore(...args);
      };
      console.log('[Headers] Header interception configured');
    } catch (e) {
      console.error('[Headers] Failed:', e.message);
    }
  });
};
