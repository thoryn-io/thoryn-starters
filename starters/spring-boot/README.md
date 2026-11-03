# Thoryn Spring Boot starter

A Spring Boot web app that signs users in with Thoryn and protects its own API. It is an **application
project** of a Thoryn workspace and runs against one of its sandbox environments. Which workspace and which
sandbox is not written anywhere in this repository: CI reads them from GitHub Actions variables at run time
(see [Configuration](#configuration)).

A workspace's provisioning has two parts. Its **config project** declares the tenant: environments, sign-in
methods, branding, users (sandbox test users included), roles, and the workload identity trusts of its
application projects. Each **application project**, like this one, declares only its own OAuth client, in
`.thoryn/provision.yaml` (`apiVersion: thoryn.io/application/v1`), and names the tenant's environment and roles
by slug. Changing the sign-in configuration or adding a custom domain therefore needs no commit here. See
[Product scope](https://thoryn.org/docs/product/scope).

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

# Once: create your local client in that sandbox and write .env.
.thoryn/ci/provision.sh

# An account to sign in with: a disposable sandbox test identity, a day long, in your shell (nothing on disk).
eval "$(thoryn env test-identity create --lifetime PT24H --output env)"

# Every time:
./mvnw spring-boot:run
```

Open <http://localhost:8080> or <http://127.0.0.1:8080>; both work. Sign in with the test identity you minted:
`$THORYN_TEST_USER_EMAIL` and `$THORYN_TEST_USER_PASSWORD` in that shell.

- `.thoryn/ci/provision.sh` reads the workspace, the platform and the sandbox from your session. An
  exported `THORYN_ISSUER`, `THORYN_WORKSPACE` or `THORYN_ENVIRONMENT` wins. Instead of `thoryn env use`,
  you can `export THORYN_ENVIRONMENT=<your sandbox>`. A missing value is named, with how to set it.
- It converges a client of your own, `<repository>-local-<your user name>` (set `THORYN_APP_NAME` to choose
  another), so a CI run never deletes the client your local app uses. It then writes `OIDC_ISSUER` and
  `OIDC_CLIENT_ID` to `.env`.
- **The test account** is an ephemeral sandbox **test identity** (oauthy ADR 2026-10-30), never a user this
  repository declares: `thoryn env test-identity create --lifetime PT24H --output env` mints one under your
  own login — a synthetic `ti-…@sandbox.thoryn.invalid` address, email verified, a password the platform
  generates and shows once — and the `eval` exports it as `THORYN_TEST_USER_EMAIL`,
  `THORYN_TEST_USER_PASSWORD` and `THORYN_TEST_IDENTITY_ID`. It is never written to a file; it is erased after
  24 hours, or now with `thoryn env test-identity revoke "$THORYN_TEST_IDENTITY_ID"`. Mint again when it has
  expired. An exported `THORYN_TEST_USER_EMAIL` / `THORYN_TEST_USER_PASSWORD` (a sandbox user of your own) wins.
- The local e2e journey (`cd e2e && npx playwright test`) reads the same two variables from your shell. Its
  forgot-password step changes the identity's password, so mint again (`eval` the line once more) before you
  run the journey a second time.
- `provision.sh` refuses production: an application's client lives in a sandbox only, and a test identity can
  only be minted in a sandbox (the API refuses production).
- Your session needs the application scopes in that sandbox, and `tenant:test-identities.write` to mint.
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
| `OIDC_CLIENT_ID` | This app's client id, read from the `thoryn provision apply --output json` result `provision.sh` saves outside the repository (`$RUNNER_TEMP` in CI, the gitignored `.thoryn/last-apply.json` locally). The CLI keeps no receipt. |
| `OIDC_AUDIENCE` | Audience the API requires. Default: the issuer (Thoryn lists its issuer in every access token's `aud`). |
| `PORT`, `APP_BASE_URL` | Where the app listens. Default `8080` and `http://127.0.0.1:8080`. |
| `COOKIE_SECURE` | Set to `true` when the app is served over https. |

Add your deployed https URLs to `.thoryn/provision.yaml` when you deploy the app (see "Redirect URIs"
above).

## The `.thoryn/` folder

| File | What it is |
|---|---|
| `template.json` | **What this repository needs from Thoryn:** the Actions variables (see [Configuration](#configuration)), and connection `sandbox`, the workload identity trust CI signs in with (its exact scopes and grant). No secret, no workspace name. |
| `provision.yaml` | **What this app owns** (`apiVersion: thoryn.io/application/v1`): its OAuth client, in the sandbox named by `{{env.THORYN_ENVIRONMENT}}` (the CLI fills it in from the environment). Nothing workspace-wide, and no user: the test account is minted per run, not declared. |
| `app-env.mjs` | Resolves `OIDC_ISSUER` / `OIDC_CLIENT_ID` from an apply's result: the sandbox's after provisioning, or — `--production` — the production apply's, for the deploy (see [Production](#production)). |
| `production/` | The **production** client (`provision.yaml`) and who applies it (`declaration.json`: the production trust and the two variables of the GitHub environment `production`). |
| `ci/` | The steps the pipeline runs (`gate.sh`, `login.sh` and `require-vars.sh` read and check the variables). |

## CI

`.github/workflows/ci.yml` runs on every push and pull request:

1. **Build and unit tests** (`./mvnw verify`): the sign-in flow, the logout and the API's token checks,
   against an in-process fake issuer.
2. **Provision the sandbox and run the sign-in journey:** sign in with workload identity (the job's GitHub
   OIDC token is exchanged; nothing is stored), `thoryn provision apply`, mint one ephemeral test identity
   for the run (`thoryn env test-identity create --output github-env`: the password is masked, then handed to
   the next steps), start the app, run `e2e/` with Playwright (sign in, call the API, sign out, reset the
   password through the sandbox's test inbox), then remove what the run created: revoke the identity and
   destroy the client only when this run's apply created it (`.thoryn/ci/teardown.sh`, `if: always()`). A
   client that already existed, which the apply only converged, stays.

`.github/workflows/deploy.yml` runs on every push to `main`: it applies the app's production client, then deploys
(see [Production](#production)). It skips with a notice until the production trust and URL are set.

## Configuration

CI reads its wiring from four **repository variables** (Settings → Secrets and variables → Actions →
Variables). None is a secret. Thoryn's starter flow sets them when it creates the repository.

| Variable | Meaning |
|---|---|
| `THORYN_ISSUER` | The platform base issuer the `thoryn` CLI signs in to, e.g. `https://auth.stg.thoryn.org`. |
| `THORYN_WORKSPACE` | The workspace slug. |
| `THORYN_ENVIRONMENT` | The sandbox this app's client lives in and where its per-run test identity is minted. |
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

## Production

This repository owns its production OAuth client, as it owns its sandbox one (oauthy ADR 2026-10-25). The
production client is declared in `.thoryn/production/provision.yaml`: clientId `<repository>-production`, the
deployed `https` redirect URIs, never a loopback one.

`.github/workflows/deploy.yml` runs on every push to `main`. Its job `deploy-production` runs in the GitHub
environment `production`; add required reviewers there to approve each run. It:

1. signs in with workload identity as this repository's **production trust** (no stored secret), with the
   application scopes only;
2. runs `thoryn provision apply` on the workspace's production plane (`.thoryn/ci/production-apply.sh`);
3. runs `node .thoryn/app-env.mjs --production --github-env`. That composes `https://<workspace>.<platform host>`
   (no environment path), fetches its discovery document and exports the `issuer` it publishes as `OIDC_ISSUER`,
   and `OIDC_CLIENT_ID` from step 2's result;
4. ends in a placeholder step for your deployment. `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `THORYN_PRODUCTION_URL`
   (the app's `APP_BASE_URL`) are ready for it.

**Set it up once:**

1. **The production trust.** The workspace's **config** project declares it (`kind: workloadIdentityTrust`,
   pinned to this repository and its GitHub environment `production`, scopes `tenant:applications.read`,
   `tenant:applications.write`, `tenant:access.read`). This repository never declares its own trust. Set the
   trust's clientId on the environment: `gh variable set THORYN_PRODUCTION_WIF_CLIENT_ID --env production --body
   <wi_…>`.
2. **The deployed URL.** `gh variable set THORYN_PRODUCTION_URL --env production --body https://<your app>`.
3. **The creation slot.** The first run after that is red, by design. Creating an application on the production
   plane needs a workspace admin's approval for exactly this name (a creation slot, oauthy ADR 2026-10-17). The
   run's log names the command, and a workspace admin runs it: `thoryn access reserve client:<wi_…>
   application:<repository>-production --environment production`. Re-run the job: it creates the client, and
   this repository owns it from then on.

Until both variables are set the job skips with a notice, so a new repository stays green. If only one is set,
the job fails and names the other. `THORYN_PRODUCTION_CLIENT_ID`, the hand-set id the job read before, is
retired.

## Next steps

- Add your own pages behind the session (see `PageController`) or endpoints under `/api/**` behind the
  Bearer check (see `ApiController`).
- Move sessions to a shared store (for example Spring Session) before you run more than one instance.
- Workspace-wide sign-in settings (login methods, branding, email, custom domain) live in the workspace's
  config project, not here.
