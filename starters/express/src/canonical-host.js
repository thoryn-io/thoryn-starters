// Local development: one canonical host. Sign-in keeps its session cookie on the host the browser used, and
// the platform sends the browser back to the configured base URL, so a sign-in started on
// http://localhost:8080 while the base URL is http://127.0.0.1:8080 would lose its session. When the base
// URL is a loopback address and a request arrives on ANOTHER loopback host, send the browser to the same
// path and query on the base URL, so either address simply works.
//
// The redirect target is built ONLY from the configured base URL (plus the request's path and query, which
// cannot change the host); the Host header is only compared, never echoed. A deployed app (a non-loopback
// base URL) is never redirected, so a proxy that rewrites the Host header cannot cause a redirect loop.

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The request's host ("name:port"), from the Host header; null when absent or unparseable. */
function requestHost(hostHeader) {
  if (!hostHeader) return null;
  try {
    return new URL(`http://${hostHeader}`).host;
  } catch {
    return null;
  }
}

export function canonicalLocalHost(baseUrl) {
  const base = new URL(baseUrl);
  const origin = base.origin;
  if (!LOOPBACK.has(base.hostname)) return (_req, _res, next) => next();
  return (req, res, next) => {
    const host = requestHost(req.headers.host);
    if (host === null || host === base.host || !LOOPBACK.has(new URL(`http://${host}`).hostname)) return next();
    if (req.method !== "GET" && req.method !== "HEAD") {
      return res.status(400).type("text").send(`Use ${origin}: this app's base URL.\n`);
    }
    // req.originalUrl is the path and query ("/…"), so the target always stays on the base URL's origin.
    return res.redirect(302, `${origin}${req.originalUrl}`);
  };
}
