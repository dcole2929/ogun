import { bold, cyan, dim } from './output.ts'

/**
 * Per-command help.
 *
 * The flat top-level listing tells you a command exists and nothing else — and the two
 * things people actually get wrong about this CLI are invisible in a one-line summary:
 * which machine a command runs on (`runner invite` on the control plane, `runner join`
 * on the machine being added), and what it writes when it succeeds. Both are recorded
 * here, next to the flags.
 *
 * Help is data rather than a string per command so that the shape is uniform: a command
 * whose "touches" list is empty is a command that only reads, and that is worth being
 * able to see at a glance.
 */
type Topic = {
  /** One line, in the same voice as the top-level listing. */
  summary: string
  usage: string[]
  /** Only where it is a genuine source of confusion. Most commands run anywhere. */
  where?: string
  notes?: string[]
  subcommands?: Array<[string, string]>
  flags?: Array<[string, string]>
  /** Environment, for the two commands configured that way rather than by flag. */
  env?: Array<[string, string]>
  /** What changes when it succeeds. Reading-only commands list nothing. */
  touches?: Array<[string, string]>
  see?: string[]
}

const LABELS =
  'extra capability labels, comma separated. For things Ogun cannot detect by looking ' +
  'for a binary — gpu, staging-db. A worker asks for one with `requires:` and the job ' +
  'then only goes to a machine advertising it. claude, codex and docker are detected.'

const NAME =
  'the name this machine registers under. Defaults to its hostname, lowercased with ' +
  'the domain stripped. Names are unique: two machines answering to one would share a ' +
  'claim identity and make every run unattributable.'

const LOCAL_CONFIG = '~/.ogun/config.json'

const topics: Record<string, Topic> = {
  init: {
    summary: 'set this machine up: database, schema, sandbox image',
    usage: ['ogun init [--no-image]'],
    where:
      'On the machine that will run the control plane: postgres runs here, in a ' +
      'container. A machine that only executes jobs needs `ogun runner join` instead.',
    notes: [
      'Idempotent, and it says what it skipped. Re-running it is how you pick up a new ' +
        'migration.',
      'The sandbox image is built now rather than on first use, because a nightly run ' +
        'that has to build an image first is a nightly run that fails on a bad network.',
      'Registering this machine as a runner is the last step and the only one that ' +
        'needs the control plane, since name uniqueness is enforced there. It does that ' +
        'if the control plane is already up, and otherwise tells you to run `ogun ' +
        'runner init` after `ogun server`. Everything before it needs nothing running, ' +
        'which is why `init` comes first.',
    ],
    flags: [
      [
        '--no-image',
        'skip building ogun/base. Quicker, but the first container job has nothing to run inside',
      ],
    ],
    touches: [
      ['docker', 'starts the postgres container from docker-compose.yml'],
      ['the database', 'applies any pending migrations'],
      ['ogun/base:latest', 'builds the sandbox image, unless --no-image'],
      [LOCAL_CONFIG, 'the runner block, if the control plane was up to register with'],
    ],
    see: ['ogun server', 'ogun runner init', 'ogun db status'],
  },

  db: {
    summary: 'the database, without needing to know it is postgres in a compose file',
    usage: ['ogun db up | down [--volumes] | migrate | status'],
    where: 'On the control-plane machine. Nothing else talks to postgres directly.',
    subcommands: [
      ['up', 'start postgres and wait until it accepts connections'],
      ['down [--volumes]', 'stop it; --volumes deletes the data with it'],
      ['migrate', 'apply pending migrations'],
      ['status', 'is it up, and does it have a schema (the default)'],
    ],
    env: [['DATABASE_URL', 'default postgres://ogun:ogun@localhost:5433/ogun']],
  },

  'db up': {
    summary: 'start postgres and wait until it accepts connections',
    usage: ['ogun db up'],
    notes: [
      'Waits rather than returning on `docker compose up`, which reports the container ' +
        'as started well before postgres will accept a connection. Gives up after 30s.',
    ],
    touches: [['docker', 'brings up the compose stack in the Ogun checkout']],
  },

  'db down': {
    summary: 'stop postgres',
    usage: ['ogun db down [--volumes]'],
    flags: [
      [
        '--volumes',
        'delete the database volume too — every run, finding and coverage record goes ' +
          'with it. Never implied, because that is the whole history of what the factory has done',
      ],
    ],
    touches: [['docker', 'takes the compose stack down']],
  },

  'db migrate': {
    summary: 'apply pending migrations',
    usage: ['ogun db migrate'],
    notes: ['Needs the database up. `ogun init` runs this for you.'],
    touches: [['the database', 'applies anything in packages/core/drizzle not yet recorded']],
  },

  'db status': {
    summary: 'is the database up, and does it have a schema',
    usage: ['ogun db status'],
  },

  image: {
    summary: 'build the container image a job runs inside',
    usage: ['ogun image build [project-dir]'],
    where:
      'On every machine that runs container jobs. The image is built locally, never ' +
      'pulled, so it has to exist where the container starts.',
    notes: [
      'With no argument: ogun/base:latest from images/base. The CLI is bundled into it ' +
        'first, so the in-sandbox `ogun findings write` cannot drift from the validator ' +
        'that will read its output.',
      'With a directory: ogun/project-<dir>:latest from <dir>/.ogun/Dockerfile. A ' +
        "project image is FROM ogun/base plus that project's toolchain, and a modifier " +
        'worker needs one — the base image is enough to read a repo and not enough to build it.',
    ],
    touches: [['docker', 'writes the image into the local daemon']],
  },

  server: {
    summary: 'start the control plane: API, web UI, and the foreman',
    usage: ['ogun server [--port <n>]'],
    where:
      'One machine, and it stays running. Runners connect outward to it; it never ' +
      'dials a runner, which is what lets a laptop behind NAT be one.',
    notes: [
      '--port is the one flag, because a second control plane on one machine is a real ' +
        'thing to want. Everything else is environment: those are properties of the ' +
        'machine rather than of one invocation, and a systemd unit should not have to ' +
        'carry an argument list.',
      'Binds to localhost, where nothing off this machine can reach it and no token is ' +
        'needed. Set OGUN_BIND=0.0.0.0 and it generates an admin token on first start ' +
        'and stores it: this API can define workers, so an open one on a shared network ' +
        'is remote code execution on this machine, and it refuses to start that way.',
    ],
    env: [
      ['OGUN_PORT', 'listen port (7777) — --port wins over it'],
      ['OGUN_BIND', 'interface (127.0.0.1)'],
      ['OGUN_ADMIN_TOKEN', 'use this instead of the stored one'],
      ['OGUN_STALE_CLAIM_MS', 'how long a claim may go unreported before it is swept (45m)'],
      ['DATABASE_URL', 'default postgres://ogun:ogun@localhost:5433/ogun'],
    ],
    touches: [
      [LOCAL_CONFIG, 'stores the admin token, the first time it binds beyond localhost'],
      ['the database', 'schedules cycles, sweeps stale claims, reconciles coverage'],
    ],
    see: ['ogun token show', 'ogun runner invite'],
  },

  runner: {
    summary: 'this machine as a runner, and enrolling others',
    usage: ['ogun runner init | start | doctor | invite | join <url> --token <t>'],
    subcommands: [
      ['init', 'register this machine with a control plane on this same machine'],
      ['start', 'claim jobs and execute them — the process that does the work'],
      ['doctor', 'what this machine can actually run'],
      ['invite', 'on the CONTROL PLANE — mint a join token for another machine'],
      ['join', 'on the NEW MACHINE — paste what invite printed'],
    ],
    notes: [
      'init and join do the same thing. init is the one-box case; join is the version ' +
        'that has to present a token because it is talking across a network.',
    ],
  },

  'runner init': {
    summary: 'make this machine a runner for a control plane on this same machine',
    usage: ['ogun runner init [--name <name>] [--url <url>] [--labels a,b] [--force]'],
    where:
      'On the machine being made a runner, with the control plane already running — ' +
      'registering means claiming a name on it. For a control plane on another machine ' +
      'use `ogun runner join`, which carries an invite token.',
    flags: [
      ['--name <name>', NAME],
      ['--url <url>', 'the control plane to register with (OGUN_SERVER_URL, else localhost:7777)'],
      ['--labels a,b', LABELS],
      [
        '--force',
        'take a *different* identity — another name, or another control plane. Refused ' +
          'without it, since that abandons the runner identity the control plane still ' +
          'has rows for',
      ],
    ],
    notes: [
      'Re-running it with the same name and url is a refresh, not an error: it ' +
        're-detects capabilities and updates the labels this machine advertises. That ' +
        'is what `ogun runner doctor` tells you to do after installing docker or ' +
        'logging into a runtime.',
    ],
    touches: [
      [LOCAL_CONFIG, 'the runner block: name, labels, control-plane URL'],
      ['~/.ogun/work/', 'created — scratch space for workspaces'],
      ['the database', 'a runner row on the control plane'],
    ],
    see: ['ogun runner start', 'ogun runner doctor'],
  },

  'runner start': {
    summary: 'claim jobs and execute them',
    usage: ['ogun runner start'],
    where:
      'On each runner machine, for as long as you want work done. Nothing runs without ' +
      'it — triggering a worker only queues a job.',
    notes: [
      'No flags: everything it needs is in ~/.ogun/config.json, written by `runner ' +
        'init` or `runner join`.',
      'On Ctrl-C or SIGTERM it stops claiming and lets in-flight jobs finish. The ' +
        'stale-claim sweep exists for crashes, not for a clean stop.',
      'A job is only offered to a runner advertising every label it requires, so a ' +
        'machine without docker leaves container jobs queued rather than failing them.',
    ],
    env: [
      ['OGUN_SERVER_URL', 'override the control plane recorded at join time'],
      ['OGUN_RUNNER_TOKEN', 'override the stored runner token'],
      ['OGUN_CLAUDE_BIN', 'path to the claude binary, if it is not on PATH'],
      ['OGUN_SANDBOX_MEMORY', 'memory limit for a job container (4g)'],
      ['OGUN_SANDBOX_CPUS', 'cpu limit for a job container (2)'],
      ['OGUN_KEEP_WORKSPACES', '1 keeps the workspace clone after a run, for debugging'],
      ['OGUN_CLONE_DEPTH', 'shallow clone depth for a workspace (50)'],
    ],
    see: ['ogun runner doctor', 'ogun runs'],
  },

  'runner doctor': {
    summary: 'what this machine can actually run',
    usage: ['ogun runner doctor'],
    where:
      'On the machine in question. The toolchain and the map of local checkouts are ' +
      'per-machine, so this is the only honest place to ask whether a job could run.',
    notes: [
      'Exits non-zero when something blocking is wrong — no git, no reachable control ' +
        'plane, not joined — so it works as a check in a script.',
      'Labels are detected at join time, so a runtime installed since then shows up ' +
        'here as something this machine could advertise but does not.',
    ],
    env: [['OGUN_CLAUDE_BIN', 'path to the claude binary, if it is not on PATH']],
  },

  'runner invite': {
    summary: 'mint a single-use join token for another machine',
    usage: ['ogun runner invite [--note <text>] [--url <url>]'],
    where:
      'On the CONTROL PLANE. It prints the `ogun runner join` command to run on the ' +
      'machine being added.',
    notes: [
      'Takes no machine name. The machine has not joined yet and it is the thing that ' +
        'knows its own hostname; naming it here would be guessing, and would leave a row ' +
        'for a machine that may never appear.',
      'Shown once. Only its hash is stored, so a lost token is re-issued rather than ' +
        'recovered. Once used it becomes that machine\'s permanent credential: it can ' +
        'claim work and report on it, and nothing else.',
    ],
    flags: [
      [
        '--note <text>',
        'a note for your own benefit — "the mac", "the NAS". Shown against the ' +
          'outstanding invite in the UI. Never a machine name',
      ],
      [
        '--url <url>',
        'the address to print in the join command. Defaults to the first address the ' +
          'control plane believes it is reachable at, which it cannot verify from here — ' +
          'pass this when it is reached through a VPN, a proxy, or a bridged interface',
      ],
    ],
    touches: [['the database', 'an invite row, holding only the token hash']],
    see: ['ogun runner join'],
  },

  'runner join': {
    summary: 'join a control plane, from the machine being added',
    usage: [
      'ogun runner join <url> --token <token> [--name <name>] [--labels a,b] [--force]',
    ],
    where:
      'On the NEW MACHINE, with the command `ogun runner invite` printed on the ' +
      'control plane.',
    notes: [
      'Checks the URL answers before registering anything. A wrong or unreachable ' +
        'address is the most likely mistake in this flow and is otherwise silent until ' +
        'the first claim never happens.',
      'Merges into the local config rather than replacing it, so joining does not ' +
        'discard repository paths already registered here.',
    ],
    flags: [
      ['--token <token>', 'the single-use token `ogun runner invite` printed. Required'],
      ['--name <name>', NAME],
      ['--labels a,b', LABELS],
      [
        '--force',
        'join a different control plane, or under a different name. Refused without ' +
          'it: joining rewrites the runner block wholesale, so it would silently ' +
          'abandon the identity this machine already answers to. Re-joining the same ' +
          'control plane under the same name is a refresh and needs nothing',
      ],
    ],
    touches: [
      [LOCAL_CONFIG, 'the runner block, including the token — this is where it lives'],
      ['~/.ogun/work/', 'created — scratch space for workspaces'],
      ['the database', 'a runner row, and the invite marked used'],
    ],
    see: ['ogun runner start', 'ogun project add'],
  },

  project: {
    summary: 'the repositories the factory works on',
    usage: ['ogun project add [dir] | sync [dir] | list'],
    subcommands: [
      ['add [dir]', 'tell this machine where a repo is checked out'],
      ['sync [dir]', "read the repo's .ogun/config.yaml and register it"],
      ['list', 'every project the control plane knows about (the default)'],
    ],
  },

  'project add': {
    summary: 'tell this machine where a repo is checked out',
    usage: ['ogun project add [dir] [--name <slug>]'],
    where:
      'On each machine that should work from a local copy. The map is machine-local: a ' +
      'filesystem path is a fact about one machine, so it never travels the wire and ' +
      'never lands in the database.',
    notes: [
      "Optional. A runner with no local path clones from the project's remote instead, " +
        'so a machine that joined a minute ago can already work on anything. ' +
        'Registering one makes runs faster, works offline, and lets a co-located ' +
        "control plane edit that project's .ogun/config.yaml.",
      'The directory must be the repo itself — the one with .git in it.',
    ],
    flags: [
      [
        '--name <slug>',
        "register under this slug. Defaults to the name in the repo's .ogun/config.yaml, " +
          'or the directory name when there is none. Two names for one project means the ' +
          'path silently never matches',
      ],
    ],
    touches: [[LOCAL_CONFIG, 'the projects map: slug → absolute path']],
    see: ['ogun project sync', 'ogun runner doctor'],
  },

  'project sync': {
    summary: "read the repo's .ogun/config.yaml and register it with the control plane",
    usage: ['ogun project sync [dir]'],
    where:
      'On a machine with the repo checked out. The CLI is the half with filesystem ' +
      'access to a project; the server never touches one.',
    notes: [
      'Posts the project, its workers, its policies, and every skill it can discover. ' +
        'Workers that have gone from config.yaml are removed; workers created in the UI ' +
        'are left alone, since sync is not their source of truth.',
      'Registers the local path as `project add` would, so there is no need to run both.',
      'A skill or worker only reaches an automated run once it is on the default ' +
        'branch: the workspace is a clone at a pinned SHA, not your working copy. Sync ' +
        'says so when the tree is dirty.',
    ],
    touches: [
      [LOCAL_CONFIG, 'the projects map: slug → absolute path'],
      ['the database', 'the project, its workers, and its skills'],
    ],
    see: ['ogun workers', 'ogun skills'],
  },

  'project list': {
    summary: 'every project the control plane knows about',
    usage: ['ogun project list'],
  },

  skill: {
    summary: 'author skills in a repo',
    usage: ['ogun skill new <name> | link | show <name>'],
    subcommands: [
      ['new <name>', 'scaffold .agents/skills/<name>/'],
      ['link', 'link skills already in the repo into .claude/ and .codex/'],
      ['show <name>', 'read one, as `ogun skills show` does'],
    ],
    see: ['ogun skills'],
  },

  'skill new': {
    summary: 'scaffold a skill in the repo being reviewed',
    usage: ['ogun skill new <name> [--dir <repo>]'],
    where:
      'In the repo the skill belongs to. What "security review" means is a property of ' +
      'the codebase, so most skills live with the code rather than with Ogun.',
    notes: [
      'The name must be lowercase kebab-case: it becomes a directory and a config key.',
      'The scaffold leaves the parts that need thought marked TODO rather than filling ' +
        'them with plausible defaults you would forget to replace.',
      'It also links the new directory into .claude/skills/ and .codex/skills/. No ' +
        'single directory is read by both runtimes, so the files live in one place and ' +
        "each runtime's directory points at it.",
    ],
    flags: [['--dir <repo>', 'the repo to write into (default: the current directory)']],
    touches: [
      ['.agents/skills/<name>/', 'SKILL.md, agents/ogun.yaml, references/'],
      ['.claude/skills/, .codex/skills/', 'a relative symlink to the one copy'],
    ],
    see: ['ogun project sync', 'ogun skills show'],
  },

  'skill link': {
    summary: 'link skills already in the repo into .claude/ and .codex/',
    usage: ['ogun skill link [--dir <repo>]'],
    notes: [
      'For skills authored before `skill new` linked them, or a checkout on a ' +
        'filesystem that dropped the symlinks. An automated run never needs this — the ' +
        'runner copies the one skill a job needs into the workspace regardless — only ' +
        'opening the repo yourself does.',
      'Sources are .agents/skills/ and, inside the Ogun repo, skills/. The first wins, ' +
        "matching how the runner resolves a worker's skill.",
    ],
    flags: [['--dir <repo>', 'the repo to link in (default: the current directory)']],
    touches: [['.claude/skills/, .codex/skills/', 'one relative symlink per skill']],
  },

  skills: {
    summary: 'every skill, and which workers bind it',
    usage: [
      'ogun skills [--project <slug>]',
      'ogun skills show <name> [--project <slug>]',
      'ogun skills <name>',
    ],
    notes: [
      'A skill is the durable artifact and a worker is a thin binding of one to a ' +
        'runtime, so the useful column is who uses it: a skill nothing points at is dead ' +
        'weight, and that is invisible if you list skills and workers separately.',
    ],
    flags: [['--project <slug>', "only this project's skills"]],
    see: ['ogun skill new', 'ogun workers'],
  },

  'skills show': {
    summary: 'read one skill, including the SKILL.md a worker will run',
    usage: ['ogun skills show <name> [--project <slug>]'],
    notes: [
      '`ogun skill show <name>` and a bare `ogun skills <name>` are the same command, ' +
        'for whichever spelling you reach for.',
    ],
    flags: [
      [
        '--project <slug>',
        "which project's copy. Optional while the control plane knows one project, " +
          'required after that — a repo may override a builtin of the same name',
      ],
    ],
  },

  workers: {
    summary: 'every worker, and whether it is enabled',
    usage: ['ogun workers [project]'],
    notes: [
      'One row per worker: enabled or not, its project, the skill it binds, and the ' +
        'runtime, permissions and sandbox it runs with.',
      'The optional argument filters to one project. It is positional, not a flag.',
    ],
    see: ['ogun trigger', 'ogun project sync'],
  },

  cycles: {
    summary: 'every cycle: its graph, its schedule, and when it next fires',
    usage: ['ogun cycles [project]', 'ogun cycles show <name> [--project <slug>]'],
    notes: [
      'A cycle is a DAG of jobs and is the unit that schedules — a nightly fan-in of two ' +
        'reviewers into triage is one row here and three jobs a night.',
      'One row per cycle: its shape, the cron expression driving it, when that fires ' +
        'next, and how the last run ended. A cycle correct in config.yaml but never ' +
        'registered looks identical to a healthy one everywhere else, which is the gap ' +
        'this closes.',
      'The optional argument filters to one project. It is positional, not a flag.',
      "Single-worker cycles are left out. Every worker has one carrying its own " +
        'schedule, so listing them here would be `ogun workers` again under another name.',
    ],
    see: ['ogun cycles show', 'ogun workers', 'ogun trigger'],
  },

  'cycles show': {
    summary: 'one cycle in full: every node, what it waits for, and what it writes',
    usage: ['ogun cycles show <name> [--project <slug>]'],
    notes: [
      'Nodes in execution order, each with what it waits for and whether it stages or ' +
        'writes to the finding inbox. Staging is read off the graph rather than declared ' +
        'on the worker (§4.12), so this is the only place it is written down — a reviewer ' +
        'feeding triage publishes nothing itself, and nothing in config.yaml says so.',
      'Also the next three occurrences, computed by the same parser the foreman uses, so ' +
        'the answer is what this control plane will do rather than what the expression ' +
        'means in the abstract.',
    ],
    flags: [
      [
        '--project <slug>',
        'which project owns the cycle. Only needed when two projects have a cycle of the ' +
          'same name',
      ],
    ],
    see: ['ogun cycles', 'ogun coverage'],
  },

  trigger: {
    summary: 'queue a run now',
    usage: ['ogun trigger <project> <worker>'],
    where:
      'Anywhere with admin access to the control plane. The run itself happens on ' +
      'whichever runner claims the job.',
    notes: [
      'Goes through the same cycle machinery a schedule does, so there is no separate ' +
        '"run it now" code path to diverge.',
      'Admission can still refuse a job, in which case it is reported here as skipped ' +
        'and recorded in the coverage ledger rather than silently dropped.',
    ],
    touches: [['the database', 'a cycle run and its jobs, queued']],
    see: ['ogun runs', 'ogun coverage'],
  },

  runs: {
    summary: 'the last 30 runs',
    usage: ['ogun runs'],
    notes: ['No flags and no filter — the web UI is where you drill into one.'],
  },

  coverage: {
    summary: 'what ran for a project, what did not, and why',
    usage: ['ogun coverage <project>'],
    notes: [
      'A worker that never ran and a worker that ran and found nothing are different ' +
        'facts. The ledger records both, with the reason a job was refused.',
    ],
  },

  findings: {
    summary: 'the finding inbox, and the format agents write',
    usage: ['ogun findings list [--project <slug>] [--status <a,b>]', 'ogun findings write | schema'],
    subcommands: [
      ['list', 'the inbox (the default)'],
      ['write', 'validate a findings document on stdin and write it — used inside the sandbox'],
      ['schema', 'print the document shape and what a fingerprint means'],
    ],
  },

  'findings list': {
    summary: 'the finding inbox',
    usage: ['ogun findings list [--project <slug>] [--status <a,b>]'],
    flags: [
      ['--project <slug>', 'only this project'],
      [
        '--status <a,b>',
        'comma-separated statuses to include. Defaults to open,triaged — the inbox, ' +
          'rather than everything ever found',
      ],
    ],
  },

  'findings write': {
    summary: 'validate a findings document on stdin and write it',
    usage: ['ogun findings write [--out <file>]'],
    where:
      'Inside the sandbox, by a skill — not usually by a human. The CLI owns every ' +
      'format an agent touches, so a skill never asks for well-formed JSON in prose: an ' +
      'agent that free-hands its output produces a different shape every night and ' +
      'nothing downstream can depend on it.',
    notes: [
      'Rejects a document that does not match the schema, and a fingerprint that is not ' +
        '<area>/<surface>/<invariant>/<technique>, printing the expected shape.',
      'Writing an empty findings array is meaningful and expected: a clean review and a ' +
        'review that never happened are different facts.',
    ],
    flags: [
      ['--out <file>', 'where to write (default: .ogun-out/findings.json, or OGUN_OUTPUT_PATH)'],
    ],
    touches: [['.ogun-out/findings.json', 'the validated document, mode 0600']],
    see: ['ogun findings schema', 'ogun validate-findings'],
  },

  'findings schema': {
    summary: 'print the shape of a findings document',
    usage: ['ogun findings schema'],
    notes: [
      'What a skill prints when it needs to remind itself, and the definition of a ' +
        'fingerprint: it names the meaning of an issue rather than its location, so the ' +
        'same problem found next week is recognised as the same finding and a rebase ' +
        'does not mint a new identity for it.',
    ],
  },

  'validate-findings': {
    summary: 'schema-check a findings document',
    usage: ['ogun validate-findings [file]'],
    where: 'Inside the sandbox, as a verify lens. Exits non-zero on a document that does not hold.',
    notes: ['The file defaults to .ogun-out/findings.json, or OGUN_OUTPUT_PATH.'],
  },

  'check-citations': {
    summary: 'check every cited path and line exists in the tree that was reviewed',
    usage: ['ogun check-citations [file]'],
    where:
      'Inside the sandbox, as a verify lens, in the workspace root — it reads the tree ' +
      'through `git ls-files`. Exits non-zero when a citation does not hold.',
    notes: [
      'Cheap, and it runs before any expensive verification step. The line half matters ' +
        'as much as the path: a confabulated finding names a real file at an invented ' +
        'location, and a path-only check waves that through.',
      'The file defaults to .ogun-out/findings.json, or OGUN_OUTPUT_PATH.',
    ],
  },

  token: {
    summary: 'the admin secret for this control plane',
    usage: ['ogun token show [--quiet] | ogun token rotate'],
    where: 'On the control-plane machine — it is the only one that has it.',
    subcommands: [
      ['show', 'print it (the default)'],
      ['rotate', 'replace it, invalidating every session and export'],
    ],
  },

  'token show': {
    summary: "print this machine's admin secret",
    usage: ['ogun token show [--quiet]'],
    where: 'On the control-plane machine.',
    notes: [
      'There is deliberately no create step. `ogun server` generates one the first time ' +
        'it binds beyond localhost and stores it, and the CLI on that machine reads the ' +
        'same file — so nobody has to carry a secret between two commands. You need to ' +
        'see it only to unlock the web UI from another device, or to run the CLI from one.',
      'Runners do not need this and should not have it. They get their own credential ' +
        'from `ogun runner invite`, which cannot define a worker.',
    ],
    flags: [['--quiet, -q', 'print the bare token, for export OGUN_ADMIN_TOKEN=$(…)']],
  },

  'token rotate': {
    summary: 'replace the admin secret',
    usage: ['ogun token rotate'],
    where: 'On the control-plane machine.',
    notes: [
      'Every browser session and every exported OGUN_ADMIN_TOKEN stops working. Runner ' +
        'tokens are separate credentials and are unaffected.',
      'Restart `ogun server` for it to take effect — the running process holds the old one.',
    ],
    touches: [[LOCAL_CONFIG, 'the new token, replacing the old']],
  },
}

// `ogun skill show` and `ogun skills show` are the same command, so they are the same page.
topics['skill show'] = topics['skills show']!

/**
 * `ogun <command> --help` before `ogun --help`: a two-word path wins over its parent, so
 * `runner join` gets its own page while `runner frobnicate` still lands on `runner`.
 */
export function helpFor(path: string[]): string | undefined {
  const words = path.filter((a) => !a.startsWith('-'))
  const topic = topics[words.slice(0, 2).join(' ')] ?? topics[words[0] ?? '']
  return topic ? render(canonical(words, topic), topic) : undefined
}

/** The name to print in the heading — the two-word form only when that is a real topic. */
const canonical = (words: string[], topic: Topic): string =>
  topics[words.slice(0, 2).join(' ')] === topic ? words.slice(0, 2).join(' ') : (words[0] ?? '')

function render(name: string, t: Topic): string {
  const out: string[] = [`${bold(`ogun ${name}`)} — ${t.summary}`, '']
  for (const line of t.usage) out.push(`  ${cyan(line)}`)
  if (t.where) out.push('', wrap(t.where, '  '))
  for (const note of t.notes ?? []) out.push('', wrap(note, '  '))

  const section = (heading: string, rows: Array<[string, string]>): void => {
    out.push('', bold(heading), definitions(rows))
  }
  if (t.subcommands) section('commands', t.subcommands)
  if (t.flags) section('flags', t.flags)
  if (t.env) section('environment', t.env)
  if (t.touches) section('touches', t.touches)
  if (t.see) out.push('', bold('see also'), `  ${t.see.map((s) => cyan(s)).join('  ')}`)
  return out.join('\n')
}

/**
 * A two-column list where the description wraps under itself, because the description is
 * where the reason a flag exists gets written down and it must not be cut short. A term
 * wider than the column keeps its own line rather than pushing every description right.
 */
function definitions(rows: Array<[string, string]>): string {
  const width = Math.min(26, Math.max(...rows.map(([term]) => term.length)))
  const indent = ' '.repeat(width + 4)
  return rows
    .map(([term, desc]) => {
      const wrapped = wrap(desc, indent)
      return term.length > width
        ? `  ${cyan(term)}\n${wrapped}`
        : `  ${cyan(term)}${' '.repeat(width - term.length)}  ${wrapped.trimStart()}`
    })
    .join('\n')
}

const WIDTH = 88

function wrap(text: string, indent: string): string {
  const lines: string[] = []
  let line = indent
  for (const word of text.split(/\s+/)) {
    if (line.trim() !== '' && line.length + 1 + word.length > WIDTH) {
      lines.push(line)
      line = indent
    }
    line += line === indent ? word : ` ${word}`
  }
  lines.push(line)
  return lines.join('\n')
}

export const isHelpFlag = (arg: string): boolean =>
  arg === '--help' || arg === '-h' || arg === 'help'

export const usage = (serverUrl: string): string => `${bold('ogun')} — a local-first software factory

${bold('setup')}
  ogun init                        database, schema, sandbox image — run this first
  ogun db up | down | migrate | status
  ogun image build [project-dir]   build ogun/base, or a project image

${bold('running it')}
  ogun server                      start the control plane and web UI
  ogun runner init [--name]        make this machine a runner for it
  ogun runner start                start a runner on this machine
  ogun runner doctor               what this machine can actually run

${bold('adding a machine')}
  ogun runner invite               on the CONTROL PLANE — mints a join token
  ogun runner join <url> --token   on the NEW MACHINE — paste what invite printed
  ogun token show                  admin secret, to unlock the UI from another device

${bold('projects')}
  ogun project add [dir] [--name]  tell this machine where a repo is checked out
  ogun project sync [dir]          read .ogun/config.yaml and register it
  ogun project list

${bold('what can run')}
  ogun skill new <name>            scaffold .agents/skills/<name>/
  ogun skill link                  link existing skills into .claude/ and .codex/
  ogun skills                      every skill, and which workers bind it
  ogun skills show <name>          read one, including its SKILL.md
  ogun workers [project]           every worker
  ogun cycles [project]            every cycle: graph, schedule, next fire
  ogun cycles show <name>          one cycle's full graph

${bold('running')}
  ogun trigger <project> <worker>  queue a run now
  ogun runs                        recent runs
  ogun coverage <project>          what ran, what didn't, and why

${bold('findings')}
  ogun findings list [--project x] [--status open]
  ogun findings schema             print the document shape

${bold('used by skills, inside the sandbox')}
  ogun findings write [--out f]    validate a findings document on stdin and write it
  ogun validate-findings [file]    schema check          (verify lens)
  ogun check-citations [file]      grounding check       (verify lens)

${dim('ogun <command> --help  ·  every flag, and which machine the command runs on')}
${dim(`control plane: ${serverUrl}`)}`
