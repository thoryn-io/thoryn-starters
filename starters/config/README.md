# Thoryn workspace configuration

The **config project** of a Thoryn workspace. It holds configuration only, no application code, and it
owns everything workspace-wide:

- the environments (production and every sandbox);
- per environment: sign-in methods, login flows, branding, the email provider, identity providers and
  (once the CLI supports it) the custom domain.

The result is a working sign-in stack for every application of the workspace. Each application lives in
its own **application project**, which declares only its own OAuth client(s) and test users and resolves
its issuer at run time. So when this project changes the sign-in configuration, or activates a custom
domain, no application repository has to change.

No file in this repository names the workspace. CI reads that, and every other piece of wiring, from GitHub
Actions variables at run time (see [Configuration](#configuration)).

## Layout

One section per connection. A connection is a workload identity trust, declared in `.thoryn/template.json`.

| Section | Connection (who CI is) | Provisioning (what it owns) |
|---|---|---|
| `.thoryn/environments/production/` | `production`: the production workload identity trust. It only accepts jobs running in the production GitHub environment (`github.productionEnvironment` in `.thoryn/template.json`, `thoryn-production` by default), and never a pull request. | The environments of the workspace, and production's own configuration. |
| `.thoryn/environments/sandbox/` | `sandbox`: the trust of the sandbox named by the `THORYN_SANDBOX_ENVIRONMENT` variable. Pull requests are allowed. | That sandbox's configuration. |

No file holds a secret. CI exchanges each job's short-lived GitHub OIDC token for a Thoryn token.

## Configuration

| Variable | Where | Meaning |
|---|---|---|
| `THORYN_ISSUER` | repository | The platform base issuer the `thoryn` CLI signs in to, e.g. `https://auth.stg.thoryn.org`. |
| `THORYN_WORKSPACE` | repository | The workspace slug. |
| `THORYN_SANDBOX_ENVIRONMENT` | repository | The sandbox's slug. The production section declares it; the sandbox section configures it. |
| `THORYN_SANDBOX_WIF_CLIENT_ID` | repository | The clientId (`wi_…`) of the sandbox's workload identity trust. |
| `THORYN_PRODUCTION_WIF_CLIENT_ID` | the production GitHub environment | The clientId (`wi_…`) of the production trust. Only a job running in that environment can read it. |

Repository variables live under Settings → Secrets and variables → Actions → Variables. The environment
variable lives under Settings → Environments → the production environment. None of them is a secret.
Thoryn's starter flow sets them all when it creates the repository.

If one is missing, the run fails and names it. Two cases skip with a notice instead:

- the starter template repository itself;
- a pull request from a fork, which gets no OIDC token.

The first run of a freshly created repository can start before the variables exist. It also skips; re-run
it, or push.

In the provisioning files, `{{env.NAME}}` is filled in by the `thoryn` CLI from the environment when it
reads the file, for example `environment: "{{env.THORYN_SANDBOX_ENVIRONMENT}}"`. The workflow maps the
Actions variables into the environment.

## CI

`.github/workflows/thoryn.yml`:

- **Pull request:** `thoryn provision plan` for the sandbox section, so reviewers see what would change.
- **Push to `main`:**
  1. production runs `plan` then `apply`, in the production GitHub environment;
  2. then the sandbox runs `plan` then `apply`.

**Every production run needs a reviewer's approval.** The production CI client holds `manager` on the
whole workspace (creating environments needs it), so it is contained three ways:

- it only runs from `main`;
- only in the production GitHub environment, which the production trust pins;
- and that environment has required reviewers, so a person approves every production run.

A project created by Thoryn's starter flow already has the environment set up with required reviewers
and restricted to `main`. If you created this repository yourself, create the environment under Settings →
Environments before the first push to `main`: add required reviewers, restrict it to `main`, and set
`THORYN_PRODUCTION_WIF_CLIENT_ID` in it. The production trust refuses pull requests, so production is never
planned from a pull request. The production plan is printed on `main`, right before the approval and the
apply.

## Making changes

1. Edit the section's `provision.yaml`. The commented examples show the branding, email-provider,
   identity-provider and custom-domain resources.
2. If a new resource kind needs a scope the connection does not have yet, add it to that connection's
   `scopes` in `.thoryn/template.json` **and** to the trust. For example, `emailProvider` needs
   `tenant:email.read` and `tenant:email.write`. CI requests exactly the connection's scopes. A trust can
   only be given scopes the admin creating it holds:
   ```bash
   thoryn workload-identity trusts list --environment <env>   # find the trust
   # recreate it with the extra --scope, then update the connection's *_WIF_CLIENT_ID variable
   ```
3. Open a pull request, read the plan, merge.

Secrets are never written in the files. A resource that needs one names an environment variable instead
(`smtpPasswordEnv: SMTP_PASSWORD`). Pass the value from a GitHub secret in the workflow's `env:`.

Removing a resource from a file does not delete it: every run adopts what already exists and converges
it. Delete it with the `thoryn` CLI.

### Run it locally

Export the same values CI reads, sign in as yourself, and plan a section:

```bash
export THORYN_ISSUER=https://auth.stg.thoryn.org THORYN_WORKSPACE=<workspace> THORYN_SANDBOX_ENVIRONMENT=<sandbox>
thoryn login --workspace "$THORYN_WORKSPACE"
thoryn provision plan --file .thoryn/environments/sandbox/provision.yaml
```

### Another sandbox

1. Declare it in `.thoryn/environments/production/provision.yaml` (a `kind: environment` resource) and
   merge. Production creates it.
2. Create a workload identity trust in it for this repository. The scopes are the `sandbox` connection's
   scopes:
   ```bash
   thoryn workload-identity trusts create --environment <slug> --name <repository> \
     --repository <owner>/<repository> \
     --scope tenant:environments.read --scope tenant:idp.read --scope tenant:idp.write
   thoryn access grant client:<its wi_… clientId> manager environment:<the sandbox id>
   ```
3. Add a connection for it to `.thoryn/template.json`, with its own two variables (for example
   `THORYN_STAGING_ENVIRONMENT` and `THORYN_STAGING_WIF_CLIENT_ID`), and set both as repository
   variables.
4. Copy `.thoryn/environments/sandbox/` to `.thoryn/environments/<connection>/`. In the copy, use the new
   environment variable (`{{env.THORYN_STAGING_ENVIRONMENT}}`).
5. Copy the `sandbox` job in `.github/workflows/thoryn.yml`: map the two new variables in its `env:` and
   run `.thoryn/ci/login.sh <connection>` and the new section's file.

## Custom domain

Serving sign-in on your own domain (for example `auth.example.com`) is a production setting. The CLI's
`customDomain` provisioning kind is on its way (SSO-3413). Until it ships, run `thoryn domain` once by
hand; the commented `customDomain` resource shows where it will go. Application projects resolve their
issuer at run time, so they pick up the new domain without a change.

Once a custom domain is active, the workspace's issuer, and with it every trust's audience, moves to that
domain. CI derives the audience from `THORYN_ISSUER` and the workspace. Until the CLI resolves it at run
time (SSO-3413), set `THORYN_AUDIENCE` in the job's `env:` to the audience `thoryn workload-identity trusts
get <id>` prints.
