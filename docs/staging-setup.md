# Staging setup for this repository's end-to-end CI

The staging e2e job (`.github/workflows/stack-e2e.yml`) runs each application starter in place, exactly as
a generated repository would: workload identity sign-in, `thoryn provision apply`, the Playwright sign-in
journey, teardown. Nothing is rendered. The job maps this repository's fixture variables into the same
`THORYN_*` environment a generated repository's workflow maps from its own Actions variables:

| Starter reads | Supplied from |
|---|---|
| `THORYN_ISSUER` | `vars.THORYN_ISSUER` |
| `THORYN_WORKSPACE` | `vars.THORYN_STARTERS_WORKSPACE` |
| `THORYN_ENVIRONMENT` | `ci-<stack>` |
| `THORYN_WIF_CLIENT_ID` | `vars.THORYN_STARTERS_WIF_<STACK>` |

The config starter's sandbox plan (`config-plan` in `ci.yml`) works the same way:

- `THORYN_SANDBOX_ENVIRONMENT` is `ci-config`;
- `THORYN_SANDBOX_WIF_CLIENT_ID` is `vars.THORYN_STARTERS_WIF_CONFIG`.

Both skip with a notice until the variables below exist.

## The fixture

- One workspace for this repository's CI (below: `starters`).
- One sandbox per application starter, `ci-<starter>`: `ci-express`, `ci-spring-boot`, `ci-aspnet-core`.
  Separate sandboxes let the stacks run in parallel without converging the same resources.
- A sandbox `ci-config` for the config starter, whose sandbox section CI only plans.
- In each sandbox, a workload identity trust pinned to `thoryn-io/thoryn-starters`, with exactly the scopes
  of the starter's `sandbox` connection in `.thoryn/template.json`, and `manager` on that sandbox for the
  trust's client.

## One-time setup (product owner)

Needs:

- oauthy #3787 (workload identity trusts, hub V191/V192) on staging;
- a `thoryn` CLI release that carries SSO-3308 (thoryn-cli #94, workload identity sign-in);
- a `thoryn` CLI release that carries SSO-3430 (`{{env.NAME}}` in a resource's `environment`).

```bash
export THORYN_ISSUER=https://auth.stg.thoryn.org

# The workspace (skip if you reuse one) and a session on it with the workload identity scopes.
thoryn login --workspace thoryn
thoryn workspace create --slug starters --display-name "thoryn-starters CI"
thoryn login --workspace starters

for stack in express spring-boot aspnet-core; do
  thoryn env create "ci-$stack" --name "thoryn-starters $stack CI"
  thoryn workload-identity trusts create --environment "ci-$stack" --name "thoryn-starters-$stack" \
    --repository thoryn-io/thoryn-starters --github-hosted-runners-only \
    --scope tenant:applications.read --scope tenant:applications.write \
    --scope tenant:users.read --scope tenant:users.write \
    --scope tenant:environments.read
  # Note the clientId (wi_…) it prints, and the sandbox's id from `thoryn env list --output json`.
done

# Per stack: let the trust's client manage its sandbox (scopes are the ceiling, the grant is the gate),
# and hand the clientId to CI.
thoryn access grant client:<wi_express>     manager environment:<ci-express id>
thoryn access grant client:<wi_spring_boot> manager environment:<ci-spring-boot id>
thoryn access grant client:<wi_aspnet_core> manager environment:<ci-aspnet-core id>

gh variable set THORYN_ISSUER             -R thoryn-io/thoryn-starters --body https://auth.stg.thoryn.org
gh variable set THORYN_STARTERS_WORKSPACE -R thoryn-io/thoryn-starters --body starters
gh variable set THORYN_STARTERS_WIF_EXPRESS     -R thoryn-io/thoryn-starters --body '<wi_express>'
gh variable set THORYN_STARTERS_WIF_SPRING_BOOT -R thoryn-io/thoryn-starters --body '<wi_spring_boot>'
gh variable set THORYN_STARTERS_WIF_ASPNET_CORE -R thoryn-io/thoryn-starters --body '<wi_aspnet_core>'

# The config starter: CI only PLANS its sandbox section (read-only); it never touches a production plane.
thoryn env create ci-config --name "Sandbox ci-config"
thoryn workload-identity trusts create --environment ci-config --name thoryn-starters-config \
  --repository thoryn-io/thoryn-starters --github-hosted-runners-only \
  --scope tenant:environments.read --scope tenant:idp.read --scope tenant:idp.write
thoryn access grant client:<wi_config> manager environment:<ci-config id>
gh variable set THORYN_STARTERS_WIF_CONFIG -R thoryn-io/thoryn-starters --body '<wi_config>'
# Optional: pin the CLI release the jobs install (default: the latest cli-v* release).
gh variable set THORYN_CLI_VERSION -R thoryn-io/thoryn-starters --body 'cli-v<a release with SSO-3308 and SSO-3430>'
```

Nothing here is a secret: client ids, the issuer and the workspace slug are public. The jobs hold no
credential; each exchanges its own GitHub OIDC token.

Sandbox trusts accept any ref and same-repository pull requests (ADR 2026-09-22, D8), so the e2e runs on
pull requests too. Pull requests from forks get no OIDC token and skip.

## What a run leaves behind

Nothing, when it finishes: `teardown.sh` runs `thoryn provision destroy`, which deletes the per-run test
user and, if the run created it, the application client. A run killed before teardown leaves one test user
(`e2e-<run id>-…@example.com`) in its sandbox; the next run is unaffected.
