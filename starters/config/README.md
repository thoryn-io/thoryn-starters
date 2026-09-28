# {{thoryn.githubRepository}}

The **config project** of the Thoryn workspace `{{thoryn.workspace}}`. It holds configuration only, no
application code, and it owns everything workspace-wide:

- the environments (production and every sandbox);
- per environment: sign-in methods, login flows, branding, the email provider, identity providers and
  (once the CLI supports it) the custom domain.

The result is a working sign-in stack for every application of the workspace. Each application lives in
its own **application project**, which declares only its own OAuth client(s) and test users and resolves
its issuer at run time. So when this project changes the sign-in configuration, or activates a custom
domain, no application repository has to change.

## Layout

One section per environment:

| Section | Connection (who CI is) | Provisioning (what it owns) |
|---|---|---|
| `.thoryn/environments/production/` | The production workload identity trust. It only accepts jobs running in the GitHub environment `{{thoryn.githubEnvironment}}`, and never a pull request. | The environments of the workspace, and production's own configuration. |
| `.thoryn/environments/sandbox/` | The trust of sandbox `{{thoryn.sandboxEnvironment}}`. Pull requests are allowed. | That sandbox's configuration. |

No file holds a secret. CI exchanges each job's short-lived GitHub OIDC token for a Thoryn token.

## CI

`.github/workflows/thoryn.yml`:

- **Pull request:** `thoryn provision plan` for every sandbox section, so reviewers see what would change.
- **Push to `main`:**
  1. production runs `plan` then `apply`, in the GitHub environment `{{thoryn.githubEnvironment}}`;
  2. then every sandbox runs `plan` then `apply`.

**Every production run needs a reviewer's approval.** The production CI client holds `manager` on the
whole workspace (creating environments needs it), so it is contained three ways:

- it only runs from `main`;
- only in the GitHub environment `{{thoryn.githubEnvironment}}`, which the production trust pins;
- and that environment has required reviewers, so a person approves every production run.

A project created by Thoryn's starter flow already has the environment set up with required reviewers
and restricted to `main`. If you created this repository yourself, add them under Settings → Environments
before the first push to `main`. The production trust refuses pull requests, so production is never
planned from a pull request: the production plan is printed on `main`, right before the approval and the apply.

The workflow needs one repository variable, `THORYN_ISSUER`, the platform base issuer (for example
`https://auth.stg.thoryn.org`). It skips with a notice while that is not set.

## Making changes

1. Edit the section's `provision.yaml`. The commented examples show the branding, email-provider,
   identity-provider and custom-domain resources.
2. If a new resource kind needs a scope the section's `connection.json` does not list yet, add it there
   **and** to the trust. For example, `emailProvider` needs `tenant:email.read` and `tenant:email.write`. A
   trust can only be given scopes the admin creating it holds:
   ```bash
   thoryn workload-identity trusts list --environment <env>   # find the trust
   # recreate it with the extra --scope, then update auth.clientId in the connection.json
   ```
3. Open a pull request, read the plan, merge.

Secrets are never written in the files. A resource that needs one names an environment variable instead
(`smtpPasswordEnv: SMTP_PASSWORD`). Pass the value from a GitHub secret in the workflow's `env:`.

Removing a resource from a file does not delete it: every run adopts what already exists and converges
it. Delete it with the `thoryn` CLI.

### Another sandbox

1. Declare it in `.thoryn/environments/production/provision.yaml` (a `kind: environment` resource) and
   merge. Production creates it.
2. Create a workload identity trust in it for this repository:
   ```bash
   thoryn workload-identity trusts create --environment <slug> --name {{thoryn.githubRepository}} \
     --repository {{thoryn.githubOwner}}/{{thoryn.githubRepository}} \
     --scope tenant:environments.read --scope tenant:idp.read --scope tenant:idp.write
   thoryn access grant client:<its wi_… clientId> manager environment:<the sandbox id>
   ```
3. Copy `.thoryn/environments/sandbox/` to `.thoryn/environments/<slug>/`. In the copy, set the new slug
   and the trust's `clientId`.

## Custom domain

Serving sign-in on your own domain (for example `auth.example.com`) is a production setting. The CLI's
`customDomain` provisioning kind is on its way (SSO-3413). Until it ships, run `thoryn domain` once by
hand; the commented `customDomain` resource shows where it will go. Application projects resolve their
issuer at run time, so they pick up the new domain without a change.

Once a custom domain is active, the workspace's issuer, and with it every trust's audience, moves to that
domain. Until the CLI resolves that at run time (SSO-3413), add the trust's `audience` (from `thoryn
workload-identity trusts get <id>`) to each section's `connection.json`.
