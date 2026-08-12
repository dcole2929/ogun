# Built-in skills

Skills Ogun ships to **other** repositories. A worker in any project can name one of
these without the project having a copy — the runner materializes it into the workspace
at run time.

A project defining a skill with the same name overrides the built-in. That is the
specialisation path: start here, and when a repo needs its own take, run
`ogun skill new <name>` inside it.

These are universal disciplines only. Anything that depends on a particular codebase
belongs in that codebase.

---

Not to be confused with `.agents/skills/`, which is Ogun reviewing *itself* — the same
relationship any other project has to its own skills. If a skill here is also useful
against Ogun, a worker in `.ogun/config.yaml` can just name it.
