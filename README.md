# thoryn-starters

The source of truth for Thoryn **starter projects**: templates that become a new repository in the
customer's own GitHub, integrated with a Thoryn workspace, with CI that is green on its first push and holds
**no secret** (it signs in to Thoryn with workload identity).

The starter-project flow (oathy SSO-3310, epic SSO-3304) creates repositories from these templates through
the Thoryn GitHub App and sets their GitHub Actions variables. **Nothing is rendered**: a generated
repository is byte-for-byte its template. It reads its wiring (issuer, workspace, sandbox, workload identity
client id) from Actions variables at run time. See [the variable contract](#the-variable-contract).

## Two kinds of project

A workspace is configured by **one config project** and used by **many application projects**.

| | Config project | Application project |
|---|---|---|
| How many | One per workspace | Many per workspace |
| Contains | Configuration only, no app code | An app (Spring Boot, ASP.NET Core, Express) |
| `.thoryn/provision.yaml` declares | Workspace-wide configuration: environments, federation members / IdPs, login methods, login flows, branding, email provider, custom domain. Production and every sandbox are sections. | Only its own OAuth application client(s) and its own sandbox test users. No environment, no workspace configuration. |
| Sign-in (`connections` in `.thoryn/template.json`) | One per environment section. Each signs in with that environment's workload identity trust; production's trust pins a GitHub environment. | One: the sandbox the app runs against. |
| CI | `thoryn provision plan` on pull requests, `apply` on `main`, per environment. | Build, unit tests, `thoryn provision apply` to the sandbox, a Playwright sign-in journey, teardown. |
| End result | A working sign-in stack, on the customer's own domain once one is configured. | A running app that signs users in and protects its API. |

No project hard-codes its workspace, its environment or its issuer. The Actions variables name the
workspace and the environment. The application's issuer (including an active custom domain) and client id
are **resolved at run time**, after provisioning, by `.thoryn/app-env.mjs`. A custom domain added later
therefore needs no change in any application repository.

## Starters

| Starter | Kind | Stack | Template repository |
|---|---|---|---|
| [`starters/express`](starters/express) | application | Node 22+ / Express 5 / openid-client + jose | `thoryn-io/starter-express` |
| [`starters/spring-boot`](starters/spring-boot) | application | Java 21 / Spring Boot 4.1 / Spring Security 7.1 | `thoryn-io/starter-spring-boot` |
| [`starters/aspnet-core`](starters/aspnet-core) | application | .NET 10 / ASP.NET Core (OpenID Connect + JWT bearer handlers) | `thoryn-io/starter-aspnet-core` |
| [`starters/config`](starters/config) | config | `.thoryn/environments/<section>/` + a plan/apply workflow | `thoryn-io/starter-config` |

Every application starter implements the same contract, so one Playwright journey (`shared/e2e`) tests them
all:

- `GET /login`: authorization code with PKCE (S256), `state` and `nonce`; ID token signature pinned to ES256.
- `GET /profile`: the signed-in page. It calls the app's own API with the session's access token and shows
  the answer.
- `POST /logout`: RP-initiated logout, which ends the session at Thoryn too.
- `GET /api/me`: the protected API. It accepts only a Bearer access token from the app's issuer, signed ES256,
  `typ` `at+jwt` (so an ID token is refused), with `iss`, `aud` (default: the issuer, which Thoryn lists in
  every access token's `aud`, RFC 9068 §2.2), expiry and `client_id` checked. Anything else gets `401` with a
  Bearer challenge.
- `GET /health`: liveness.
- Works out of the box from a local machine, with no Actions variable (SSO-3445):
  1. `thoryn login`, then `thoryn env use <sandbox>`.
  2. `.thoryn/ci/provision.sh`. It creates a local client, generates a sandbox test user into
     `.thoryn/local.env` (0600, gitignored, reused), and writes `.env`.
  3. Start the app: `npm start` / `./mvnw spring-boot:run` / `dotnet run`.

  The app reads `OIDC_ISSUER` and `OIDC_CLIENT_ID` from the environment or `.env`. With a loopback base URL,
  a GET on another loopback host is redirected to the same path and query on the base URL, so
  `http://localhost:8080` and `http://127.0.0.1:8080` both work.
- The **sandbox** client registers two kinds of local callback, and never on production:
  - RFC 8252 loopback URIs, `http://127.0.0.1/callback` and `http://127.0.0.1/signed-out`, whose port
    the platform ignores;
  - `http://localhost:8080/callback` and `http://localhost:8080/signed-out`, the default port, matched
    exactly.

  `npm run check` enforces both, and refuses a plain-http redirect URI on a production client or on a
  non-loopback host.

## The variable contract

A starter carries no per-repository value. Its files are published as they are, and the generated
repository starts with exactly those files.

1. **Declaration.** Each starter has `.thoryn/template.json` (`apiVersion: thoryn.io/starter-template/v2`,
   schema [`schemas/template.schema.json`](schemas/template.schema.json)). It stays in the generated
   repository and declares what the creation flow must set up:
   - `variables`: every GitHub Actions variable, with its `level`. That is `repository`, or `environment`
     plus the GitHub environment's name.
   - `connections`: one per workload identity trust. Each has its `scopes` (exactly what the trust is
     created with and what CI requests), `production` (true or false), the variables carrying its client id
     and sandbox, its provisioning file, and the `grant` its client needs.
   - `github.productionEnvironment` (config only): the GitHub environment the production trust pins and the
     production job runs in.
2. **Run time.** The workflows map `${{ vars.THORYN_* }}` into the job's environment. `.thoryn/ci/login.sh
   <connection>` signs in with the connection's variables and scopes. In `provision.yaml`, the `thoryn` CLI
   fills in `{{env.NAME}}` from the environment when it reads the file, the resource's `environment` too
   (thoryn-cli SSO-3430).
3. **Missing values.** A missing variable fails the run and names it (`.thoryn/ci/require-vars.sh`). The
   Thoryn jobs skip with a notice in three cases:
   - the template repository itself (`github.event.repository.is_template`);
   - a fork's pull request;
   - the first push of a just-created repository when no variable is set yet. The creation flow sets them
     right after it generates the repository, and that first run can start first.
4. **Local runs** need no variable. Whatever is not exported comes from the developer's `thoryn login`
   session, through `thoryn whoami --output json`: the workspace and platform they signed in to, and the
   sandbox `thoryn env use` selected. `app-env.mjs --wiring` prints the resolved values;
   `.thoryn/ci/provision.sh` uses them. An exported value wins, and `app-env.mjs` also takes `--issuer`,
   `--workspace` and `--environment`. CI never falls back to a session.

`npm run check` fails when a render placeholder appears anywhere in this repository, when a starter's
declaration drifts from the contract below, or when a workflow reads an undeclared variable.

### Application project

All four are repository variables.

| Variable | Meaning |
|---|---|
| `THORYN_ISSUER` | Platform base issuer the CLI signs in to, e.g. `https://auth.stg.thoryn.org`. |
| `THORYN_WORKSPACE` | Workspace slug. |
| `THORYN_ENVIRONMENT` | The sandbox the app, its client and its test user live in; the trust is bound to it. |
| `THORYN_WIF_CLIENT_ID` | The trust's `clientId` (`wi_…`). |

Connection `sandbox` has these scopes:

- `tenant:applications.read`, `tenant:applications.write`;
- `tenant:users.read`, `tenant:users.write`;
- `tenant:environments.read`, which reads the sandbox's test inbox.

Its grant is `manager` on the sandbox. The client's display name is its converge key in the sandbox. In CI
it is the repository's name; a local run uses `<repository>-local-<user>`, so a CI run's teardown never
deletes a developer's client. `THORYN_APP_NAME` overrides both. It is not an Actions variable.

### Config project

| Variable | Level | Meaning |
|---|---|---|
| `THORYN_ISSUER` | repository | Platform base issuer. |
| `THORYN_WORKSPACE` | repository | Workspace slug. |
| `THORYN_SANDBOX_ENVIRONMENT` | repository | The first sandbox's slug (production declares it; the sandbox section configures it). |
| `THORYN_SANDBOX_WIF_CLIENT_ID` | repository | The sandbox trust's `clientId`. |
| `THORYN_PRODUCTION_WIF_CLIENT_ID` | environment `thoryn-production` | The production trust's `clientId`; only the production job can read it. |

Connection `production` has `tenant:environments.read/.write` and `tenant:idp.read/.write`. Its grant is
`manager` on the **workspace**, because creating an environment needs `manager` on its parent. Connection
`sandbox` has `tenant:environments.read` and `tenant:idp.read/.write`, with `manager` on the sandbox.

The production GitHub environment's name comes from `github.productionEnvironment`. The workflow reads it
from `template.json`, so it needs no extra variable.

### What the creation flow sets up

All of it goes through product APIs; nothing is seeded.

For an application project:

- the workload identity trust in the sandbox, pinned to the new repository's immutable ids, with exactly
  the connection's scopes;
- `manager` on that sandbox for the trust's client (`client:<wi_…> manager environment:<id>`). Scopes are
  the ceiling, the grant is the gate (ADR 2026-09-15, platform resource authorization);
- the four repository variables.

It does **not** register the application client. The application's own CI does that on its first run
(`thoryn provision apply`), and adopts it on later runs. It does not set the application's issuer or
client id either; those are resolved at run time.

For the config project:

- the sandbox environment itself (its trust must live in it). It is created with the display name the
  production section declares (`Sandbox <slug>`), so the first apply adopts it unchanged;
- the GitHub environment `github.productionEnvironment`, with required reviewers and restricted to `main`;
- a **production** trust pinned to the repository **and** that GitHub environment (`confirmProduction`),
  with the production connection's scopes, and `manager` on the **workspace** for its client. That is the
  widest grant in the model. It is why the production trust accepts only jobs in that GitHub environment
  and never a pull request;
- a **sandbox** trust in the sandbox, with the sandbox connection's scopes, and `manager` on that sandbox
  for its client;
- the four repository variables, and `THORYN_PRODUCTION_WIF_CLIENT_ID` in the production GitHub environment.

## Publishing: one template repository per starter

GitHub creates a repository from a template with one call (`POST /repos/{owner}/{template}/generate`), which
records "generated from" provenance, but only from a whole repository, not from a subdirectory. So each
starter is published as its own template repository, and this repository stays the single place where they
are developed and tested. `.github/workflows/publish.yml` mirrors `starters/<name>/` to
`thoryn-io/starter-<name>` after CI is green on `main`. See [`docs/publishing.md`](docs/publishing.md).

## Staging CI

`.github/workflows/ci.yml` runs on every push and pull request:

- **tooling**: unit tests (CI scripts, `app-env.mjs`, the validator, test-inbox), `shared/` drift check,
  every starter validated as is (no placeholder, declaration against `schemas/template.schema.json` and the
  variable contract, provisioning files against the CLI's schema), actionlint.
- **per starter**: build and unit tests.
- **per starter, staging e2e** (`stack-e2e.yml`): run the starter's own `.thoryn/ci` steps in place, with the
  staging fixture supplied as the same `THORYN_*` environment a generated repository's workflow maps from
  its Actions variables. It skips with a notice until the fixture variables exist.

The staging fixture is one workspace with one sandbox per starter (`ci-<starter>`), each holding a workload
identity trust pinned to `thoryn-io/thoryn-starters`. The one-time setup is in
[`docs/staging-setup.md`](docs/staging-setup.md).

## Working on this repository

```bash
npm ci
npm test                 # CI-script, validator, app-env and test-inbox unit tests
npm run sync             # copy shared/ into every starter (commit the result)
npm run check            # drift check + validate every starter as is
```

`shared/` holds what every application starter carries unchanged: the Playwright journey (`shared/e2e`), the
CI steps (`shared/thoryn/ci`), `app-env.mjs`, the template declaration and the provisioning file. The
config starter shares the CLI installer and the variable and sign-in scripts. Edit it there and run `npm run
sync`; CI fails when a starter's copy drifts.

## Security

- No secrets anywhere: CI signs in with workload identity, the app is a public client using PKCE, the test
  user's password is generated per run and masked, and the session secret is per process.
- Tokens never reach the browser and are never logged.
- The API pins ES256, requires `typ` `at+jwt`, and checks `iss`, `aud`, expiry and `client_id`.
- GitHub Actions are pinned by commit SHA.
