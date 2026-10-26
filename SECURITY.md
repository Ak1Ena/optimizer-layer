# Security policy

Report vulnerabilities privately through GitHub private vulnerability reporting (the repository's **Security** tab, then **Report a vulnerability**). Do not open public issues for security problems.

Trust model, so you know what is in scope:

- Configured check commands run with the invoking user's privileges. Only configure commands you trust. See the [README](README.md#demonstration-and-limits).
- Hooks and checkpoints are cooperative and best-effort. They do not sandbox or forcibly interrupt a coding agent. See the [README](README.md#design-and-evidence) and [CONTEXT.md](CONTEXT.md).
- The default hook install is opt-in: hooks act only in folders the user turned on with `optimizer enable`, and elsewhere create nothing and start nothing. `optimizer-claude-hook install --always-on` makes the hooks act in every folder, including freshly cloned repositories.
- Trust anchor: hook tokens, approved check commands, pending proposals, project enablement, opt-outs and the active session live only in the per-user store (`$XDG_CONFIG_HOME/optimizer-layer/`, default `~/.config/optimizer-layer/`, files 0600). Nothing inside a project is trusted for these: a cloned repository's `.optimizer/project.json` is ignored and its `prompts.jsonl` rows fail the per-user HMAC check. Check commands become active only through `optimizer enable` or a user-typed `approve check CODE` prompt. A process running as the same user can read or change the per-user store; the hook guards against the coding agent doing so are best-effort string matches.
- Explicit `--checks` sessions in a folder without a per-user record (plain CLI use without hooks) run the argv stored in that folder's `.optimizer/runtime.sqlite`. A runtime database committed to a repository can therefore name commands. Use explicit `--checks` sessions only in project directories you trust. With a per-user record, `check` runs only currently approved argv and refuses everything while the project is opted out.
