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
  /**
   * Definition lists with their own headings, for a command whose options are not one
   * flat set.
   *
   * `ogun connect` is the reason. Its flags come in two levels — *which kind of thing you
   * are connecting*, and then *how* — and rendering them as one alphabetical block is
   * exactly the flattening the command was reshaped to undo: `--api-key` and `--consent`
   * side by side read as alternatives, when one names a kind of integration and the other
   * selects a grant inside the other kind.
   */
  groups?: Array<{ heading: string; rows: Array<[string, string]> }>
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
    usage: ['ogun image build [project-dir] [--name <slug>]'],
    where:
      'On every machine that runs container jobs. The image is built locally, never ' +
      'pulled, so it has to exist where the container starts.',
    notes: [
      'With no argument: ogun/base:latest from images/base. The CLI is bundled into it ' +
        'first, so the in-sandbox `ogun findings write` cannot drift from the validator ' +
        'that will read its output.',
      'With a directory: ogun/project-<slug>:latest from <dir>/.ogun/Dockerfile. A ' +
        "project image is FROM ogun/base plus that project's toolchain, and a modifier " +
        'worker needs one — the base image is enough to read a repo and not enough to build it.',
      'The tag comes from `project.name` in the directory\'s .ogun/config.yaml, not from ' +
        'the directory name, because that is what the runner looks the image up by. A ' +
        'worktree or a clone under another name would otherwise build an image no job asks ' +
        'for. --name overrides it, matching `ogun project add --name`.',
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
    notes: [
      "A project's credentials are `ogun connect` (an integration) or `ogun secret` (any " +
        'other value it needs). Both moved out of this namespace when the project stopped ' +
        'being a positional and started coming from the directory you are standing in, as ' +
        '`add` and `sync` always have.',
    ],
    see: ['ogun connect', 'ogun secret'],
  },

  connect: {
    summary: 'give a project access to an integration — Linear today, others as they land',
    /**
     * **The usage lines name every input, including the ones that are not arguments.**
     *
     * This is the fourth time the point has been made about this CLI and it is the
     * acceptance bar for the change that produced this page. `ogun linear app [--project
     * <slug>]` read as a complete command that takes nothing; the two values it exists to
     * collect appeared nowhere in it, so the only way to discover that it prompts was to
     * run it.
     *
     * The credentials were positionals for one commit, which put them in the signature
     * and still got it wrong: a client id and a client secret are two opaque strings from
     * the same page of Linear's settings, and a fixed order between them is a coin flip.
     * They are named flags now, and the flag names are the part a reader has to see.
     */
    usage: [
      'ogun connect <integration> --client-id <id> --client-secret <secret> [--project <slug>]',
      'ogun connect <integration> --consent --client-id <id> --client-secret <secret>',
      'ogun connect <integration> --api-key [<key>] [--replace] [--project <slug>]',
      'ogun connect list [--project <slug>]',
    ],
    notes: [
      '<integration> — which product. One of: linear. It is an argument rather than a word ' +
        'in the command path, so github and jira become values here rather than whole new ' +
        'command trees.',
      'The FLAG NAMES WHAT YOU ARE CONNECTING, and that decides what else is required. ' +
        '--oauth is an application you registered, which always means a client id and a ' +
        'client secret; --api-key is one key and has neither. --oauth is the default, so ' +
        'the first line above is what most people type:\n' +
        '    ogun connect linear                                    prompts for both\n' +
        '    ogun connect linear --client-id abc123                 prompts for the secret\n' +
        '    ogun connect linear --api-key                          prompts for the key',
      '--client-id <id> — the Client ID of the OAuth application you registered at ' +
        'https://linear.app/settings/api/applications/new. Not a secret: it is in every ' +
        "authorization URL a browser visits and on Linear's own settings page. Omit the " +
        'flag to be prompted, VISIBLY, so you can check what you pasted — or to keep the ' +
        'one already registered here.',
      '--client-secret <secret> — the Client Secret from that same page. Omit the flag and ' +
        'you are prompted with the echo off; pipe it and it is read from stdin:\n' +
        '    op read op://vault/linear/secret | ogun connect linear --client-id abc123\n' +
        '  Passing it inline works and prints a warning, because argv is readable by every ' +
        'user on the box through /proc/<pid>/cmdline while the command runs, and your shell ' +
        'writes the whole line into ~/.zsh_history or ~/.bash_history where nothing cleans ' +
        'it up. Prefer the prompt or the pipe.',
      '--api-key [<key>] — the personal API key, on exactly the same terms: leave the ' +
        'value off to be prompted with the echo off, pipe it, or pass it inline and be ' +
        'warned.\n' +
        "    printf 'lin_api_…' | ogun connect linear --api-key\n" +
        '    ogun connect linear --api-key=lin_api_…                 works, and warns',
      'With no --client-id and no --client-secret, an application already registered on ' +
        'this machine is reused and nothing is asked for. That is the reconnect after a ' +
        'token lapses and the retry after one that failed on the network. Giving only ' +
        '--client-secret rotates the secret and keeps the registered client id; giving a ' +
        'NEW --client-id always asks for its own secret, because a secret belongs to the ' +
        'application it was issued for.',
      'A per-project value that is NOT an integration — a webhook signing key, a token a ' +
        'skill is handed — is `ogun secret set <name> <key>`. That command and ' +
        '`connect --api-key` write the same row for the same name, through the same lock, ' +
        'so they cannot disagree about what is stored.',
    ],
    where:
      'On the control-plane machine, because the control plane is what polls and that is ' +
      'where the credential has to be. Only --consent needs the server to be running: its ' +
      'CSRF nonce and its callback both live in that process. Everything else writes ' +
      'config.json directly, so it works before `ogun init`, with the database down, and ' +
      'over SSH.',
    subcommands: [['list', 'what this machine is connected to, how, and how healthy each one is']],
    groups: [
      {
        heading: 'what you are connecting',
        rows: [
          [
            '--oauth',
            'an OAuth application you registered in the provider. THE DEFAULT, so no flag ' +
              'is needed; the explicit spelling is for a script that must keep meaning ' +
              'this even if the default changes. Requires --client-id and --client-secret. ' +
              "Ogun asks Linear for a token in its OWN name — no browser, no consent " +
              'screen, nobody to approve it. The token lasts 30 days and is renewed by ' +
              "asking again, and it reaches the workspace's PUBLIC teams and no others",
          ],
          [
            '--api-key <key>',
            'one personal API key, and no application. Everything Ogun does, it does AS ' +
              'YOU — and once write-back lands, every comment it posts appears under your ' +
              'name on a board other people read. The fallback for a workspace where you ' +
              'cannot register an application at all',
          ],
        ],
      },
      {
        heading: 'which OAuth grant (only with --oauth, which it implies)',
        rows: [
          [
            '--consent',
            'the authorization-code grant instead of client-credentials: Ogun prints a URL, ' +
              'somebody opens it and approves the installation, and the token that comes ' +
              'back sees what THEY can see. YOU NEED THIS IF YOUR TEAMS ARE PRIVATE — a ' +
              'client-credentials token reaches public teams only, so a private workspace ' +
              'polls successfully and finds nothing, forever. Also what to use when Ogun ' +
              'should see one person\'s view rather than the workspace\'s. The cost: it ' +
              'installs at the workspace level, so Linear needs a workspace ADMIN to ' +
              'approve it, and it is the one shape that needs the control plane running. ' +
              'You do not also pass --oauth; --consent already means it. It is refused ' +
              'beside --api-key, which has nobody to approve anything',
          ],
        ],
      },
    ],
    flags: [
      [
        '--project <slug>',
        'which project, instead of the one this directory belongs to. For a control plane ' +
          'that polls a repo it has no copy of',
      ],
      [
        '--allow-unregistered',
        'connect a slug this machine has no record of. Only for the case above: it has to ' +
          'match the name the control plane polls the project under, exactly, and nothing ' +
          'here can check that',
      ],
      [
        '--replace',
        'with --api-key only: this project already has a key stored under that name and ' +
          'destroying it is what you mean. Without it, a terminal is asked and a script ' +
          'is REFUSED, because there is no history and the value being overwritten cannot ' +
          'be recovered from this machine. The same flag `ogun secret set` takes, for the ' +
          'same row. It is refused beside --oauth, which destroys nothing that cannot be ' +
          'got again: the application stays registered and the token it replaces was going ' +
          'to expire anyway',
      ],
    ],
    env: [
      [
        'OGUN_PUBLIC_URL',
        'with --consent only: the address a browser reaches this control plane at, when it ' +
          'is not the one this process sees — a reverse proxy terminating TLS. The redirect ' +
          'URI is built from it and Linear matches that string exactly. The default grant ' +
          'has no redirect URI at all, because it has no browser',
      ],
    ],
    touches: [[LOCAL_CONFIG, 'the oauth block (or secrets, with --api-key), mode 0600']],
    see: ['ogun connect list', 'ogun disconnect', 'ogun secret', 'ogun runner doctor'],
  },

  'connect list': {
    summary: 'what this machine is connected to, how, and how healthy each one is',
    usage: ['ogun connect list [--project <slug>]'],
    where:
      "On the control-plane machine. It reads this machine's config.json directly rather " +
      'than asking the server, so it answers when the server is down — which is when the ' +
      'question is usually asked.',
    notes: [
      'It was `ogun connections`, a top-level noun beside three verbs. A listing is now a ' +
        'subcommand — `connect list`, mirroring `secret list` — and the old spelling is ' +
        'refused with a line naming this one.',
      'One table where there used to be two. `ogun linear status` showed grants and `ogun ' +
        'secret list` showed keys, and neither could see the other, so a project with both ' +
        'appeared twice with no indication that only one of them was being read.',
      'The VIA column is the mechanism: `app token` (client credentials, public teams ' +
        'only), `consent` (authorization code, whatever the approver could see), or `api ' +
        'key`. It is there because the two grants differ in what they can SEE, and ' +
        '"connected" alone cannot explain a source that finds no tickets.',
      'A key stored behind a working grant is reported in red as NOT used. An OAuth grant ' +
        'wins over a personal key, so rotating that key would be changing something nothing ' +
        'reads — an evening gone. `ogun secret list` says the same thing about the same ' +
        'row, in the same words.',
      'It shows KEYS ONLY WHERE THE NAME IS AN INTEGRATION. `ogun secret set` stores ' +
        'free-form names now, and a webhook signing key is not something a project can ' +
        'reach anything with. Anything left out is counted in the last line, so a short ' +
        'table never quietly implies an empty store.',
      'It does not narrow to the current directory the way `connect` and `disconnect` do. ' +
        'Those act on exactly one project, so naming the wrong one is their whole failure ' +
        'mode; this acts on none, and a listing that answered for wherever the shell was ' +
        'standing would say "nothing connected" on a machine holding four.',
      'No command, flag or endpoint anywhere prints a stored value back. The types this ' +
        'reads have no field one would fit in, so it cannot start leaking one by somebody ' +
        'adding a column.',
      'It cannot say what is MISSING: which projects need a credential is a fact in each ' +
        "repository's .ogun/config.yaml, and this reads no repositories.",
    ],
    see: ['ogun connect', 'ogun secret list', 'ogun runner doctor'],
  },

  disconnect: {
    summary: 'remove every credential a project has for an integration',
    usage: ['ogun disconnect <integration> [--project <slug>] [--keep-application]'],
    where:
      'On the control-plane machine. It reaches no server at all, which matters here more ' +
      'than anywhere: the moment you most want a credential gone is during an incident, ' +
      'and an incident is when the control plane is least likely to be answering.',
    notes: [
      'It removes the access token, the client id and secret, and any personal API key ' +
        'stored for that project — everything `connect` could have written.',
      'A top-level verb rather than `connect rm`, and that is not an oversight: it revokes ' +
        'a token at Linear, which is an act on the outside world rather than the removal of ' +
        'a row from a listing.',
      'The client id and secret go by default because under the default grant they ARE the ' +
        'credential: anyone holding them can mint a live token, and the next poll would. A ' +
        'disconnect that left them behind is one the machine undoes by itself.',
      '--keep-application keeps them, so reconnecting with --consent is one command instead ' +
        'of a trip back to Linear. It is REFUSED on a client-credentials connection, for ' +
        'the reason above — a warning about a state that reverts itself within one poll ' +
        'interval is a warning nobody can act on.',
      'The token is revoked at Linear too, best-effort. A disconnect that depended on ' +
        'Linear being reachable would leave you unable to remove a credential from your own ' +
        'machine during an outage. Whether it worked is reported as its own line.',
      'Neither the integration nor the project is checked against anything, where `connect` ' +
        'checks both. config.json gets hand-edited and `connect list` prints whatever it ' +
        'finds, so a row you can see has to be a row you can remove. Validation guards ' +
        'writes, which is where an unknown name or slug creates a credential nothing reads.',
      'To remove a value that is not an integration credential, that is `ogun secret rm ' +
        '<name>`.',
    ],
    flags: [
      ['--project <slug>', 'which project, instead of the one this directory belongs to'],
      [
        '--keep-application',
        'leave the client id and secret behind. Only for a --consent connection',
      ],
    ],
    touches: [[LOCAL_CONFIG, 'the oauth and secrets blocks for that project']],
    see: ['ogun connect', 'ogun connect list'],
  },

  secret: {
    summary: 'a value a project needs, kept on the machine that polls',
    usage: [
      'ogun secret set <name> <key> [--replace] [--project <slug>]',
      'ogun secret list [--project <slug>]',
      'ogun secret rm <name> [--project <slug>]',
    ],
    where:
      'On the control-plane machine — that is what reads these. It reaches no server: the ' +
      'store is this machine\'s ' + LOCAL_CONFIG + ' at mode 0600, written directly, so it ' +
      'works before `ogun init`, with the database down, and over SSH.',
    notes: [
      'This and `ogun connect` are not two spellings of one act. `connect` is ACCESS — ' +
        'which product, and how Ogun gets in; it knows what a grant is, what a client id ' +
        'is, and refuses an integration it cannot poll. This is STORAGE — one free-form ' +
        'name, one value, for anything at all. A secret is not guaranteed to be an ' +
        'integration.',
      'They overlap on exactly one thing and it is the same row: `ogun secret set linear ' +
        '<key>` and `ogun connect linear --api-key <key>` write the same slot, through the ' +
        'same function, under the same lock — so a key stored by one is the key the other ' +
        'reports, and a key that a grant has taken over is refused by BOTH.',
      'Names are free-form and are whatever your project calls the thing — ' +
        '`DATABASE_URL`, `stripe-webhook`, `my_api_key`. Only what cannot work is refused: ' +
        'empty, whitespace, a control character, and `__proto__`. What replaces the ' +
        'protection a closed set gave is that `set` says out loud when nothing in this ' +
        'build reads the name you just stored, which is the fact the closed set existed to ' +
        'prevent you from discovering at 2am.',
      'A name that is already taken is settled BEFORE the value is asked for: at a ' +
        'terminal you are asked, and off one it is refused unless you pass --replace. ' +
        'There is no history, so an overwrite cannot be undone — and the same rule holds ' +
        'at `ogun connect <integration> --api-key`, which writes the same row.',
    ],
    subcommands: [
      ['set <name> <key>', 'store one value under one name for one project'],
      ['list', 'every value stored on this machine, and what reads each one (the default)'],
      ['rm <name>', 'forget one'],
    ],
    see: ['ogun secret set', 'ogun connect', 'ogun connect list'],
  },

  'secret set': {
    summary: 'store one value under one name for one project',
    /**
     * `<key>` is a positional where `connect` names its credentials as flags, and the rule
     * behind both is one sentence: **a lone value can be positional; several credential
     * values of the same shape must be named.** There is nothing here for it to be
     * confused with — `<name>` is not a credential and does not look like one.
     */
    usage: ['ogun secret set <name> <key> [--replace] [--project <slug>]'],
    notes: [
      '<name> — whatever your project calls it. `DATABASE_URL`, `STRIPE_SECRET_KEY`, ' +
        '`stripe-webhook`, `my_api_key`: case is kept, and dashes and underscores are ' +
        'both fine. Only what cannot work is refused — an empty name; whitespace, because ' +
        '`ogun secret rm` takes one word and `list` separates its columns with spaces; a ' +
        'control character, because names are printed back to this terminal; and ' +
        '`__proto__`, which the config file cannot hold — the schema it is read back ' +
        'through drops that key, so the value would vanish on the next write. An earlier ' +
        'build refused underscores and capitals. It should not have, and does not.',
      '<key> — the value. Leave it off and it is prompted for with the echo off at a ' +
        'terminal, or read from stdin when stdin is a pipe:\n' +
        '    ogun secret set stripe-webhook                         prompts\n' +
        "    op read op://vault/stripe/whsec | ogun secret set stripe-webhook\n" +
        '  Passing it inline works and prints a warning, because argv is readable by every ' +
        'user on the box through /proc/<pid>/cmdline while the command runs, and your shell ' +
        'writes the whole line into ~/.zsh_history or ~/.bash_history where nothing cleans ' +
        'it up. Prefer the prompt or the pipe.',
      'A NAME THAT IS ALREADY TAKEN IS SETTLED FIRST, before the value is asked for. At ' +
        'a terminal you are asked; off one — a pipe, a script, CI — it is REFUSED unless ' +
        'you pass --replace. There is no history and no second slot, so the value being ' +
        'overwritten is gone: a rotation window belongs to whoever issued the value, and ' +
        'two live values in one store means that when something 401s nothing can say which ' +
        'one it used. The confirmation still says whether it stored or REPLACED.',
      'If nothing in this build reads the name, it says so — after storing it, not instead ' +
        'of storing it. Ogun polls under: linear. Anything else is stored for whatever ' +
        'reads it, and the line is there so "nothing reads this" is something you are told ' +
        'now rather than something you infer from a failure later.',
      'A name that IS an integration is refused when that project already has a working ' +
        'OAuth grant, because a grant wins over a key and the value would sit in the file ' +
        'being read by nothing. `ogun disconnect <name>` first. This is the same refusal ' +
        '`ogun connect --api-key` gives, from the same function.',
      'The value never crosses a network, never enters the database, never reaches a ' +
        'sandbox, and is never printed back — not by this command, not by `list`, not by ' +
        'any endpoint. The confirmation gives a character count and nothing else, not even ' +
        'the last four characters.',
    ],
    flags: [
      [
        '--project <slug>',
        'which project, instead of the one this directory belongs to. The directory is ' +
          'resolved exactly as `ogun project add` and `ogun project sync` resolve it',
      ],
      [
        '--allow-unregistered',
        'store under a slug this machine has no record of — for a control plane whose ' +
          'repositories are checked out somewhere else. It warns, because a slug nothing ' +
          'here can confirm is a typo until something fails',
      ],
      [
        '--replace',
        'there is already a value under this name and destroying it is what you mean. ' +
          'This is how a script says so, and a script without it fails rather than ' +
          'overwriting something it did not know was there. Passing it when nothing is ' +
          'stored is fine and does nothing. `ogun connect <integration> --api-key` takes ' +
          'the same flag for the same row',
      ],
    ],
    touches: [[LOCAL_CONFIG, 'the secrets block for that project, mode 0600']],
    see: ['ogun secret list', 'ogun connect'],
  },

  'secret list': {
    summary: 'every value stored on this machine, and what reads each one',
    usage: ['ogun secret list [--project <slug>]'],
    notes: [
      'The READ BY column is the point. `the linear poll` is a value something in this ' +
        'build actually authenticates with; `nothing in this build` is a value stored under ' +
        'a name nothing reads — which is fine for a secret some other tool consumes, and is ' +
        'a typo the rest of the time; `nothing — the linear grant wins` is a key sitting ' +
        'behind an OAuth grant, in red, because rotating it would change something nothing ' +
        'reads. `ogun connect list` says the same about the same row.',
      'It lists the whole machine unless --project narrows it, for the reason `connect ' +
        'list` does: a listing that answered for wherever the shell was standing would ' +
        'report an empty store on a machine holding four projects\' credentials.',
      'Values are never printed, and there is no field in what this reads that one would ' +
        'fit in. Grants are not secrets and are not here — `ogun connect list`.',
    ],
    see: ['ogun secret set', 'ogun connect list'],
  },

  'secret rm': {
    summary: 'forget one stored value',
    usage: ['ogun secret rm <name> [--project <slug>]'],
    notes: [
      'Nothing is checked — not the name, not the project — where `set` checks both. ' +
        LOCAL_CONFIG + ' gets hand-edited and `list` prints whatever it finds, so a row you ' +
        'can see has to be a row you can remove; refusing would strand a live credential in ' +
        'the file with the listing still advertising it.',
      'Finding nothing to remove is its own answer, said in a colour and naming the project ' +
        'it looked in, because the project is inferred from the directory and an `rm` run ' +
        'one level too high is a plausible way to reach it. It still exits 0: a removal that ' +
        'finds nothing has reached the state it was asked for.',
      'It cannot touch an OAuth grant, so a project that is still connected is told it is ' +
        'still connected. `ogun disconnect <integration>` is what removes one.',
    ],
    see: ['ogun secret list', 'ogun disconnect'],
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
 * The dropped spellings still answer `--help`, and answer it with the page that replaced
 * them.
 *
 * `main.ts` refuses the commands themselves with a line naming the replacement. That
 * covers somebody who ran the old command; it does not cover somebody who read an old
 * README and typed `ogun connections --help` first, whose reward would otherwise be "no
 * help for: connections" — which reads as "that does not exist" rather than "that moved".
 * These are pointers, not aliases: the commands are gone.
 */
topics['connections'] = topics['connect list']!
topics['connection'] = topics['connect list']!
topics['linear'] = topics['connect']!

// `ogun secrets list` is what somebody types after reading the plural everywhere else.
topics['secrets'] = topics['secret']!
topics['secrets set'] = topics['secret set']!
topics['secrets list'] = topics['secret list']!
topics['secrets rm'] = topics['secret rm']!

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
  for (const group of t.groups ?? []) section(group.heading, group.rows)
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

/**
 * Wrap prose to `WIDTH`, and leave anything the author laid out by hand alone.
 *
 * The previous implementation was `text.split(/\s+/)`, which treats a newline as one more
 * space — so every `\n` an author wrote was destroyed and the whole entry re-flowed into a
 * single paragraph. The visible cost was in `ogun connect`, whose two worked examples ran
 * together into the sentence above them:
 *
 *     pipe it and it is read from stdin: ogun connect linear prompts for both op read
 *     op://vault/linear/secret | ogun connect linear <client-id> Passing it inline works
 *
 * A help topic is the one place a person reads before they know what they are doing, and
 * an example is the part they copy. Newlines are now paragraph breaks, and a line the
 * author indented is emitted verbatim — an example is already the width its author chose,
 * and re-flowing a command line makes it wrong rather than merely ugly.
 */
function wrap(text: string, indent: string): string {
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    /**
     * Four spaces or more is a worked example, by the same convention Markdown uses for a
     * code block. Not merely "indented": a continuation line the author indented by two to
     * keep the source readable is still prose and still wants wrapping, and treating it as
     * verbatim pushes it past the width instead.
     */
    if (/^ {4,}/.test(paragraph)) {
      out.push(paragraph.trim() === '' ? '' : indent + paragraph.replace(/\s+$/, ''))
      continue
    }
    let line = indent
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line.trim() !== '' && line.length + 1 + word.length > WIDTH) {
        out.push(line)
        line = indent
      }
      line += line === indent ? word : ` ${word}`
    }
    out.push(line)
  }
  return out.join('\n')
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
  ogun connect <integration>       give this project access to Linear (or the next one)
  ogun connect list                what is connected, how, and how healthy
  ogun disconnect <integration>    remove every credential for it
  ogun secret set <name> <key>     any other value a project needs, on this machine
  ogun secret list | rm <name>

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
