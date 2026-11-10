# Docker Logs

An Orca sidebar panel for the Docker Compose containers of the focused project: state, CPU and
memory over time, ports, start / stop / restart / rebuild, a shell, and a live log with error
highlighting whose stack traces open the code, and that you can hand to your agent in one click.

**Catalog listing:** [Docker Logs on Orca](https://www.onorca.dev/plugins/eskono/orca-docker-logs).
It runs its own worker (it calls the `docker` CLI, opens terminals and starts agents), so Orca
asks you to approve full access.

![The panel: services with CPU, memory and ports above the api container's log](assets/screenshot-dark.webp)

## What it does

- **Services from the compose files.** The worker asks `docker compose config` in the workspace
  folder, so Compose picks the files the way it does in a terminal (`compose.yaml` /
  `docker-compose.yml`, their `.override`, `COMPOSE_FILE` from `.env`). Services of every
  profile are listed; one that never ran shows its profile and starts with it. **Compose settings**
  selects custom files (one workspace-relative path per line) and profiles for Up. Settings are
  checked before saving and belong to that workspace. Custom files keep the workspace's `.env`
  when present, unless `COMPOSE_ENV_FILES` or `COMPOSE_DISABLE_ENV_FILE` overrides dotenv use.
  Build/bind paths still resolve from the first Compose file. Empty fields restore Compose defaults.
- **State at a glance.** A dot per container (running, starting, unhealthy, crashed), uptime,
  CPU and memory from `docker stats` with a small chart of the last minutes (line: CPU, dashes:
  memory). Click a published port to copy its address; the adjacent arrow opens recognized web
  ports using HTTP or HTTPS. Database ports are addresses to copy. Hover a row for the last
  health check output, the memory limit and the CPU and memory range.
- **Diagnostics.** Expand the selected container's diagnostics to see its exit code, OOM-kill
  flag, restart count, runtime error, last health check and start/finish times. The Docker context
  is shown above the services, with the endpoint in its tooltip and a label for remote daemons.
- **The project follows Orca's focus.** The picker at the top lists every local workspace with a
  compose file or saved configuration, to look at another one. The focused local workspace is
  also listed when it has no automatically discovered file, so custom files can be configured.
  Drag the divider below the services, or focus it and use the arrow keys, to resize the list.
- **Actions.** Per container: shell (`docker exec -it … bash`, or `sh`), rebuild
  (`compose up -d --build`), restart, stop, start. For the project: Up, Restart and Down (Down
  asks for a second click). Commands that may build or pull (Up, rebuild, creating a container)
  run in a new Orca terminal tab so you see their output.
- **Logs.** One container or **All services** interleaved by time and tagged by container, with
  ANSI colours. Errors and warnings are highlighted in plain, logfmt and JSON logs, stack traces
  included; the level picker shows only them. Periods: the last 1000 lines, 5 or 15 minutes, an
  hour, or since the container started. Filter, timestamps, wrap, and **Save** to a file.
  Programs that print no colours under Docker still get their level word coloured. **Copy** uses
  your selected log text, or all visible lines when nothing is selected. Polling keeps unchanged
  line elements, so new messages do not discard text selection.
- **Structured logs and repeated errors.** **JSON fields** expands object fields, including nested
  fields. Filter with `trace_id=abc`, `request.id=42`, or `trace_id="two words"`; multiple terms
  are combined. Click a request/trace/correlation ID in the field view to filter by it. **Group
  errors** collapses identical error/warning records from the same container, keeps a representative
  stack trace and shows a repetition count. Save and Copy without a selection still export the
  original visible lines, including repetitions.
- **Stack traces open the code.** Paths in Python, Node, Go, Ruby and PHP traces that belong to
  the project are links: a click opens the file at that line in Orca's editor. Container paths
  map to the project through the service's bind mounts (`./app:/srv/app`), or, for code copied
  into the image, by the longest part of the path that exists in the project; library frames
  stay plain text. Web addresses in the log are links too.
- **Ask agent** starts the agent set in Settings (Claude by default) in the project's workspace
  with the latest visible error/warning and surrounding unfiltered lines from that container.
  The worker adds fresh container diagnostics, the Docker context and Compose settings, and asks
  the agent to find the cause. Context is bounded to 300 log lines / 24,000 characters; the prompt
  reports the included count and treats log content as evidence rather than instructions.
- **Clear** hides what was logged so far (it remembers the time and asks `docker logs --since`);
  Docker's log is not touched, so **Show all** brings it back.
- **Status bar.** `running/total` for the focused project, red when a container crashed, keeps
  restarting or turns unhealthy, with a desktop notification when that happens (Settings can turn
  notifications off). OOM kills and unexpected increases in restart count are included.

## Log history and limits

Logs are polled every two seconds while Follow is enabled and the panel is visible. Later polls
use a cursor per container, including Docker's nanoseconds; overlapping boundary lines are
deduplicated without removing genuine repeated lines. Docker operations share a four-process budget.

The tail view retains the newest 1000 lines across the selected containers. Time windows and
Since start initially read up to 5000 lines per container; subsequent polls use the same cap for
new data. The panel retains up to 10,000 lines / approximately 1.8 million characters for those
views. Replies stay below the IPC size budget. **Partial history** identifies omitted lines due
to tail, reply or panel-buffer limits, including when a filter is active; it is not a full-history
export. If one container disappears during rebuild, its error appears alongside the other logs.

## Settings

| Setting                       | Default  | What it does                                               |
| ----------------------------- | -------- | ---------------------------------------------------------- |
| Docker CLI path               | (empty)  | Where `docker` is, when it is not found on its own         |
| Default Compose files         | (empty)  | Files such as `devop/docker-compose.yml` used in every workspace that has them; a `.env` next to the first file is used |
| Agent for “Ask agent”         | `claude` | Agent Orca starts with the log, such as `codex`            |
| Notify when a container fails | on       | Desktop notifications from the status bar watcher          |

## Notes

- **Docker binary.** Orca opened from the Dock gives plugins a short `PATH`, so the worker also
  looks in `/usr/local/bin`, `/opt/homebrew/bin`, Docker Desktop, OrbStack and Rancher Desktop.
- **The `orca` CLI.** Orca's plugin API gives the focused workspace's name and branch, not its
  folder, opens terminals in the background and opens files without a line. The worker uses the
  `orca` CLI for those: `terminal list` to tell apart workspaces that share a name and branch,
  `terminal switch` to show the terminals it opens, and `file open --line` for stack traces.
- **Local workspaces.** Workspaces on SSH hosts are not listed. Docker uses the worker's effective
  context or `DOCKER_HOST`, which can point to a remote daemon. New terminals are pinned to that
  same target. Remote containers need bind-mount/source paths meaningful on the daemon host.
- **Safety.** The worker acts only in folders Orca lists as local workspaces, checks every
  service name, container id and time it receives, verifies container project labels and working
  directory before operations, never runs a shell for its own commands, and quotes what it types
  into terminals. Compose actions are refused if another workspace uses the same project name;
  assign a unique `name:` or `COMPOSE_PROJECT_NAME` to those stacks. Custom Compose paths must
  resolve to files inside the workspace, including through symlinks. Log text is rendered as text.

## Layout

| File                 | What it does                                                               |
| -------------------- | -------------------------------------------------------------------------- |
| `orca-plugin.json`   | Manifest: panel, worker, status bar item, settings, capabilities, images   |
| `src/worker.ts`      | Worker: panel requests, terminals, agent, status bar and notifications     |
| `src/docker.ts`      | Finds and runs docker; parses `compose config`, `inspect`, `stats`, logs   |
| `src/status.ts`      | Status bar summary and which container problems notify                     |
| `src/compose.ts`     | Compose command arguments and validation of workspace configuration        |
| `src/diagnostics.ts` | Container diagnostics shared by the panel and agent hand-off               |
| `src/async.ts`       | Shared Docker process concurrency budget                                   |
| `src/sources.ts`     | Which project file a stack trace path in a container is                    |
| `src/orca-cli.ts`    | The `orca` CLI calls: terminal lookup and switch, opening a file at a line |
| `src/workspaces.ts`  | Local workspaces with compose files; which one is focused                  |
| `src/protocol.ts`    | Request and answer types shared by the panel and the worker                |
| `panel/index.html`   | Panel markup and styles (Orca theme variables)                             |
| `panel/main.ts`      | Panel logic: project, containers, actions, logs                            |
| `panel/requests.ts`  | Request ownership and cancellation across navigation and Clear             |
| `panel/log-buffer.ts`| Incremental log history, overlap deduplication and retention                |
| `panel/log-model.ts` | Structured fields, filtering, grouping and incident context                |
| `panel/log-view.ts`  | DOM reconciliation that preserves existing log lines                       |
| `panel/ports.ts`     | Port addresses and recognized HTTP/HTTPS links                              |
| `panel/levels.ts`    | Error and warning detection, level words to colour                         |
| `panel/links.ts`     | Web addresses and stack trace locations in log lines                       |
| `panel/sparkline.ts` | `docker stats` numbers and chart points                                    |
| `panel/ansi.ts`      | ANSI colour codes to styled segments                                       |
| `panel/icons.ts`     | The panel's icons                                                          |

## Develop

Use Node 24.15+ (or Node 26+) for development; the plugin itself keeps no runtime npm dependencies.

```sh
npm ci
npm run check                     # source/manifest integrity, strict TypeScript and tests
orca plugin validate . --json     # official Orca manifest validation
orca plugin test . --json         # same tests, using Orca's actual worker host testing kit
orca plugin dev watch . --json    # load into Orca, stream logs and reloads
```

CI runs the portable checks on Linux and macOS. Worker tests use a fake Docker and Orca CLI;
DOM tests run the bundled panel in jsdom and exercise navigation races, Clear, selection,
incremental updates, diagnostics, settings and structured logs. No test changes real containers
or starts an agent in these portable/Orca suites. `npm test` maps `orca/testing` to `test/host.ts`, a small stand-in; the Orca
command uses its own kit and checks the actual host API contract as well.

For an opt-in live integration check, run `npm run test:docker`. It uses a cached standard Linux
shell image (or `DOCKER_LOGS_TEST_IMAGE`), creates a uniquely named temporary Compose stack and a
foreign-container fixture, and removes those fixtures in `finally`. It never pulls an image.
This checks nested `COMPOSE_FILE`, project ownership, profiles, logs, stats, Clear, cursors,
bind-mount source mapping and restart against a real daemon. It requires Docker socket access.

`tsconfig.json` is self-contained. `types/worker.ts` describes the worker API surface used here,
so type checking works even with Orca builds whose `plugin types` command cannot generate
`orca.d.ts`. It does not replace the official runtime/manifest checks above. Development loading
requires Orca's approval for the trusted worker.
