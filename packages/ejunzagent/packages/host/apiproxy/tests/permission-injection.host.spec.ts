import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const execFile = promisify(execFileCallback)
const testDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(testDir, '../../../..')

it('persists permission injection through a Loader-composed host API', async () => {
  const { stdout } = await execFile(process.execPath, [
    '--import', 'tsx/esm',
    resolve(testDir, 'permission-injection.real.ts'),
  ], {
    cwd: packageRoot,
    env: { ...process.env, TSX_TSCONFIG_PATH: resolve(packageRoot, 'tsconfig.base.json') },
  })
  expect(stdout).toContain('permission injection persisted through the composed host API')
})
