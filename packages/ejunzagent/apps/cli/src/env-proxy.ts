/**
 * Node's global `fetch` (undici) ignores proxy env unless NODE_USE_ENV_PROXY is set.
 * Devshell and PM2 often have `http_proxy` in the OS profile but not in IDE terminals.
 * @module @ejunz/ea/env-proxy
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

function readProxyLine(path: string): string | undefined {
  if (!existsSync(path)) return undefined
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    return line
  }
  return undefined
}

function sidecarProxyPath(configPath: string | undefined): string | undefined {
  if (configPath === undefined || configPath === '') return undefined
  if (/\.ya?ml$/i.test(configPath)) return configPath.replace(/\.ya?ml$/i, '.proxy')
  return join(dirname(configPath), 'agent.proxy')
}

/** Apply HTTP(S)_PROXY and NODE_USE_ENV_PROXY before any outbound fetch in `ea node`. */
export function applyAgentEnvProxy(configPath?: string): void {
  const env = process.env
  let proxy = env.EJUNZ_AGENT_PROXY?.trim()
  if ((proxy === undefined || proxy === '') && configPath !== undefined && configPath !== '') {
    const sidecar = sidecarProxyPath(configPath)
    proxy = (sidecar === undefined ? undefined : readProxyLine(sidecar))
      ?? readProxyLine(join(dirname(configPath), 'agent.proxy'))
  }
  if (proxy !== undefined && proxy !== '') {
    env.HTTP_PROXY ??= proxy
    env.HTTPS_PROXY ??= proxy
    env.http_proxy ??= proxy
    env.https_proxy ??= proxy
  }
  if (env.HTTP_PROXY ?? env.HTTPS_PROXY ?? env.http_proxy ?? env.https_proxy) {
    env.NODE_USE_ENV_PROXY = '1'
  }
}
