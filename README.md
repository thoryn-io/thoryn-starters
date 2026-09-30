# thoryn-starters

The source of truth for Thoryn **starter projects**: templates that become a new repository in the
customer's own GitHub, integrated with a Thoryn workspace, with CI that is green on its first push and holds
**no secret** (it signs in to Thoryn with workload identity).

The starter-project flow in the console (oathy SSO-3310, epic SSO-3304) creates repositories from these
templates through the Thoryn GitHub App, renders their `.thoryn/` files (see [the render
contract](#the-render-contract)) and sets their Actions variables.

## Two kinds of project

A workspace is configured by **one config project** and used by **many application projects**.

| | Config project | Application project |
|---|---|---|
| How many | One per workspace | Many per workspace |
| Contains | Configuration only, no app code | An app (Spring Boot, ASP.NET Core, Express) |
| `.thoryn/provision.yaml` declares | Workspace-wide configuration: environments, federation members / IdPs, login methods, login flows, branding, email provider, custom domain. Production and every sandbox are sections. | Only its own OAuth application client(s) and its own sandbox test users. No environment, no workspace configuration. |
| `.thoryn/connection.json` | One per environment. Each signs in with that environment's workload identity trust; production's trust pins a GitHub environment. | The workspace and the one sandbox environment the app runs against. |
| CI | `thoryn provision plan` on pull requests, `apply` on `main`, per environment. | Build, unit tests, `thoryn provision apply` to the sandbox, a Playwright sign-in journey, teardown. |
| End result | A working sign-in stack, on the customer's own domain once one is configured. | A running app that signs users in and protects its API. |

An application project never hard-codes its issuer. `.thoryn/connection.json` names the workspace and the
environment; the application's issuer (including an active custom domain) and client id are **resolved at
run time**, after provisioning, by `.thoryn/app-env.mjs`. A custom domain added later therefore needs no
change in any application repository.

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
- One-command local run from environment variables (`OIDC_ISSUER`, `OIDC_CLIENT_ID`; `.env` is written by
  `node .thoryn/app-env.mjs --write .env`).
- Redirect URIs are RFC 8252 loopback URIs (`http://127.0.0.1/callback`, `http://127.0.0.1/signed-out`);
  the platform ignores their port.

## The render contract

A template carries placeholders that the creation flow replaces once, when it creates the repository. This
repository's CI renders every starter the same way before it runs it (`render/render.mjs` is the executable
definition; `render/render.test.mjs` pins its behaviour).

1. **Manifest.** Each template has `.thoryn/template.json` (`apiVersion: thoryn.io/starter-template/v1`). It
   declares the template `kind` (`application` or `config`), the `variables` (each with an anchored
   `pattern`, a `description` and an `example`), the `files` to render, and the `actionsVariables` the
   repository needs.
2. **Placeholders.** `{{thoryn.<variable>}}`, optionally with spaces inside the braces. They appear only in
   the files the manifest lists. `{{env.NAME}}` in `provision.yaml` is not a render placeholder: the `thoryn`
   CLI resolves it from the environment at apply time.
3. **Values.** Every declared variable needs a value, no undeclared value is accepted, and every value must
   match its variable's `pattern`. The patterns admit only characters that are safe inside a JSON string, a
   quoted YAML scalar and Markdown, so a value cannot break out of the file it lands in.
4. **Render.** Replace the placeholders in the listed files, then fail if any `{{thoryn.` token is left
   anywhere in the repository.
5. **Drop the manifest.** Delete `.thoryn/template.json`. A starter's pipeline treats the presence of that
   file as "this is the unrendered template" and skips its Thoryn jobs with a notice (build and unit tests
   still run), so the template repository itself and a half-created repository are never red.

### Application template variables

| Variable | Used in | Meaning | Example |
|---|---|---|---|
| `workspace` | connection.json, README | Workspace slug | `acme` |
| `environment` | connection.json, provision.yaml, README | The sandbox the app, its client and its test user live in; the trust is bound to it | `dev` |
| `workloadIdentityClientId` | connection.json | The trust's `clientId` (`wi_…`) | `wi_0123456789abcdef01234567` |
| `githubOwner`, `githubRepository` | connection.json, README | The repository the trust pins (diagnostics only; the trust itself pins the immutable ids) | `acme`, `billing-web` |
| `appName` | provision.yaml | Display name of the app's OAuth client; its converge key in the environment | `billing-web` |

### Config template variables

| Variable | Used in | Meaning | Example |
|---|---|---|---|
| `workspace` | both connection.json, README | Workspace slug | `acme` |
| `sandboxEnvironment` | sandbox section, production provision.yaml, README | The first sandbox's slug (production declares it; the sandbox section configures it) | `dev` |
| `productionWorkloadIdentityClientId` | production connection.json | The production trust's `clientId` | `wi_…prod` |
| `sandboxWorkloadIdentityClientId` | sandbox connection.json | The sandbox trust's `clientId` | `wi_…dev` |
| `githubEnvironment` | production connection.json, README | The GitHub environment the production trust pins; the production job runs in it | `thoryn-production` |
| `githubOwner`, `githubRepository` | both connection.json, README | The repository the trusts pin | `acme`, `thoryn-config` |

The workflow reads the production job's GitHub environment from the production `connection.json`, so the
workflow file itself is not rendered (an unrendered placeholder there would break the template
repository's own CI).

### What the creation flow sets up besides the files

For an application project (all through product APIs, nothing seeded):

- the workload identity trust in the sandbox, pinned to the new repository's immutable ids, with exactly
  the scopes in `.thoryn/connection.json`: `tenant:applications.read`, `tenant:applications.write`,
  `tenant:users.read`, `tenant:users.write`, `tenant:environments.read` (the last one reads the sandbox's
  test inbox);
- `manager` on that sandbox for the trust's client (`client:<wi_…> manager environment:<id>`): scopes are
  the ceiling, the grant is the gate (ADR 2026-09-15, platform resource authorization);
- the Actions variable `THORYN_ISSUER`: the platform base issuer the CLI signs in to (for example
  `https://auth.stg.thoryn.org`). The CLI has no built-in production issuer yet, so it is required for now.

It does **not** register the application client: the application's own CI does that on its first run
(`thoryn provision apply`), and adopts it on later runs. It does not set the application's issuer or client
id either; those are resolved at run time.

For the config project:

- the sandbox environment itself (its trust must live in it), created with the display name the production
  section declares (`Sandbox <slug>`) so the first apply adopts it unchanged;
- a **production** trust pinned to the repository **and** the GitHub environment `githubEnvironment`
  (`confirmProduction`), with the production connection's scopes (`tenant:environments.read/.write`,
  `tenant:idp.read/.write`), and `manager` on the **workspace** for its client, because creating an
  environment needs `manager` on its parent. That is the widest grant in the model, and it is why the
  production trust accepts only jobs in that GitHub environment and never a pull request;
- a **sandbox** trust in the sandbox, with the sandbox connection's scopes (`tenant:environments.read`,
  `tenant:idp.read/.write`), and `manager` on that sandbox for its client;
- the Actions variable `THORYN_ISSUER`.

GitHub creates the GitHub environment the first time the production job references it; add required
reviewers there.

## Publishing: one template repository per starter

GitHub creates a repository from a template with one call (`POST /repos/{owner}/{template}/generate`), which
records "generated from" provenance, but only from a whole repository, not from a subdirectory. So each
starter is published as its own template repository, and this repository stays the single place where they
are developed and tested. `.github/workflows/publish.yml` mirrors `starters/<name>/` to
`thoryn-io/starter-<name>` after CI is green on `main`. See [`docs/publishing.md`](docs/publishing.md).

## Staging CI

`.github/workflows/ci.yml` runs on every push and pull request:

- **tooling**: renderer and helper unit tests, `shared/` drift check, every starter rendered with its example
  values and validated against the CLI's connection and provisioning schemas (`schemas/`), actionlint.
- **per starter**: build and unit tests.
- **per starter, staging e2e** (`stack-e2e.yml`): render the starter with the staging fixture, then run its
  own `.thoryn/ci` steps exactly as a generated repository does. It skips with a notice until the fixture
  variables exist.

The staging fixture is one workspace with one sandbox per starter (`ci-<starter>`), each holding a workload
identity trust pinned to `thoryn-io/thoryn-starters`. The one-time setup is in
[`docs/staging-setup.md`](docs/staging-setup.md).

## Working on this repository

```bash
npm ci
npm test                 # renderer, app-env and test-inbox unit tests
npm run sync             # copy shared/ into every application starter (commit the result)
npm run check            # drift check + render and validate every starter
node render/render.mjs --template starters/express --out /tmp/acme-web --example
```

`shared/` holds what every application starter carries unchanged: the Playwright journey (`shared/e2e`), the
CI steps (`shared/thoryn/ci`), `app-env.mjs` and the template manifest. Edit it there and run `npm run
sync`; CI fails when a starter's copy drifts.

## Security

- No secrets anywhere: CI signs in with workload identity, the app is a public client using PKCE, the test
  user's password is generated per run and masked, and the session secret is per process.
- Tokens never reach the browser and are never logged.
- The API pins ES256, requires `typ` `at+jwt`, and checks `iss`, `aud`, expiry and `client_id`.
- GitHub Actions are pinned by commit SHA.
