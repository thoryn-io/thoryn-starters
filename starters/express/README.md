# {{thoryn.githubRepository}}

An Express web app that signs users in with Thoryn and protects its own API. It is an **application
project** of the Thoryn workspace `{{thoryn.workspace}}`, and it runs against the sandbox environment
`{{thoryn.environment}}`.

- **Sign-in:** server-side OpenID Connect, authorization code with PKCE (S256), `state` and `nonce`. The ID
  token is validated with its signature pinned to ES256. Tokens stay in the server-side session; the
  browser only gets an `HttpOnly`, `SameSite=Lax` session cookie (`Secure` when served over https).
- **Sign-out:** RP-initiated logout (`POST /logout`), which ends the session at Thoryn too.
- **Protected API:** `GET /api/me` accepts only a Bearer access token that Thoryn issued to this app:
  signature ES256 from the issuer's JWKS, `typ` `at+jwt`, `iss`, `aud`, expiry and `client_id`.
- **CI with no secret:** GitHub Actions signs in to Thoryn with workload identity, provisions the sandbox
  from `.thoryn/provision.yaml` and runs a real browser sign-in against it.

## Run it locally

You need Node.js 22 or newer and the [`thoryn` CLI](https://github.com/thoryn-io/thoryn-cli).

```bash
npm install

# Once: sign in, create this app's client and a test user in the sandbox, and write .env.
export THORYN_ISSUER=https://auth.stg.thoryn.org          # your Thoryn platform
thoryn login --workspace {{thoryn.workspace}}
export THORYN_TEST_USER_EMAIL=you+test@example.com THORYN_TEST_USER_PASSWORD='choose-a-Password-1!'
thoryn provision apply --file .thoryn/provision.yaml
node .thoryn/app-env.mjs --write .env

# Every time:
npm start
```

Open <http://127.0.0.1:8080> and sign in with the test user. Your own `thoryn login` session needs the
application and user scopes in that environment. `thoryn provision destroy --file .thoryn/provision.yaml`
removes what your apply created.

### Where the settings come from

The app reads everything from the environment (`npm start` also loads `.env`):

| Variable | Meaning |
|---|---|
| `OIDC_ISSUER` | The sandbox's issuer. Resolved at run time by `.thoryn/app-env.mjs`, never committed, so a custom domain needs no change here. |
| `OIDC_CLIENT_ID` | This app's client id, read from the provisioning receipt. |
| `OIDC_AUDIENCE` | Audience the API requires. Default: the issuer (Thoryn lists its issuer in every access token's `aud`). |
| `PORT`, `APP_BASE_URL` | Where the app listens. Default `8080` and `http://127.0.0.1:8080`. |
| `COOKIE_SECURE`, `SESSION_SECRET` | Override the cookie `Secure` flag and the per-process session secret. |

The redirect URIs are RFC 8252 loopback URIs (`http://127.0.0.1/callback`, `http://127.0.0.1/signed-out`),
so any local port works. Add your real URLs to `.thoryn/provision.yaml` when you deploy the app.

## The `.thoryn/` folder

| File | What it is |
|---|---|
| `connection.json` | **Who CI is:** workspace `{{thoryn.workspace}}`, environment `{{thoryn.environment}}`, and the workload identity trust pinned to `{{thoryn.githubOwner}}/{{thoryn.githubRepository}}`. No secret. |
| `provision.yaml` | **What this app owns:** its OAuth client and its test user, in the sandbox. Nothing workspace-wide. |
| `app-env.mjs` | Resolves `OIDC_ISSUER` / `OIDC_CLIENT_ID` after provisioning. |
| `ci/` | The steps the pipeline runs. |

## CI

`.github/workflows/ci.yml` runs on every push and pull request:

1. **Build and unit tests** (`npm test`): the sign-in flow, the logout and the API's token checks, against an
   in-process fake issuer.
2. **Provision the sandbox and run the sign-in journey:** sign in with workload identity (the job's GitHub
   OIDC token is exchanged; nothing is stored), `thoryn provision apply` with a fresh test user, start the
   app, run `e2e/` with Playwright (sign in, call the API, sign out, reset the password through the
   sandbox's test inbox), then remove what the run created.

It needs one repository variable, `THORYN_ISSUER`. The job is skipped with a notice while it is not set.

## Next steps

- Add your own routes behind the session (see `/profile`) or behind the Bearer check (see `/api/me`).
- Move sessions to a shared store (and set `SESSION_SECRET`) before you run more than one instance.
- Workspace-wide sign-in settings (login methods, branding, email, custom domain) live in the workspace's
  config project, not here.
