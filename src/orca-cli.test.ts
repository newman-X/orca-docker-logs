import assert from 'node:assert/strict'
import { test } from 'node:test'
import { candidates } from './orca-cli'

test('never runs a bare orca on Linux, where it is the GNOME screen reader', () => {
  assert.deepEqual(candidates({ ORCA_CLI_COMMAND: '/x/shim/orca', ORCA_USER_DATA_PATH: '/x' }, 'linux'), ['/x/shim/orca', '/x/linux-orca-cli-shim/orca'])
  assert.deepEqual(candidates({ ORCA_USER_DATA_PATH: '/data/orca' }, 'linux'), ['/data/orca/linux-orca-cli-shim/orca'])
  assert.deepEqual(candidates({ ORCA_CLI_COMMAND: 'orca', ORCA_USER_DATA_PATH: '/d' }, 'linux'), ['/d/linux-orca-cli-shim/orca'])
  assert.ok(!candidates({}, 'linux').includes('orca'))
  assert.equal(candidates({}, 'darwin').at(-1), 'orca')
})
