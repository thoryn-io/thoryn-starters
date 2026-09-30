import express from "express";
import session from "express-session";
import helmet from "helmet";
import { fileURLToPath } from "node:url";
import { createOidc } from "./oidc.js";
import { createAccessTokenVerifier, requireBearer } from "./api-auth.js";
import { canonicalLocalHost } from "./canonical-host.js";
import { errorPage, homePage, profilePage } from "./pages.js";

export function createApp(config, { fetchImpl = fetch, logger = console } = {}) {
  const oidc = createOidc(config);
  const verifyAccessToken = createAccessTokenVerifier({
    issuer: config.issuer,
    audience: config.audience,
    clientId: config.clientId,
    jwksUri: () => oidc.jwksUri(),
  });

  const app = express();
  app.disable("x-powered-by");
  // Local development: localhost and 127.0.0.1 both work (see canonical-host.js).
  app.use(canonicalLocalHost(config.baseUrl));
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          // The sign-out form posts here and is then redirected to the issuer's end-session endpoint;
          // browsers apply form-action to that redirect too.
          "form-action": ["'self'", new URL(config.issuer).origin],
        },
      },
    }),
  );
  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url)), { index: false }));

  app.get("/health", (_req, res) => res.type("text").send("ok"));

  // ---- the protected API: bearer tokens only, no session --------------------------------------------
  app.get("/api/me", requireBearer(verifyAccessToken), (req, res) => {
    const t = req.accessToken;
    res.json({ sub: t.sub, client_id: t.client_id, scope: t.scope ?? null, iss: t.iss, exp: t.exp });
  });

  // ---- the web app: server-side session, tokens never reach the browser ----------------------------
  app.use(
    session({
      name: "starter.sid",
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: "lax", secure: config.cookieSecure, path: "/", maxAge: 8 * 60 * 60 * 1000 },
    }),
  );

  app.get("/", (req, res) => res.send(homePage(req.session.user)));

  app.get("/login", async (req, res, next) => {
    try {
      const { url, codeVerifier, state, nonce } = await oidc.authorizationRequest();
      req.session.pendingAuth = { codeVerifier, state, nonce };
      res.redirect(302, url);
    } catch (e) {
      next(e);
    }
  });

  app.get("/callback", async (req, res) => {
    const pending = req.session.pendingAuth;
    delete req.session.pendingAuth;
    if (!pending) return res.status(400).send(errorPage("No sign-in in progress. Start again."));
    try {
      const currentUrl = new URL(req.originalUrl, config.baseUrl);
      const { claims, idToken, accessToken } = await oidc.completeAuthorization(currentUrl, pending);
      // New session id on sign-in (session fixation).
      req.session.regenerate((err) => {
        if (err) return res.status(500).send(errorPage("Could not start a session."));
        req.session.user = claims;
        req.session.tokens = { idToken, accessToken };
        res.redirect(302, "/profile");
      });
    } catch (e) {
      logger.warn(`sign-in failed: ${e?.code ?? e?.name ?? "error"}`); // no token or response body in logs
      res.status(400).send(errorPage("The sign-in could not be completed."));
    }
  });

  app.get("/profile", async (req, res) => {
    const user = req.session.user;
    if (!user) return res.redirect(302, "/login");
    let apiResult;
    try {
      const resp = await fetchImpl(`${config.baseUrl}/api/me`, {
        headers: { Authorization: `Bearer ${req.session.tokens.accessToken}` },
      });
      apiResult = resp.ok ? JSON.stringify(await resp.json(), null, 2) : `HTTP ${resp.status}`;
    } catch {
      apiResult = "the API could not be reached";
    }
    res.send(profilePage(user, apiResult));
  });

  // RP-initiated logout (OpenID Connect RP-Initiated Logout 1.0). POST only; the SameSite=Lax session
  // cookie is not sent on a cross-site POST, and a foreign Origin is refused, so it cannot be forced.
  app.post("/logout", async (req, res, next) => {
    const origin = req.get("origin");
    if (origin && origin !== new URL(config.baseUrl).origin) return res.status(403).send(errorPage("Cross-site sign-out refused."));
    const idToken = req.session.tokens?.idToken;
    req.session.destroy(async (err) => {
      if (err) return next(err);
      res.clearCookie("starter.sid", { httpOnly: true, sameSite: "lax", secure: config.cookieSecure, path: "/" });
      try {
        const url = idToken ? await oidc.endSessionUrl(idToken) : null;
        res.redirect(303, url ?? "/");
      } catch (e) {
        next(e);
      }
    });
  });

  app.get("/signed-out", (_req, res) => res.redirect(302, "/"));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    logger.error(`request failed: ${err?.code ?? err?.name ?? "error"}: ${err?.message ?? ""}`);
    res.status(502).send(errorPage("The identity provider could not be reached."));
  });

  return app;
}
