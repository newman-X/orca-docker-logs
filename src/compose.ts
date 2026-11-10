import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { fail } from './docker'
import type { ComposeOptions } from './protocol'

export const defaultOptions = (): ComposeOptions => ({ files: [], profiles: [] })

export function composeArgs(options: ComposeOptions, profiles = options.profiles, envFile?: string): string[] {
  return ['compose', ...(envFile ? ['--env-file', envFile] : []), ...options.files.flatMap((file) => ['-f', file]), ...[...new Set(profiles)].flatMap((p) => ['--profile', p])]
}

/** Older Compose versions switch dotenv discovery to the first -f directory. Pin it explicitly:
 * a `.env` next to the first custom file wins (a stack in a subfolder such as `devop/` keeps its
 * own variables and project name), else the workspace's `.env`. Build/bind paths still resolve
 * from the first Compose file. */
export async function composeEnvFile(path: string, options: ComposeOptions): Promise<string | undefined> {
  if (!options.files.length || process.env.COMPOSE_ENV_FILES || /^(true|1)$/i.test(process.env.COMPOSE_DISABLE_ENV_FILE ?? '')) return undefined
  const isFile = (file: string) => stat(join(path, file)).then((entry) => entry.isFile(), () => false)
  const dir = posix.dirname(options.files[0])
  if (dir !== '.' && await isFile(posix.join(dir, '.env'))) return posix.join(dir, '.env')
  return await isFile('.env') ? '.env' : undefined
}

/** The Compose files from the plugin-wide default setting (one per line or comma separated) that
 * exist inside this workspace; files a workspace does not have are skipped. */
export async function defaultFiles(path: string, setting: unknown): Promise<string[]> {
  if (typeof setting !== 'string') return []
  const wanted = setting.split(/[\n,]/).map((file) => file.trim()).filter(Boolean).slice(0, 10)
  const found: string[] = []
  for (const file of wanted) {
    const valid = await validateOptions(path, { files: [file], profiles: [] }).catch(() => null)
    if (valid) found.push(...valid.files)
  }
  return [...new Set(found)]
}

export async function validateOptions(path: string, value: ComposeOptions): Promise<ComposeOptions> {
  if (!value || !Array.isArray(value.files) || !Array.isArray(value.profiles) || value.files.length > 10 || value.profiles.length > 50) {
    throw fail('invalid_params', 'Invalid Compose settings')
  }
  const root = await realpath(path)
  const files: string[] = []
  for (const file of value.files) {
    if (typeof file !== 'string' || !file || file.length > 1024 || /[\x00-\x1f]/.test(file) || isAbsolute(file) || file.startsWith('-')) {
      throw fail('invalid_params', 'Compose files must be paths relative to the workspace')
    }
    const actual = await realpath(resolve(root, file)).catch(() => null)
    const rel = actual ? relative(root, actual) : '..'
    if (!actual || !rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !(await stat(actual)).isFile()) {
      throw fail('invalid_params', `Compose file is not a file inside this workspace: ${file}`)
    }
    files.push(rel.split(sep).join('/'))
  }
  const profiles = value.profiles.map((profile) => {
    if (typeof profile !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/.test(profile)) {
      throw fail('invalid_params', 'Invalid Compose profile')
    }
    return profile
  })
  return { files: [...new Set(files)], profiles: [...new Set(profiles)] }
}
