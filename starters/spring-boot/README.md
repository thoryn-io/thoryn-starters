# Thoryn Spring Boot starter

A Spring Boot web app that signs users in with Thoryn and protects its own API. It is an **application
project** of a Thoryn workspace and runs against one of its sandbox environments. Which workspace and which
sandbox is not written anywhere in this repository: CI reads them from GitHub Actions variables at run time
(see [Configuration](#configuration)).

- **Sign-in:** Spring Security `oauth2Login`, authorization code with PKCE (S256), `state` and `nonce`. The
  ID token is validated with its signature pinned to ES256. Tokens stay in the server-side session; the
  browser only gets an `HttpOnly`, `SameSite=Lax` session cookie (`COOKIE_SECURE=true` when served over
  https).
- **Sign-out:** RP-initiated logout (`POST /logout` with the CSRF token), which ends the session at Thoryn
  too.
- **Protected API:** `GET /api/me` is an OAuth 2.0 resource server that accepts only a Bearer access token
  Thoryn issued to this app: signature ES256 from the issuer's JWKS, then Spring Security's RFC 9068
  validator (`typ` `at+jwt`, `iss`, `aud`, `client_id`, expiry).
- **CI with no secret:** GitHub Actions signs in to Thoryn with workload identity, provisions the sandbox
  from `.thoryn/provision.yaml` and runs a real browser sign-in against it.

## Run it locally

You need Java 21 or newer, Node.js 22 or newer (for `.thoryn/app-env.mjs` and the e2e journey) and the
[`thoryn` CLI](https://github.com/thoryn-io/thoryn-cli).

No GitHub Actions variable is needed: a local run uses your own `thoryn login` session.

```bash
# Once: sign in to your workspace and pick the sandbox to run against.
thoryn login --issuer https://auth.stg.thoryn.org --workspace <your workspace>
thoryn workspace switch <your workspace>
thoryn env use <your sandbox>

# Once: create your local client and a test user in that sandbox, and write .env.
.thoryn/ci/provision.sh

# Every time:
./mvnw spring-boot:run
```

Open <http://localhost:8080> or <http://127.0.0.1:8080>; both work. Sign in with the test user that
`provision.sh` printed.

- `.thoryn/ci/provision.sh` reads the workspace, the platform and the sandbox from your session. An
  exported `THORYN_ISSUER`, `THORYN_WORKSPACE` or `THORYN_ENVIRONMENT` wins. Instead of `thoryn env use`,
  you can `export THORYN_ENVIRONMENT=<your sandbox>`. A missing value is named, with how to set it.
- It converges a client of your own, `<repository>-local-<your user name>` (set `THORYN_APP_NAME` to choose
  another), so a CI run never deletes the client your local app uses. It then writes `OIDC_ISSUER` and
  `OIDC_CLIENT_ID` to `.env`.
- **The test user.** The first local run generates one: `dev-<your user name>-<random>@example.com`, with a
  random password that meets the sandbox password policy. It writes both to `.thoryn/local.env`, which is
  owner-only (mode 0600) and gitignored, and prints the email, never the password. Later runs reuse the
  file. An exported `THORYN_TEST_USER_EMAIL` / `THORYN_TEST_USER_PASSWORD` wins. The local e2e journey
  (`cd e2e && npx playwright test`) reads the file too, and writes back the new password when its
  password-reset step changes it.
- `provision.sh` refuses production: an application's client and test user live in a sandbox only.
- Your session needs the application and user scopes in that sandbox.
- `thoryn provision destroy --file .thoryn/provision.yaml` removes what your apply created.

**Redirect URIs.** The sandbox client registers two sets of local callbacks, and only the sandbox client
does; never add them to a production client:

- `http://127.0.0.1/callback` and `/signed-out`, RFC 8252 loopback URIs whose port the platform ignores.
  This is the default: the app listens on, and redirects to, `http://127.0.0.1:8080`.
- `http://localhost:8080/callback` and `/signed-out`. The platform matches `localhost` exactly, port
  included. Use them by starting the app with `APP_BASE_URL=http://localhost:8080`.

You need neither variable to browse on either address. Sign-in keeps its session cookie on the host the
browser used, so the app has one canonical local host: its base URL. A GET on another loopback address, for
example <http://localhost:8080> while the base URL is `http://127.0.0.1:8080`, is redirected to the same path
and query on the base URL. Other methods get 400. The redirect is built only from the configured base URL,
never from the Host header, and a deployed app (a non-loopback base URL) is never redirected.

### Where the settings come from

The app reads everything from the environment (`application.yml` also imports `.env`):

| Variable | Meaning |
|---|---|
| `OIDC_ISSUER` | The sandbox's issuer. Resolved at run time by `.thoryn/app-env.mjs`, never committed, so a custom domain needs no change here. |
| `OIDC_CLIENT_ID` | This app's client id, read from the provisioning receipt. |
| `OIDC_AUDIENCE` | Audience the API requires. Default: the issuer (Thoryn lists its issuer in every access token's `aud`). |
| `PORT`, `APP_BASE_URL` | Where the app listens. Default `8080` and `http://127.0.0.1:8080`. |
| `COOKIE_SECURE` | Set to `true` when the app is served over https. |

Add your deployed https URLs to `.thoryn/provision.yaml` when you deploy the app (see "Redirect URIs"
above).

## The `.thoryn/` folder

| File | What it is |
|---|---|
| `template.json` | **What this repository needs from Thoryn:** the Actions variables (see [Configuration](#configuration)), and connection `sandbox`, the workload identity trust CI signs in with (its exact scopes and grant). No secret, no workspace name. |
| `provision.yaml` | **What this app owns:** its OAuth client and its test user, in the sandbox named by `{{env.THORYN_ENVIRONMENT}}` (the CLI fills it in from the environment). Nothing workspace-wide. |
| `app-env.mjs` | Resolves `OIDC_ISSUER` / `OIDC_CLIENT_ID` after provisioning. |
| `ci/` | The steps the pipeline runs (`gate.sh`, `login.sh` and `require-vars.sh` read and check the variables). |

## CI

`.github/workflows/ci.yml` runs on every push and pull request:

1. **Build and unit tests** (`./mvnw verify`): the sign-in flow, the logout and the API's token checks,
   against an in-process fake issuer.
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
to one sandbox). No file in the repository changes. A local run needs none of these variables; it uses
your `thoryn login` session (see [Run it locally](#run-it-locally)). In CI, the client's display name is the
repository's name; set `THORYN_APP_NAME` to override it.

## Next steps

- Add your own pages behind the session (see `PageController`) or endpoints under `/api/**` behind the
  Bearer check (see `ApiController`).
- Move sessions to a shared store (for example Spring Session) before you run more than one instance.
- Workspace-wide sign-in settings (login methods, branding, email, custom domain) live in the workspace's
  config project, not here.
