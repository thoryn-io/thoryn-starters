# Thoryn ASP.NET Core starter

An ASP.NET Core web app that signs users in with Thoryn and protects its own API. It is an **application
project** of a Thoryn workspace and runs against one of its sandbox environments. Which workspace and which
sandbox is not written anywhere in this repository: CI reads them from GitHub Actions variables at run time
(see [Configuration](#configuration)).

- **Sign-in:** the ASP.NET Core OpenID Connect handler, authorization code with PKCE (S256), `state` and
  `nonce`. The ID token is validated with its signature pinned to ES256. Claims and tokens stay on the
  server (an in-memory ticket store); the browser only gets an opaque `HttpOnly`, `SameSite=Lax` session
  cookie (`Secure` when served over https).
- **Sign-out:** RP-initiated logout (`POST /logout` with the antiforgery token), which ends the session at
  Thoryn too.
- **Protected API:** `GET /api/me` uses the JWT bearer handler and accepts only a Bearer access token that
  Thoryn issued to this app: signature ES256 from the issuer's JWKS, `typ` `at+jwt`, `iss`, `aud`, expiry
  and `client_id`.
- **CI with no secret:** GitHub Actions signs in to Thoryn with workload identity, provisions the sandbox
  from `.thoryn/provision.yaml` and runs a real browser sign-in against it.

## Run it locally

You need the .NET 10 SDK, Node.js 22 or newer (for `.thoryn/app-env.mjs` and the e2e journey) and the
[`thoryn` CLI](https://github.com/thoryn-io/thoryn-cli).

```bash
# Once: the same values CI reads from the repository's Actions variables.
export THORYN_ISSUER=https://auth.stg.thoryn.org   # your Thoryn platform
export THORYN_WORKSPACE=<your workspace>
export THORYN_ENVIRONMENT=<your sandbox>
export THORYN_APP_NAME=<a name for your local client>   # its converge key in the sandbox

# Sign in as yourself, create this app's client and a test user in the sandbox, and write .env.
thoryn login --workspace "$THORYN_WORKSPACE"
export THORYN_TEST_USER_EMAIL=you+test@example.com THORYN_TEST_USER_PASSWORD='choose-a-Password-1!'
thoryn provision apply --file .thoryn/provision.yaml
node .thoryn/app-env.mjs --write .env    # or: --workspace <ws> --environment <sandbox> --issuer <url>

# Every time:
dotnet run --project src/StarterApp
```

Open <http://127.0.0.1:8080> and sign in with the test user. Your own `thoryn login` session needs the
application and user scopes in that environment. `thoryn provision destroy --file .thoryn/provision.yaml`
removes what your apply created.

### Where the settings come from

The app reads everything from the environment (it also loads the nearest `.env`):

| Variable | Meaning |
|---|---|
| `OIDC_ISSUER` | The sandbox's issuer. Resolved at run time by `.thoryn/app-env.mjs`, never committed, so a custom domain needs no change here. |
| `OIDC_CLIENT_ID` | This app's client id, read from the provisioning receipt. |
| `OIDC_AUDIENCE` | Audience the API requires. Default: the issuer (Thoryn lists its issuer in every access token's `aud`). |
| `PORT`, `APP_BASE_URL` | Where the app listens. Default `8080` and `http://127.0.0.1:8080`. |
| `COOKIE_SECURE` | Override the cookie `Secure` flag (default: on when `APP_BASE_URL` is https). |

The redirect URIs are RFC 8252 loopback URIs (`http://127.0.0.1/callback`, `http://127.0.0.1/signed-out`),
so any local port works. Add your real URLs to `.thoryn/provision.yaml` when you deploy the app.

## The `.thoryn/` folder

| File | What it is |
|---|---|
| `template.json` | **What this repository needs from Thoryn:** the Actions variables (see [Configuration](#configuration)), and connection `sandbox`, the workload identity trust CI signs in with (its exact scopes and grant). No secret, no workspace name. |
| `provision.yaml` | **What this app owns:** its OAuth client and its test user, in the sandbox named by `{{env.THORYN_ENVIRONMENT}}` (the CLI fills it in from the environment). Nothing workspace-wide. |
| `app-env.mjs` | Resolves `OIDC_ISSUER` / `OIDC_CLIENT_ID` after provisioning. |
| `ci/` | The steps the pipeline runs (`gate.sh`, `login.sh` and `require-vars.sh` read and check the variables). |

## CI

`.github/workflows/ci.yml` runs on every push and pull request:

1. **Build and unit tests** (`dotnet test --solution ThorynStarter.slnx`): the sign-in flow, the logout and
   the API's token checks, against an in-process fake issuer.
2. **Provision the sandbox and run the sign-in journey:** sign in with workload identity (the job's GitHub
   OIDC token is exchanged; nothing is stored), `thoryn provision apply` with a fresh test user, start the
   app, run `e2e/` with Playwright (sign in, call the API, sign out, reset the password through the
   sandbox's test inbox), then remove what the run created.

## Configuration

CI reads its wiring from four **repository variables** (Settings → Secrets and variables → Actions →
Variables). None is a secret. Thoryn's starter flow sets them when it creates the repository.

| Variable | Meaning |
|---|---|
| `THORYN_ISSUER` | The platform base issuer the `thoryn` CLI signs in to, e.g. `https://auth.stg.thoryn.org`. |
| `THORYN_WORKSPACE` | The workspace slug. |
| `THORYN_ENVIRONMENT` | The sandbox this app's client and test user live in. |
| `THORYN_WIF_CLIENT_ID` | The clientId (`wi_…`) of the workload identity trust for this repository in that sandbox. |

If one is missing, the run fails and names it. Two cases skip the Thoryn job with a notice instead:

- the starter template repository itself;
- a pull request from a fork, which gets no OIDC token.

The first run of a freshly created repository can start before the variables exist. It also skips; re-run
it, or push.

To point the app at another sandbox, change `THORYN_ENVIRONMENT` and `THORYN_WIF_CLIENT_ID` (a trust is bound
to one sandbox). No file in the repository changes. Locally, export the same names (see [Run it
locally](#run-it-locally)). The client's display name defaults to the repository's name; set
`THORYN_APP_NAME` to override it.

## Next steps

- Add your own pages behind the session (`.RequireAuthorization()`) or endpoints behind the Bearer check
  (`.RequireAuthorization("api")`), as in `StarterApp.cs`.
- Before you run more than one instance, replace `MemoryTicketStore` with a distributed store and share the
  Data Protection keys.
- Workspace-wide sign-in settings (login methods, branding, email, custom domain) live in the workspace's
  config project, not here.
