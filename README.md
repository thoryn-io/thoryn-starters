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
| Provisioning declares | **Tenant provisioning** (`apiVersion: thoryn.io/tenant/v1`, one file per section under `.thoryn/environments/<section>/`): environments, federation members / IdPs, users (sandbox test users included), login methods, login flows, branding, email provider, custom domain, roles. Production and every sandbox are sections. | Its own OAuth application client(s) in `.thoryn/provision.yaml`, plus (until the application starters move to `thoryn.io/application/v1`) its own sandbox test user. No environment, no workspace configuration. |
| Sign-in (`connections` in `.thoryn/template.json`) | One per environment section. Each signs in with that environment's workload identity trust; production's trust pins a GitHub environment. | One: the sandbox the app runs against. |
| CI | The provisioning **stub** the creation flow seeds (`.github/workflows/thoryn-provisioning.yml`, calling thoryn-cli's reusable workflow at a `cli-v*` release), dispatched by the Thoryn GitHub App: `thoryn provision plan` on pull requests (read-only plan profile), `apply` on `main` behind the reviewed production environment. The template itself ships no workflow (SSO-3971). | Build, unit tests, `thoryn provision apply` to the sandbox, a Playwright sign-in journey, teardown. Plus a production deploy skeleton (`deploy.yml`) that reads the client id the config project published. |
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
| [`starters/config`](starters/config) | config | `.thoryn/environments/<section>/provision.yaml` (`thoryn.io/tenant/v1`); the creation flow seeds the provisioning stub | `thoryn-io/starter-config` |

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
2. **Run time.** An application starter's workflows map `${{ vars.THORYN_* }}` into the job's environment. `.thoryn/ci/login.sh
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
- `tenant:environments.read`, which reads the sandbox's test inbox;
- `tenant:access.read`, the ownership check (`POST /api/v1/access/check`) `thoryn provision plan` makes for every
  declared resource.

Those are the scopes `thoryn provision workflow check` (cli-v0.44.0 and later, rule `config.trust-scopes`) derives
from the files the creation flow commits, so a generated repository's first plan does not stop on a `403`.

Its grant is `manager` on the sandbox. The client's display name is its converge key in the sandbox. In CI
it is the repository's name; a local run uses `<repository>-local-<user>`, so a CI run's teardown never
deletes a developer's client. `THORYN_APP_NAME` overrides both. It is not an Actions variable.

**One variable the creation flow does not set: `THORYN_PRODUCTION_CLIENT_ID`** (SSO-3666; oauthy ADR
2026-10-13, production clients declared in the config project). An application's production OAuth client is
declared in the workspace's **config** project and converged by its reviewed production run; that run
publishes the client's id into the application repository as a variable of the GitHub environment
`production`. The application's `deploy.yml` reads it there and resolves its settings with
`app-env.mjs --production` (workspace issuer, no environment path; client id from the variable). It is **not**
declared in `template.json`: the declaration lists what the creation flow sets, and the orchestrator refuses
an application declaration that is not exactly the four variables above — the manifest has no way yet to
mark a variable another project publishes (a recorded gap). `npm run check` therefore lets a workflow read
`vars.THORYN_PRODUCTION_CLIENT_ID` undeclared (like `THORYN_CLI_VERSION`), requires the application starters
to do so, and refuses a job in the `production` GitHub environment that requests `id-token: write` or signs in
to Thoryn: the app repository has no production identity. Guide:
<https://thoryn.org/docs/guides/production-client-from-the-config-project>.

### Config project

| Variable | Level | Meaning |
|---|---|---|
| `THORYN_ISSUER` | repository | Platform base issuer. |
| `THORYN_WORKSPACE` | repository | Workspace slug. |
| `THORYN_SANDBOX_ENVIRONMENT` | repository | The first sandbox's slug (production declares it; the sandbox section configures it). |
| `THORYN_SANDBOX_WIF_CLIENT_ID` | repository | The sandbox trust's `clientId`. |
| `THORYN_PRODUCTION_WIF_CLIENT_ID` | environment `thoryn-production` | The production trust's `clientId`; only the production job can read it. |

Both connections request **read and write for every tenant kind** (SSO-3993): `tenant:<area>.read` and
`.write` for `workload-identity`, `access`, `environments`, `applications`, `users`, `idp`, `federation`,
`email`, `domains`, `roles` and `legal-documents` — thoryn-cli's `ScopeRequirements.AREAS` plus `access`, the same list
the `starters` sign-in client holds (thoryn-provisioning SSO-3992). `legal-documents` (SSO-4058) is for the workspace's
terms of use and privacy policy, which the `legalDocument` kind of a coming CLI release manages; it is listed ahead of
that release so a config project created from now on can carry it. It is a narrow pair of its own: a config project
never gets `tenant:compliance.*`, whose `.write` also gates erasure requests, DSAR, SCIM deprovisioning and retention.
Holding every kind's pair lets the import pull request read the whole tenant and every imported entry be converged;
the production trust's plan profile is minted every `.read` member. `npm run check` fails a config connection that lacks one. Connection `production`'s grant is `manager`
on the **workspace**, because creating an environment needs `manager` on its parent; connection `sandbox`'s is
`manager` on the sandbox, so the grant (not the scopes) keeps it inside that sandbox. A trust can carry only
scopes the person creating it holds, so creating a config project from this template needs a wizard token with
all of them (thoryn-provisioning #39; for `legal-documents`, the `starters` client must hold it and the web flow request
it, SSO-4058); before that, the creation is refused `scope_not_grantable` and nothing is created. A config project created
before a scope was added keeps its narrower trusts: the wizard's Your setups names the scopes it is missing and how to
add them.

The template's two sections declare **only the sandbox environment the setup creates** — production owns it
(`retain: true`), the sandbox section anchors on it `readOnly: true`, both by slug only — and every other
tenant kind as a commented example. So merging the setup pull request changes nothing that already exists in
the workspace; its current configuration arrives through the import pull request (thoryn-provisioning ADR
`2026-09-30-starter-orchestrator-service.md` §13, SSO-3995). `npm run check` fails a config section that
declares anything else.

The production GitHub environment's name comes from `github.productionEnvironment` (`thoryn-production`); the
production trust's read-only plan profile is keyed on its `-plan` sibling (`thoryn-production-plan`). Nothing in a
config project reads these variables at run time any more (SSO-3971): its provisioning runs in thoryn-cli's
reusable workflow, signed in with each section's `connection.json`, and the stub names both GitHub environments.
The creation flow still sets them, because the declaration (shared with the orchestrator) fixes them.

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

- the sandbox environment itself (its trust must live in it), unless an existing one was chosen. The
  production section declares it by slug only, so the first apply adopts it unchanged, whatever its display
  name;
- the GitHub environment `github.productionEnvironment`, with required reviewers and restricted to `main`;
- a **production** trust pinned to the repository **and** that GitHub environment (`confirmProduction`),
  with the production connection's scopes, and `manager` on the **workspace** for its client. That is the
  widest grant in the model. It is why the production trust is minted write scopes only in that GitHub
  environment. Its **plan profile** is keyed on `thoryn-production-plan`, where a pull request's plan job is
  minted only the trust's read scopes;
- a **sandbox** trust in the sandbox, with the sandbox connection's scopes, and `manager` on that sandbox
  for its client;
- the four repository variables, and `THORYN_PRODUCTION_WIF_CLIENT_ID` in the production GitHub environment;
- the files the template does not carry, because they name this repository's own trusts (SSO-3971): each
  section's `connection.json`, the stub `.github/workflows/thoryn-provisioning.yml`, `.thoryn/workflow.yaml`,
  and `.github/CODEOWNERS` naming the reviewers. `thoryn project init config` also writes both sections'
  `provision.yaml` with the sandbox named literally; the Thoryn GitHub App keeps the template's and supplies
  `THORYN_SANDBOX_ENVIRONMENT` in `.thoryn/workflow.yaml`'s `env:`.

## Publishing: one template repository per starter

GitHub creates a repository from a template with one call (`POST /repos/{owner}/{template}/generate`), which
records "generated from" provenance, but only from a whole repository, not from a subdirectory. So each
starter is published as its own template repository, and this repository stays the single place where they
are developed and tested. `.github/workflows/publish.yml` mirrors `starters/<name>/` to
`thoryn-io/starter-<name>` after CI is green on `main`, then verifies from a fresh clone that the template
repository holds exactly those files; an unconfigured publisher fails the run (SSO-3675). See
[`docs/publishing.md`](docs/publishing.md).

## Staging CI

`.github/workflows/ci.yml` runs on every push and pull request:

- **tooling**: unit tests (CI scripts, `app-env.mjs`, the validator, test-inbox), `shared/` drift check,
  every starter validated as is (no placeholder, declaration against `schemas/template.schema.json` and the
  variable contract, provisioning files against the CLI's schema, the production deploy skeleton's
  no-identity shape, and — SSO-3971 — the config starter's sections as `thoryn.io/tenant/v1` with no workflow,
  CI script, `.thoryn/workflow.yaml` or `connection.json` of its own; SSO-3993 — declaring only the sandbox
  environment, with every connection requesting every tenant kind's scopes), actionlint.
- **config — staging plan**: the config starter's sandbox section planned against the staging fixture, signed
  in with the shared installer and sign-in script. That `thoryn project init config`'s output (template plus
  seeds) loads as tenant files and passes `thoryn provision workflow check` is pinned in thoryn-cli
  (`ProjectInitConfigWorkflowTest`).
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
config starter shares nothing: it carries no CI script (SSO-3971). Edit `shared/` and run `npm run sync`; CI
fails when a starter's copy drifts.

## Security

- No secrets anywhere: CI signs in with workload identity, the app is a public client using PKCE, the test
  user's password is generated per run and masked, and the session secret is per process.
- Tokens never reach the browser and are never logged.
- The API pins ES256, requires `typ` `at+jwt`, and checks `iss`, `aud`, expiry and `client_id`.
- GitHub Actions are pinned by commit SHA.
