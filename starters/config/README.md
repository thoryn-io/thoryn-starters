# Thoryn workspace configuration

The **config project** of a Thoryn workspace: its **tenant provisioning**. It holds configuration only, no
application code, and it is the one place that defines what the tenant is:

- the environments (production and every sandbox);
- per environment: sign-in methods, login flows, branding, the email provider, identity providers, users
  (sandbox test users included), roles and the custom domain;
- the workload identity trusts of the workspace's application projects.

Every file here declares `apiVersion: thoryn.io/tenant/v1`. Applications are **users** of the tenant: each
application project declares its own OAuth client in its own `thoryn.io/application/v1` file, and the CLI
refuses an `application` in a tenant file. So when this project changes the sign-in configuration, or
activates a custom domain, no application repository has to change.

## Layout

One section per connection. A connection is a workload identity trust, declared in `.thoryn/template.json`.

| Path | What it is |
|---|---|
| `.thoryn/environments/production/provision.yaml` | The production section: the workspace's environments, and production's own configuration. |
| `.thoryn/environments/production/connection.json` | Who CI is for production: the production trust. It signs in only from a job in the reviewed GitHub environment `thoryn-production` on `main`, with write scopes; a job in `thoryn-production-plan` gets its read-only plan profile. |
| `.thoryn/environments/sandbox/provision.yaml` | The sandbox section: that sandbox's own configuration. |
| `.thoryn/environments/sandbox/connection.json` | Who CI is for the sandbox: the sandbox trust, manager of that sandbox only. |
| `.github/workflows/thoryn-provisioning.yml` | The provisioning **stub** the Thoryn GitHub App dispatches. It calls thoryn-cli's reusable workflow at a `cli-v*` release. |
| `.thoryn/workflow.yaml` | The stub's run-time configuration: the files, in order, each with its connection; removals off. |
| `.github/CODEOWNERS` | The reviewers own production's section, the workflows and CODEOWNERS itself. |

**The template ships only the two `provision.yaml` files**, plus this README and `.thoryn/template.json`.
The creation flow writes the rest, because it names this repository's own trusts and reviewers:

- `thoryn project init config` (thoryn-cli) seeds both `connection.json` files, the stub pinned to the CLI's
  own release, `.thoryn/workflow.yaml` and CODEOWNERS. It replaces both `provision.yaml` files with ones that
  name your sandbox literally.
- The Thoryn GitHub App seeds the same files when it creates the project, and keeps these `provision.yaml`
  files. It supplies `THORYN_SANDBOX_ENVIRONMENT` through the `env:` block of `.thoryn/workflow.yaml`.

No file holds a secret. CI exchanges each job's short-lived GitHub OIDC token for a Thoryn token.

## CI

The stub runs only when the **Thoryn GitHub App** dispatches it, so the App must be installed on this
repository:

- **Pull request** that changes `.thoryn/`: `thoryn provision plan` for every file in `.thoryn/workflow.yaml`,
  in the unprotected GitHub environment `thoryn-production-plan`. The production trust's plan profile is
  read-only, so a plan can never write.
- **Push to `main`**: `thoryn provision apply`, in the GitHub environment `thoryn-production`. It deploys from
  `main` only, and its required reviewers approve every run before any write-capable token exists.

The App reports each run as a check run. A red run names the missing right and how to grant it.

Lint the stub and its configuration on a laptop:

```bash
thoryn provision workflow check
```

### Run it locally

Sign in as yourself and plan a section:

```bash
thoryn login --workspace <workspace>
thoryn provision plan --file .thoryn/environments/sandbox/provision.yaml
```

## Making changes

1. Edit the section's `provision.yaml`. The commented examples show the branding, email-provider,
   identity-provider, test-user and custom-domain resources.
2. If a new resource needs a scope the connection does not have yet, add it to the trust and to the
   section's `connection.json`. For example, `emailProvider` needs `tenant:email.read` and
   `tenant:email.write`. `thoryn provision workflow check` names a missing scope before any run does. A trust
   can only be given scopes the admin changing it holds:
   ```bash
   thoryn workload-identity trusts list --environment <env>          # find the trust
   thoryn workload-identity trusts set-scopes <id> --environment <env> --scope …
   ```
3. Open a pull request, read the plan, merge, and approve the production run.

Secrets are never written in the files. A resource that needs one names an environment variable instead
(`smtpPasswordEnv: SMTP_PASSWORD`).

Removing a resource from a file does not delete it: removals are never automated (`apply.prune` and
`apply.destroy` stay `false`). Delete it with the `thoryn` CLI.

### Another sandbox

1. Declare it in `.thoryn/environments/production/provision.yaml` (a `kind: environment` resource) and
   merge. Production creates it.
2. Create a workload identity trust in it for this repository, with the `sandbox` connection's scopes, and
   make its client manager of the sandbox:
   ```bash
   thoryn workload-identity trusts create --environment <slug> --name <repository> \
     --repository <owner>/<repository> \
     --scope tenant:environments.read --scope tenant:idp.read --scope tenant:idp.write \
     --scope tenant:access.read
   thoryn access grant client:<its wi_… clientId> manager environment:<the sandbox id>
   ```
   `trusts create` prints the section's `connection.json`.
3. Add `.thoryn/environments/<slug>/provision.yaml` and that `connection.json`, and list the pair under
   `files:` in `.thoryn/workflow.yaml`.

## Custom domain

Serving sign-in on your own domain (for example `auth.example.com`) is a production setting: the
commented `customDomain` resource in the production section. Application projects resolve their issuer at
run time, so they pick up the new domain without a change.
