# Changelog

## 0.4.2 (newman-X fork)

- Linux: call Orca's CLI shim (`ORCA_CLI_COMMAND` or `~/.config/orca/linux-orca-cli-shim/orca`) instead of a bare `orca`, which is the GNOME screen reader there.

## 0.4.1 (newman-X fork)

- Add the "Default Compose files" setting: workspace-relative files (such as `devop/docker-compose.yml`) used in every workspace that has them and no own Compose settings, so new worktrees work without setup.
- With custom Compose files, use the `.env` next to the first file (such as `devop/.env`) when it exists, so a stack in a subfolder keeps its own variables and project name; else the workspace's `.env` as before.

## 0.4.0

- Ignore stale project, service and log responses, including polls completing after Clear.
- Verify container ownership and reject ambiguous Compose actions across workspaces sharing a project name.
- Diagnose OOM kills, runtime errors and restart-count changes; add a container diagnostics view.
- Preserve healthy logs when another source fails; show per-source failures and history limits.
- Discover dotenv `COMPOSE_FILE` and allow workspace-specific Compose files and profiles.
- Fetch logs incrementally with nanosecond cursors, bound Docker process concurrency, and reuse unchanged log DOM nodes.
- Add JSON field inspection, correlation-ID filters and repeated error/traceback grouping.
- Include surrounding incident context, fresh diagnostics and Docker target information in Ask agent.
- Display Docker context, copy port addresses and recognize HTTP/HTTPS ports.
- Copy selected log text and resize the services list with pointer or keyboard.
- Add portable strict type checking, DOM/worker regression tests and Linux/macOS CI.
