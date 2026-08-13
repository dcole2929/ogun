# Ogun's own skills

Skills for reviewing **this** repository — the same relationship any project has to its
own skills. Nothing here ships to other repos.

The library Ogun exports lives in [`../../skills/`](../../skills). If one of those is
also useful against Ogun, a worker in `.ogun/config.yaml` can just name it; it does not
need a copy here.

## Why the links

No directory is read by both runtimes: Claude Code reads only `.claude/skills/`, codex
reads `.codex/skills/` and this one. So the files live here and each runtime's directory
holds a relative symlink to them — otherwise a skill authored here would be invisible to
Claude Code when you open the repo yourself.

Ogun's runner copies the skill into the right place for automated runs regardless, so the
links exist for interactive use. `ogun skill link` creates any that are missing.
