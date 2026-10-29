# Security policy

## Supported versions

Muster is pre-1.0. Only the latest commit on `main` is supported; there are no
maintained release branches or backports. If you run an older checkout, reproduce
the issue on current `main` first.

## Reporting a vulnerability

Do not open a public issue for a vulnerability.

Use GitHub private vulnerability reporting on
[Wale-Shi/Muster](https://github.com/Wale-Shi/Muster): open the **Security** tab and
choose **Report a vulnerability**, which files a private Security Advisory visible
only to the maintainer. If that form is unavailable, contact the maintainer through
their GitHub profile instead of posting details publicly.

Include the affected version or commit, reproduction steps, impact, and any
relevant configuration. Remove tokens, secrets and private repository contents from
screenshots and logs. Please allow time for a fix before disclosing publicly; the
advisory is the place to coordinate disclosure.

## Scope

In scope: the server (`apps/server`), daemon (`apps/daemon`), web UI
(`apps/web`), desktop app (`apps/desktop`), shared package, and the documented HTTP,
MCP and machine APIs. Examples include authentication or authorization bypass,
cross-origin request or DNS-rebinding exposure, secret or API-key disclosure,
path traversal in project browsing, skill import or attachments, and command or
argument injection into a runtime.

Out of scope: vulnerabilities in third-party agent CLIs or model providers,
misconfiguration of your own host, and the inherent risk of running an agent with
elevated permissions in a repository you do not trust. Report those upstream.

## Trust model

Muster is designed for a single user on a trusted local machine.

- The REST API has no login. Anyone who can reach the port can use the workspace.
- The server accepts only loopback `Host` headers, the `MUSTER_PUBLIC_URL` host, and
  hosts listed in `MUSTER_ALLOWED_HOSTS`, and rejects cross-origin writes. This
  protects against malicious websites and DNS rebinding; it is not authentication.
- Machine requests carry a per-machine bearer token issued at enrollment; the
  optional enrollment key gates enrollment only. External MCP access requires a
  personal API key.
- Agents run with elevated permissions inside their Git worktrees; writable turns
  use full-access or bypass modes. They can use whatever credentials are available
  to the daemon's OS user.

Do not expose Muster directly to the internet. Keep it on loopback or put it behind
your own authenticated access layer. See the README's
[Security model](README.md#security-model) and
[architecture notes](docs/ARCHITECTURE.md#request-security) for details.
