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
| Provisioning declares | **Tenant provisioning** (`apiVersion: thoryn.io/tenant/v1`, one file per section under `.thoryn/environments/<section>/`): environments, federation members / IdPs, users (sandbox test users included), login methods, login flows, branding, email provider, custom domain, roles. Production and every sandbox are sections. | **Application provisioning** (`apiVersion: thoryn.io/application/v1`, `.thoryn/provision.yaml`): its own OAuth application client(s). No environment, no user, no workspace configuration. The account its e2e signs in with is not declared: CI **mints** an ephemeral sandbox test identity per run (`thoryn env test-identity create`, oauthy ADR 2026-10-30) and revokes it afterwards. |
| Sign-in (`connections` in `.thoryn/template.json`) | One per environment section. Each signs in with that environment's workload identity trust; production's trust pins a GitHub environment. | One in `template.json`: the sandbox the app runs against. Its production trust (declared by the config project) signs in from `deploy.yml`, described in `.thoryn/production/declaration.json`. |
| CI | The provisioning **stub** the creation flow seeds (`.github/workflows/thoryn-provisioning.yml`, calling thoryn-cli's reusable workflow at a `cli-v*` release), dispatched by the Thoryn GitHub App: `thoryn provision plan` on pull requests (read-only plan profile), `apply` on `main` behind the reviewed production environment. The template itself ships no workflow (SSO-3971). | Build, unit tests, `thoryn provision apply` to the sandbox, one minted test identity, a Playwright sign-in journey, teardown (revoke the identity, destroy what the run created). Plus `deploy.yml`: on `main`, in the reviewed `production` environment, it applies the app's own production client (created once under an admin-approved creation slot) and hands the deploy step the client id from that apply (SSO-4120). |
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
  2. `.thoryn/ci/provision.sh`. It creates a local client and writes `.env`.
  3. Start the app: `npm start` / `./mvnw spring-boot:run` / `dotnet run`.
  4. An account to sign in with: `eval "$(thoryn env test-identity create --lifetime PT24H --output env)"` mints
     a disposable sandbox test identity (a day long, under your own login) into your shell as
     `THORYN_TEST_USER_EMAIL` / `THORYN_TEST_USER_PASSWORD`; the e2e journey reads the same two. Nothing is
     written to a file (SSO-4087 retired the generated `.thoryn/local.env` test user).

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
declaration drifts from the contract below, or when a workflow reads an undeclared variable. It also fails a
workflow job (a starter's or this repository's own) that runs the `thoryn` CLI without
`THORYN_CI_PLAINTEXT_TOKENS: "1"` in its env (SSO-4095): a GitHub-hosted runner has no OS keychain and is discarded
after the job, so the CLI stores its token in a file only on that documented CI opt-in, and without it
`thoryn login --workload-identity` fails before anything is provisioned.

### Application project

All four are repository variables.

| Variable | Meaning |
|---|---|
| `THORYN_ISSUER` | Platform base issuer the CLI signs in to, e.g. `https://auth.stg.thoryn.org`. |
| `THORYN_WORKSPACE` | Workspace slug. |
| `THORYN_ENVIRONMENT` | The sandbox the app and its client live in and where its per-run test identity is minted; the trust is bound to it. |
| `THORYN_WIF_CLIENT_ID` | The trust's `clientId` (`wi_…`). |

Connection `sandbox` has exactly these scopes (`APPLICATION_SCOPES` in `scripts/validate-templates.mjs`; `npm run check`
fails any other set):

- `tenant:applications.read`, `tenant:applications.write`, the application file's own ceiling;
- `tenant:access.read`, the ownership check (`POST /api/v1/access/check`) `thoryn provision plan` makes for every
  declared resource;
- `tenant:environments.read`, which reads the sandbox's test inbox and resolves `--env <slug>`;
- `tenant:test-identities.write`, which mints and revokes the run's test identity (oauthy ADR 2026-10-30).

**No `tenant:users.*`** (SSO-4087): an application defines no user of the tenant. Until then the connection
held `tenant:users.read` / `.write` for a `kind: user` the application file declared; the mint replaced both.
`thoryn provision workflow check` (rule `config.trust-scopes`) derives the first three from the application file
and, since cli-v0.57.0, accepts the two sandbox tool scopes on an application file's trust, so a generated
repository's first plan does not stop on a `403`. The application starters need cli-v0.57.0 or newer
(`install-cli.sh` fails an older release before anything is provisioned).

Its grant is `manager` on the sandbox. The client's display name is its converge key in the sandbox. In CI
it is the repository's name; a local run uses `<repository>-local-<user>`, so a CI run's teardown never
deletes a developer's client. `THORYN_APP_NAME` overrides both. It is not an Actions variable.

**The production connection is not in `template.json`** (SSO-4120). The application project owns its production
client (oauthy ADR 2026-10-25 decision 1). `deploy.yml`'s job `deploy-production` runs on `main` in the GitHub
environment `production` and signs in as the repository's **production trust**. It converges
`.thoryn/production/provision.yaml` (`.thoryn/ci/production-apply.sh`) and resolves its settings with
`app-env.mjs --production`: workspace issuer, no environment path, and the client id from that apply's
`--output json` result. The connection and its two variables are declared in `.thoryn/production/declaration.json`,
both in the GitHub environment `production`:

| Variable | Meaning |
|---|---|
| `THORYN_PRODUCTION_WIF_CLIENT_ID` | The production trust's `clientId`, set by the setup. The trust is pinned to this repository and its `production` environment; the workspace's **config** project declares and owns it (ADR 2026-10-25 decision 3, ADR 2026-11-03, SSO-4079). An application project never declares its own trust. |
| `THORYN_PRODUCTION_URL` | The deployed app's https base URL. The production client's redirect URIs are `<url>/callback` and `<url>/signed-out`. |

They are not in `template.json` because every released `thoryn` CLI, and the orchestrator, refuse an application
template with a production connection or any variable beyond the four above. When the workspace has a config project,
the setup reads `declaration.json`, creates the production trust and sets `THORYN_PRODUCTION_WIF_CLIENT_ID` (see
[What the creation flow sets up](#what-the-creation-flow-sets-up)); `THORYN_PRODUCTION_URL` is yours to set. Until both
variables are set the job skips with a notice.

The production client has a **fixed** id, `<repository>-production` (`{{env.THORYN_APP_NAME}}-production`), because
a creation slot binds a name (oauthy ADR 2026-10-17). The trust holds the application ceiling only
(`tenant:applications.read`, `tenant:applications.write`, `tenant:access.read`). That does not reach the production
plane, so the first run's plan is refused and names the slot: `thoryn access reserve client:<wi_…>
application:<repository>-production --environment production`. The run's log prints that command and the job
uploads the fix request (`thoryn-provision-request`). The Thoryn GitHub App does not relay it: it completes only the
check runs of the provisioning runs it dispatches. After one admin approval, the next run creates the client and the
repository owns it; every later run converges it.

`npm run check` holds the shape. The production connection requests exactly the application ceiling. The production
file declares only `application` resources, on the production plane, with that fixed clientId and https redirect URIs
on `THORYN_PRODUCTION_URL`. Exactly one job runs in `production`: on `main` only, with `id-token: write`, the
production apply before `app-env.mjs --production`, and no sandbox step. No other job runs the production apply.
`vars.THORYN_PRODUCTION_CLIENT_ID`, the hand-set id this replaces (SSO-3666), is retired: a workflow that reads it
fails.

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
terms of use and privacy policy, which the `legalDocument` kind manages (thoryn-cli cli-v0.55.0, SSO-4057); the
config sections carry a commented example. It is a narrow pair of its own: a config project
never gets `tenant:compliance.*`, whose `.write` also gates erasure requests, DSAR, SCIM deprovisioning and retention.
Holding every kind's pair lets the import pull request read the whole tenant and every imported entry be converged;
the production trust's plan profile is minted every `.read` member. `npm run check` fails a config connection that lacks one. Connection `production`'s grant is `manager`
on the **workspace**, because creating an environment needs `manager` on its parent; connection `sandbox`'s is
`manager` on the sandbox, so the grant (not the scopes) keeps it inside that sandbox. A trust can carry only
scopes the person creating it holds, so creating a config project from this template needs a wizard token with
all of them (thoryn-provisioning #39; for `legal-documents`, #62 / #63, SSO-4058); before that, the creation is refused `scope_not_grantable` and nothing is created. A config project created
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

When the workspace has a config project, the creation flow also sets up what the config project declares and owns
(oauthy ADR 2026-11-03, SSO-4079). It needs a version of the Thoryn GitHub App or `thoryn project init app
--config-repo` that ships SSO-4079:

- a **production** trust, read from `.thoryn/production/declaration.json`, not `template.json`, so that older CLIs
  keep accepting the template. The person setting up creates it, because a machine cannot create a production trust.
  It is pinned to the repository, its GitHub environment `production` and `main`, with exactly
  `tenant:applications.read`, `tenant:applications.write` and `tenant:access.read`, and no grant and no plan
  profile. Its client creates the application's production client under a creation slot a workspace admin approves
  (oauthy ADR 2026-10-17);
- the GitHub environment `production`, restricted to `main`, and `THORYN_PRODUCTION_WIF_CLIENT_ID` in it.
  `THORYN_PRODUCTION_URL` is yours to set (`--production-url` sets it from the CLI);
- `owner` on both trusts for the config project's identity on each plane. Only a workspace admin can grant it. When
  the person setting up is not an admin, the config project's first plan asks an admin for it through consent;
- a pull request on the config repository, from the branch `thoryn/app-<repository>`, that declares both trusts
  exactly as they are live. The setup pull request names it.

Without a config project, the creation flow creates the sandbox trust only and says that nothing owns it yet.
Setting up the config project later imports the trusts its identity can see.

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
  variable contract, provisioning files against the CLI's schema, the production apply-and-deploy
  job's shape (SSO-4120), and — SSO-3971 — the config starter's sections as `thoryn.io/tenant/v1` with no workflow,
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
  identity's password is generated by the platform, returned once, masked in the job log and revoked at the
  end of the run (never written to a file, in CI or locally), and the session secret is per process.
- Tokens never reach the browser and are never logged.
- The API pins ES256, requires `typ` `at+jwt`, and checks `iss`, `aud`, expiry and `client_id`.
- GitHub Actions are pinned by commit SHA.
