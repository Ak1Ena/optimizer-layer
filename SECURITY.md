# Security policy

Report vulnerabilities privately through GitHub private vulnerability reporting (the repository's **Security** tab, then **Report a vulnerability**). Do not open public issues for security problems.

Trust model, so you know what is in scope:

- Configured check commands run with the invoking user's privileges. Only configure commands you trust. See the [README](README.md#demonstration-and-limits).
- Hooks and checkpoints are cooperative and best-effort. They do not sandbox or forcibly interrupt a coding agent. See the [README](README.md#design-and-evidence) and [CONTEXT.md](CONTEXT.md).
