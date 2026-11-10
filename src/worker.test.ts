// Runs the worker over a mock Orca host and a fake docker script that records its calls.
import { chmod, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

const APP = 'a'.repeat(64)
const WORKER = 'b'.repeat(64)
const ORIGINAL_PATH = process.env.PATH

const CONFIG = {
  name: 'proj',
  services: {
    app: { build: { context: '.' }, volumes: [{ type: 'bind', source: '__PROJECT__/src', target: '/srv/app' }] },
    worker: { image: 'busybox' },
    caddy: { image: 'caddy', profiles: ['web'] }
  }
}

const INSPECT = [
  {
    Id: APP,
    Name: '/proj-app-1',
    State: { Status: 'running', ExitCode: 0, StartedAt: '2026-01-01T00:00:00.5Z', FinishedAt: '0001-01-01T00:00:00Z' },
    Config: { Labels: { 'com.docker.compose.service': 'app', 'com.docker.compose.project': 'proj', 'com.docker.compose.project.working_dir': '__PROJECT__' } },
    NetworkSettings: { Ports: { '8000/tcp': [{ HostIp: '0.0.0.0', HostPort: '8000' }] } }
  },
  {
    Id: WORKER,
    Name: '/proj-worker-1',
    State: { Status: 'exited', ExitCode: 1, StartedAt: '2026-01-01T00:00:00Z', FinishedAt: '2026-01-01T00:00:09Z' },
    Config: { Labels: { 'com.docker.compose.service': 'worker', 'com.docker.compose.project': 'proj', 'com.docker.compose.project.working_dir': '__PROJECT__' } },
    NetworkSettings: { Ports: {} }
  }
]

const FAKE_DOCKER = `#!/bin/sh
here=$(dirname "$0")
echo "$(pwd)|$*" >> "$here/calls.log"
case "$*" in
  *"config --profiles") echo web ;;
  *"config --format json") cat "$here/config.json" ;;
  "ps -aq --no-trunc --filter label=com.docker.compose.project=proj") printf '${APP}\\n${WORKER}\\n' ;;
  "inspect ${APP} ${WORKER}") cat "$here/inspect.json" ;;
  "logs "*"${APP}")
    if [ -f "$here/app-log.txt" ]; then cat "$here/app-log.txt"; exit 0; fi
    printf '2026-01-01T00:00:01.000000000Z app one\\n2026-01-01T00:00:03.000000000Z app two\\n'
    printf '2026-01-01T00:00:02.000000000Z app err\\n' >&2 ;;
  "logs "*"${WORKER}")
    if [ -f "$here/fail-worker" ]; then echo "No such container" >&2; exit 1; fi
    printf '2026-01-01T00:00:02.500000000Z worker crash\\n' ;;
  "context show") echo default ;;
  "context inspect default --format {{json .Endpoints.docker.Host}}") echo '\"unix:///var/run/docker.sock\"' ;;
  stats*) printf '{"ID":"${APP}","CPUPerc":"1.50%%","MemUsage":"10MiB / 1GiB","MemPerc":"0.98%%"}\\n' ;;
  "start "*|"stop "*|"restart "*) echo "$2" ;;
  "compose --profile web restart"|"compose --profile web down") ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`

/** Stands in for the `orca` CLI the worker calls to switch to the terminals it opens. */
const FAKE_ORCA = `#!/bin/sh
echo "$*" >> "$(dirname "$0")/orca.log"
echo '{"ok":true,"result":{}}'
`

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'docker-logs-test-')))
  const project = join(root, 'project')
  const plain = join(root, 'plain')
  await Promise.all([mkdir(project), mkdir(plain)])
  const docker = join(root, 'docker')
  await Promise.all([
    writeFile(join(project, 'compose.yaml'), 'services: {}\n'),
    writeFile(join(root, 'config.json'), JSON.stringify(CONFIG).replace('__PROJECT__', project)),
    writeFile(join(root, 'inspect.json'), JSON.stringify(INSPECT).replaceAll('__PROJECT__', project)),
    writeFile(docker, FAKE_DOCKER)
  ])
  await chmod(docker, 0o755)
  await mkdir(join(project, 'src', 'core'), { recursive: true })
  await writeFile(join(project, 'src', 'core', 'media.py'), '')
  await mkdir(join(root, 'bin'))
  await writeFile(join(root, 'bin', 'orca'), FAKE_ORCA)
  await chmod(join(root, 'bin', 'orca'), 0o755)
  process.env.PATH = `${join(root, 'bin')}:${ORIGINAL_PATH}`
  process.env.ORCA_CLI_COMMAND = join(root, 'bin', 'orca')
  const host = mockHost({
    settings: { dockerPath: docker, agent: 'codex' },
    results: {
      'workspace.list': {
        workspaces: [
          { id: 'w1', kind: 'worktree', name: 'feature', path: project, branch: 'feature', hostId: 'local' },
          { id: 'w2', kind: 'worktree', name: 'main', path: plain, branch: 'main', hostId: 'local' },
          { id: 'w3', kind: 'worktree', name: 'remote', path: '/srv/x', branch: 'main', hostId: 'ssh:box' }
        ],
        truncated: false
      },
      'workspace.readContext': null,
      'terminal.create': { terminalId: 'term_1' },
      'agent.launch': { terminalId: 'term_2' },
      'statusBar.update': { ok: true },
      'notifications.show': { delivered: true }
    }
  })
  const worker = await mountWorker(main, { host })
  const calls = async () => (await readFile(join(root, 'calls.log'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
  const args = async () => (await calls()).map((c) => c.split('|')[1])
  const orcaCalls = async () => (await readFile(join(root, 'bin', 'orca.log'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
  return { worker, host, root, project, plain, docker, calls, args, orcaCalls }
}

test('lists compose workspaces and resolves the focused one', async () => {
  const { worker, project, plain } = await setup()
  const answer = await worker.request('workspaces.list', { context: { displayName: 'main', branch: 'main', terminals: [] } })
  assert.deepEqual(answer.workspaces.map((w: { path: string }) => w.path), [project, plain])
  assert.equal(answer.focused?.path, plain)
  await worker.deactivate()
})

test('lists every profile’s services with container state, ports and build flags', async () => {
  const { worker, project, calls } = await setup()
  const { project: name, rows } = await worker.request('services.list', { path: project })
  assert.equal(name, 'proj')
  type Row = { service: string; state: string; exitCode: number | null; ports: number[]; profiles: string[]; build: boolean }
  assert.deepEqual(
    rows.map((r: Row) => [r.service, r.state, r.exitCode, r.ports, r.profiles, r.build]),
    [
      ['app', 'running', 0, [8000], [], true],
      ['worker', 'exited', 1, [], [], false],
      ['caddy', 'not created', null, [], ['web'], false]
    ]
  )
  const log = await calls()
  assert.ok(log.includes(`${project}|compose config --profiles`))
  assert.ok(log.includes(`${project}|compose --profile web config --format json`))
  await worker.deactivate()
})

test('reads one container’s log, or several merged and tagged, after the cleared mark', async () => {
  const { worker, project, args } = await setup()
  const one = await worker.request('logs.get', { path: project, targets: [{ service: 'app', containerId: APP, name: 'proj-app-1' }] })
  assert.deepEqual(one.lines.map((l: { m: string; e: boolean; src?: string }) => [l.m, l.e, l.src]), [
    ['app one', false, undefined],
    ['app err', true, undefined],
    ['app two', false, undefined]
  ])
  assert.equal((await args()).at(-1), `logs --timestamps --tail 1001 ${APP}`)

  const both = await worker.request('logs.get', {
    path: project,
    targets: [
      { service: 'app', containerId: APP, name: 'proj-app-1', since: '2026-01-01T00:00:00Z' },
      { service: 'worker', containerId: WORKER, name: 'proj-worker-1' }
    ]
  })
  assert.deepEqual(both.lines.map((l: { m: string; src?: string }) => `${l.src}: ${l.m}`), [
    'proj-app-1: app one',
    'proj-app-1: app err',
    'proj-worker-1: worker crash',
    'proj-app-1: app two'
  ])
  const recent = await args()
  assert.ok(recent.includes(`logs --timestamps --tail 5001 --since 2026-01-01T00:00:00Z ${APP}`))
  assert.ok(recent.includes(`logs --timestamps --tail 501 ${WORKER}`))

  const { clearedAt } = await worker.request('logs.clear', { path: project, services: ['app', 'worker'] })
  await worker.request('logs.get', { path: project, targets: [{ service: 'worker', containerId: WORKER, name: 'proj-worker-1' }] })
  assert.equal((await args()).at(-1), `logs --timestamps --tail 1001 --since ${clearedAt} ${WORKER}`)
  assert.deepEqual(await worker.request('logs.clear', { path: project, services: ['worker'], reset: true }), { clearedAt: null })
  await worker.deactivate()
})

test('samples CPU and memory of the given containers only', async () => {
  const { worker, project, args } = await setup()
  assert.deepEqual(await worker.request('stats.get', { path: project, containerIds: [] }), { stats: {} })
  const { stats } = await worker.request('stats.get', { path: project, containerIds: [APP] })
  assert.deepEqual(stats, { [APP]: { cpu: '1.50%', mem: '10MiB', memLimit: '1GiB', memPercent: '0.98%' } })
  assert.equal((await args()).at(-1), `stats --no-stream --no-trunc --format {{json .}} ${APP}`)
  await worker.deactivate()
})

test('acts on containers in the background and opens terminals for long compose commands', async () => {
  const { worker, host, project, docker, args, orcaCalls } = await setup()
  assert.deepEqual(
    await worker.request('service.action', { path: project, service: 'app', containerId: APP, action: 'restart' }),
    { terminalId: null }
  )
  assert.equal((await args()).at(-1), `restart ${APP}`)

  await worker.request('service.action', { path: project, service: 'caddy', containerId: null, action: 'start' })
  await worker.request('service.action', { path: project, service: 'app', containerId: APP, action: 'build' })
  await worker.request('project.action', { path: project, action: 'up' })
  await worker.request('container.shell', { path: project, containerId: APP, name: 'proj-app-1' })
  type Params = { workspaceId: string; title: string; command: string }
  const terminals = host.callsOf('terminal.create') as Params[]
  assert.deepEqual(
    terminals.map((t: Params) => [t.workspaceId, t.title]),
    [
      ['w1', 'up caddy'],
      ['w1', 'build app'],
      ['w1', 'compose up'],
      ['w1', 'shell proj-app-1']
    ]
  )
  assert.deepEqual(
    terminals.map((t: Params) => t.command),
    [
      `cd ${project} && ${docker} --context default compose --profile web up -d caddy`,
      `cd ${project} && ${docker} --context default compose up -d --build app`,
      `cd ${project} && ${docker} --context default compose up -d`,
      `cd ${project} && ${docker} --context default exec -it ${APP} sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'`
    ]
  )

  // Orca opens them in the background; the worker brings each to the front.
  assert.deepEqual(await orcaCalls(), Array(4).fill('terminal switch --terminal term_1 --json'))

  assert.deepEqual(await worker.request('project.action', { path: project, action: 'down' }), { terminalId: null })
  assert.equal((await args()).at(-1), 'compose --profile web down')
  await worker.deactivate()
})

test('asks the configured agent about the log lines in a fence they cannot break', async () => {
  const { worker, host, project, orcaCalls } = await setup()
  const answer = await worker.request('agent.ask', {
    path: project,
    source: 'container "proj-worker-1"',
    lines: ['09:00:01 ok', '09:00:02 ERROR ```boom```']
  })
  assert.deepEqual(answer, { terminalId: 'term_2', agent: 'codex', linesSent: 2 })
  const [params] = host.callsOf('agent.launch') as { workspaceId: string; agent: string; prompt: string }[]
  assert.equal(params.workspaceId, 'w1')
  assert.equal(params.agent, 'codex')
  assert.match(params.prompt, /container "proj-worker-1"/)
  assert.ok(params.prompt.endsWith('````text\n09:00:01 ok\n09:00:02 ERROR ```boom```\n````'))
  assert.deepEqual(await orcaCalls(), ['terminal switch --terminal term_2 --json'])
  await assert.rejects(worker.request('agent.ask', { path: project, source: 'x', lines: [] }), { code: 'invalid_params' })
  await worker.deactivate()
})

test('shows the focused project in the status bar', async () => {
  const { worker, host } = await setup()
  await worker.emit('workspace.changed', { context: { displayName: 'feature', branch: 'feature', terminals: [] } })
  assert.deepEqual(host.callsOf('statusBar.update').at(-1), {
    id: 'containers',
    text: '1/2',
    tone: 'danger',
    tooltip: 'proj: 1 of 2 running\nproj-worker-1 exited with code 1',
    visible: true
  })
  assert.equal(host.callsOf('notifications.show').length, 0) // already broken when focused: no alert
  await worker.emit('workspace.changed', { context: { displayName: 'main', branch: 'main', terminals: [] } })
  assert.deepEqual(host.callsOf('statusBar.update').at(-1), { id: 'containers', visible: false })
  await worker.deactivate()
})

test('maps stack trace paths to project files and opens them at the line', async () => {
  const { worker, project, orcaCalls } = await setup()
  const { files } = await worker.request('code.resolve', {
    path: project,
    service: 'app',
    files: ['/srv/app/core/media.py', '/usr/local/lib/python3.12/site-packages/fastapi/routing.py']
  })
  assert.deepEqual(files, { '/srv/app/core/media.py': 'src/core/media.py', '/usr/local/lib/python3.12/site-packages/fastapi/routing.py': null })
  const answer = await worker.request('code.open', { path: project, service: 'app', file: '/srv/app/core/media.py', line: 42, column: 5 })
  assert.deepEqual(answer, { opened: 'src/core/media.py' })
  assert.deepEqual(await orcaCalls(), [`file open src/core/media.py --line 42 --column 5 --worktree path:${project} --focus --json`])
  await assert.rejects(worker.request('code.open', { path: project, service: 'app', file: '/etc/passwd', line: 1 }), { code: 'action_failed' })
  await assert.rejects(worker.request('code.open', { path: project, service: 'app', file: '/srv/app/../x', line: 1 }), { code: 'invalid_params' })
  await assert.rejects(worker.request('code.open', { path: project, service: 'app', file: '/srv/app/core/media.py', line: 0 }), { code: 'invalid_params' })
  await worker.deactivate()
})

test('refuses folders that are not local workspaces and malformed input', async () => {
  const { worker, project } = await setup()
  await assert.rejects(worker.request('services.list', { path: '/srv/x' }), { code: 'not_permitted' })
  await assert.rejects(worker.request('services.list', { path: '/etc' }), { code: 'not_permitted' })
  const target = { service: 'app', containerId: APP, name: 'proj-app-1' }
  await assert.rejects(worker.request('logs.get', { path: project, targets: [{ ...target, service: '--help' }] }), { code: 'invalid_params' })
  await assert.rejects(worker.request('logs.get', { path: project, targets: [{ ...target, since: '5m; rm' }] }), { code: 'invalid_params' })
  await assert.rejects(worker.request('logs.get', { path: project, targets: [] }), { code: 'invalid_params' })
  await assert.rejects(
    worker.request('service.action', { path: project, service: 'app', containerId: 'nope', action: 'stop' }),
    { code: 'invalid_params' }
  )
  await assert.rejects(
    worker.request('service.action', { path: project, service: 'app', containerId: APP, action: 'rm' as 'stop' }),
    { code: 'invalid_params' }
  )
  await assert.rejects(worker.request('project.action', { path: project, action: 'rm' as 'up' }), { code: 'invalid_params' })
  await assert.rejects(worker.request('container.shell', { path: project, containerId: APP, name: 'a b' }), { code: 'invalid_params' })
  await worker.deactivate()
})

test('refuses foreign IDs and service/ID mismatches for actions, shells, stats and logs', async () => {
  const { worker, host, project, args } = await setup()
  try {
    const foreign = 'f'.repeat(64)
    for (const action of ['start', 'stop', 'restart', 'build']) {
      await assert.rejects(worker.request('service.action', { path: project, service: 'app', containerId: foreign, action }), { code: 'not_permitted' })
    }
    await assert.rejects(worker.request('service.action', { path: project, service: 'worker', containerId: APP, action: 'stop' }), { code: 'not_permitted' })
    await assert.rejects(worker.request('container.shell', { path: project, containerId: foreign, name: 'foreign' }), { code: 'not_permitted' })
    await assert.rejects(worker.request('stats.get', { path: project, containerIds: [foreign] }), { code: 'not_permitted' })
    const result = await worker.request('logs.get', { path: project, targets: [{ service: 'app', containerId: foreign, name: 'foreign' }] })
    assert.equal(result.lines.length, 0)
    assert.equal(result.errors.length, 1)
    assert.equal(host.callsOf('terminal.create').length, 0)
    assert.equal((await args()).some((arg) => arg.includes(foreign)), false)
  } finally { await worker.deactivate() }
})

test('a reused Compose project name never permits actions in another workspace', async () => {
  const { worker, host, project, plain, root } = await setup()
  try {
    const inspect = JSON.stringify(INSPECT).replaceAll('__PROJECT__', plain)
    await writeFile(join(root, 'inspect.json'), inspect)
    const result = await worker.request('services.list', { path: project })
    assert.equal(result.rows.some((row: { containerId: string | null }) => row.containerId), false)
    for (const action of ['up', 'restart', 'down']) await assert.rejects(worker.request('project.action', { path: project, action }), { code: 'not_permitted' })
    assert.equal(host.callsOf('terminal.create').length, 0)
  } finally { await worker.deactivate() }
})

test('merged logs keep healthy sources and report a removed container separately', async () => {
  const { worker, project, root } = await setup()
  try {
    await writeFile(join(root, 'fail-worker'), '')
    const result = await worker.request('logs.get', { path: project, targets: [
      { service: 'app', containerId: APP, name: 'proj-app-1' },
      { service: 'worker', containerId: WORKER, name: 'proj-worker-1' }
    ] })
    assert.equal(result.lines.length, 3)
    assert.ok(result.lines.every((line: { containerId: string }) => line.containerId === APP))
    assert.match(result.errors[0].message, /No such container/)
  } finally { await worker.deactivate() }
})

test('reports tail truncation below the byte limit and uses nanosecond cursors for subsequent polls', async () => {
  const { worker, project, root, args } = await setup()
  try {
    await writeFile(join(root, 'app-log.txt'), Array.from({ length: 1001 }, (_, i) => `2026-01-01T00:00:01.000000001Z entry ${i}\n`).join(''))
    const target = { service: 'app', containerId: APP, name: 'proj-app-1' }
    const result = await worker.request('logs.get', { path: project, targets: [target] })
    assert.equal(result.lines.length, 1000)
    assert.equal(result.truncated, true)
    assert.deepEqual(result.limits, ['tail'])
    await worker.request('logs.get', { path: project, targets: [{ ...target, cursor: '2026-01-01T00:00:01.000000001Z' }] })
    assert.match((await args()).at(-1)!, /--tail 5001 --since 2026-01-01T00:00:01.000000001Z/)
  } finally { await worker.deactivate() }
})

test('persists Compose files/profiles per workspace and applies them to commands', async () => {
  const { worker, host, project, docker, args } = await setup()
  try {
    await mkdir(join(project, 'infra'))
    await writeFile(join(project, 'infra', 'stack.yml'), 'services: {}\n')
    const options = { files: ['infra/stack.yml'], profiles: ['web'] }
    assert.deepEqual(await worker.request('compose.set', { path: project, options }), { options })
    assert.deepEqual(await worker.request('compose.get', { path: project }), { options })
    await worker.request('project.action', { path: project, action: 'up' })
    const call = host.callsOf('terminal.create').at(-1) as { command: string }
    assert.equal(call.command, `cd ${project} && ${docker} --context default compose -f infra/stack.yml --profile web up -d`)
    await worker.request('services.list', { path: project, fresh: true })
    assert.ok((await args()).includes('compose -f infra/stack.yml --profile web config --format json'))
    await assert.rejects(worker.request('compose.set', { path: project, options: { files: ['../inspect.json'], profiles: [] } }), { code: 'invalid_params' })
    await symlink(join(project, '..', 'config.json'), join(project, 'outside.yaml'))
    await assert.rejects(worker.request('compose.set', { path: project, options: { files: ['outside.yaml'], profiles: [] } }), { code: 'invalid_params' })
    await assert.rejects(worker.request('compose.set', { path: project, options: { files: [], profiles: ['unknown'] } }), { code: 'invalid_params' })
    assert.deepEqual(await worker.request('compose.get', { path: project }), { options })
  } finally { await worker.deactivate() }
})

test('uses the default Compose files setting and the .env next to the first file', async () => {
  const { worker, host, project, plain, docker, args } = await setup()
  try {
    host.options.settings!.defaultComposeFiles = 'devop/docker-compose.yml, missing.yml'
    await mkdir(join(project, 'devop'))
    await writeFile(join(project, 'devop', 'docker-compose.yml'), 'services: {}\n')
    await writeFile(join(project, 'devop', '.env'), 'COMPOSE_PROJECT_NAME=proj\n')
    await writeFile(join(project, '.env'), 'APP_ENV=dev\n')
    assert.deepEqual(await worker.request('compose.get', { path: project }), { options: { files: ['devop/docker-compose.yml'], profiles: [] } })
    assert.deepEqual(await worker.request('compose.get', { path: plain }), { options: { files: [], profiles: [] } })
    await worker.request('services.list', { path: project, fresh: true })
    assert.ok((await args()).includes('compose --env-file devop/.env -f devop/docker-compose.yml --profile web config --format json'))
    await worker.request('project.action', { path: project, action: 'up' })
    const call = host.callsOf('terminal.create').at(-1) as { command: string }
    assert.equal(call.command, `cd ${project} && ${docker} --context default compose --env-file devop/.env -f devop/docker-compose.yml up -d`)
    // A workspace's own Compose settings win over the default.
    await mkdir(join(project, 'infra'))
    await writeFile(join(project, 'infra', 'stack.yml'), 'services: {}\n')
    const options = { files: ['infra/stack.yml'], profiles: [] }
    await worker.request('compose.set', { path: project, options })
    assert.deepEqual(await worker.request('compose.get', { path: project }), { options })
    await worker.request('services.list', { path: project, fresh: true })
    assert.ok((await args()).includes('compose --env-file .env -f infra/stack.yml --profile web config --format json'))
  } finally { await worker.deactivate() }
})

test('agent hand-off includes fresh OOM, health, restart and Docker context diagnostics', async () => {
  const { worker, host, project, root } = await setup()
  try {
    const entries = JSON.parse(JSON.stringify(INSPECT).replaceAll('__PROJECT__', project))
    entries[0].State = { Status: 'exited', ExitCode: 137, OOMKilled: true, Error: 'memory exhausted' }
    entries[0].RestartCount = 4
    await writeFile(join(root, 'inspect.json'), JSON.stringify(entries))
    await worker.request('agent.ask', { path: project, source: 'app', lines: ['ERROR failure'], containerIds: [APP] })
    const prompt = (host.callsOf('agent.launch')[0] as { prompt: string }).prompt
    assert.match(prompt, /OOM killed/)
    assert.match(prompt, /Exit code: 137/)
    assert.match(prompt, /Restarts: 4/)
    assert.match(prompt, /Docker context: default/)
    assert.match(prompt, /untrusted evidence/)
  } finally { await worker.deactivate() }
})

test('missing ownership labels fail closed and malformed log targets are rejected', async () => {
  const { worker, project, root } = await setup()
  try {
    await assert.rejects(worker.request('logs.get', { path: project, targets: [null] }), { code: 'invalid_params' })
    const entries = JSON.parse(JSON.stringify(INSPECT).replaceAll('__PROJECT__', project))
    delete entries[0].Config.Labels['com.docker.compose.service']
    await writeFile(join(root, 'inspect.json'), JSON.stringify(entries))
    await assert.rejects(worker.request('project.action', { path: project, action: 'down' }), { code: 'not_permitted' })
  } finally { await worker.deactivate() }
})

test('custom nested Compose files keep the workspace dotenv for config and terminal commands', async () => {
  const { worker, host, project, args } = await setup()
  try {
    await mkdir(join(project, 'infra'))
    await writeFile(join(project, 'infra', 'stack.yml'), 'services: {}\n')
    await writeFile(join(project, '.env'), 'COMPOSE_PROJECT_NAME=proj\n')
    await worker.request('compose.set', { path: project, options: { files: ['infra/stack.yml'], profiles: [] } })
    await worker.request('project.action', { path: project, action: 'up' })
    assert.ok((await args()).includes('compose --env-file .env -f infra/stack.yml --profile web config --format json'))
    assert.match((host.callsOf('terminal.create').at(-1) as { command: string }).command, /compose --env-file .env -f infra\/stack.yml up -d$/)
  } finally { await worker.deactivate() }
})
