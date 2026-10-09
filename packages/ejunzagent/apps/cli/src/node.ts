/**
 * The `ea node` surface: this agent joins a server that runs elsewhere.
 *
 * The agent dials out, so a deployment can keep its agents wherever they belong
 * — another machine, another network, no inbound port. A first start has no
 * credential: it asks the server for a request, prints the URL for whoever
 * operates this machine, and keeps polling until somebody approves it in a
 * browser. From then on the credential in `agent.yaml` is what it presents,
 * and the same socket serves this agent's `/api` surface and its two downlink
 * streams to the server. Electron hosts use this same flow and receive typed
 * progress/status events over the parent-process IPC channel.
 * @module @ejunz/ea/node
 */

import { hostname } from 'node:os'
import { randomBytes } from 'node:crypto'
import WebSocket from 'ws'
import type {} from '@ejunz/host-apiproxy'
import { embedAgentRuntime, type EmbeddedAgentRuntime } from './embed.ts'
import { surfaceLogger } from './surface-log.ts'
import { applyAgentEnvProxy } from './env-proxy.ts'
import { AGENT_EXAMPLE_PATH, agentConfigPath, loadAgentConfig, writeAgentConfig } from './node-config.ts'

/**
 * The wire this surface speaks, mirroring the server's own frames. The server
 * owns the protocol; this file is one peer of it, so the shapes are restated
 * here rather than imported across the process boundary that separates them.
 */
interface ServerFrame {
  key?: string
  accepted?: boolean
  runtimeId?: string
  reason?: string
  code?: string
  url?: string
  expiresAt?: number
  staleToken?: boolean
  status?: string
  token?: string
  error?: string
  rpcId?: string
  path?: string
  body?: unknown
  stream?: 'mux' | 'host'
  frame?: { rpcId?: string; payload?: Record<string, unknown> }
  message?: string
}

/** How often an unbound agent asks whether an operator answered. */
const LINK_POLL_MS = 3000

/** How long one dispatched request may take inside this agent. */
const REQUEST_TIMEOUT_MS = 120_000

/** Options for {@link runNode}. */
export interface ConnectOptions {
  /** The server to join; overrides the file. */
  url?: string
  /** The label the operator sees when approving; defaults to this host's name. */
  label?: string
  /** The configuration file to read and write; defaults to `agent.yaml` in the working directory. */
  configPath?: string
}

/** Turn an HTTP(S) base URL into the WebSocket endpoint this surface dials. */
function socketUrl(base: string): string {
  const url = new URL('/api/ejunz-agent/runtime', base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

/**
 * One message from the server, or undefined when it is not a frame we know.
 *
 * The socket hands over text frames as bytes, and anything else already
 * decoded, so both shapes are read here; a frame without a key is not ours.
 * @param raw - the message as the socket delivered it.
 * @returns the frame, or undefined.
 */
/**
 * Whether a message is the server's own liveness probe.
 *
 * The WebSocket carrier probes a socket that has been quiet for half a minute
 * with the bare text `ping`, and terminates one that has not answered for
 * eighty seconds. That probe is not one of this protocol's frames, so it is
 * recognized before frame parsing; the reply is the bare text `pong` the
 * carrier expects.
 * @param raw - the message as the socket delivered it.
 * @returns whether it is the carrier's probe.
 */
function isCarrierPing(raw: unknown): boolean {
  return raw === 'ping' || (raw instanceof Uint8Array && new TextDecoder().decode(raw) === 'ping')
}

function parseServerFrame(raw: unknown): ServerFrame | undefined {
  let parsed: unknown = raw
  if (typeof raw === 'string' || raw instanceof Uint8Array) {
    try {
      parsed = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw))
    } catch {
      return undefined
    }
  }
  if (!parsed || typeof parsed !== 'object') return undefined
  const key = (parsed as { key?: unknown }).key
  return typeof key === 'string' ? parsed as ServerFrame : undefined
}

/**
 * Read the node surface's own flags.
 *
 * The launcher hands its inner arguments here verbatim, so this is where the
 * surface's flags are declared and refused: a typo must fail before a socket is
 * opened, not turn into a silent default.
 * @param args - the invocation's inner arguments.
 * @returns the resolved options.
 * @throws when an argument is one this surface does not know.
 */
export function parseNodeArgs(args: readonly string[]): ConnectOptions {
  const options: ConnectOptions = {}
  for (let index = 0; index < args.length; index += 1) {
    const argument = args.at(index)
    if (argument === undefined) break
    const [flag, inline] = argument.includes('=') ? argument.split('=', 2) as [string, string] : [argument, undefined]
    if (flag === '--url' || flag === '--label' || flag === '--config') {
      const value = inline ?? args[++index]
      if (value === undefined || value === '') throw new Error(`ea node: ${flag} needs a value`)
      if (flag === '--url') options.url = value
      else if (flag === '--label') options.label = value
      else options.configPath = value
      continue
    }
    throw new Error(`ea node: unknown argument ${JSON.stringify(argument)} (this surface takes --url, --label, and --config)`)
  }
  return options
}

/**
 * Where one server frame goes.
 *
 * The two handshake channels are addressed by key, because the server sends
 * their frames unsolicited; everything else answers a request this side minted
 * an id for.
 * @param frame - the frame that arrived.
 * @returns the pending listener's key.
 */
function routeKey(frame: ServerFrame): string {
  if (frame.key === 'link' || frame.key === 'pairing') return 'pairing'
  if (frame.key === 'hello') return 'hello'
  return frame.rpcId ?? ''
}

/**
 * The `ea node` entry point.
 *
 * It resolves the server from the flag or `agent.yaml`, gets a credential
 * (asking an operator for one on a first start), boots this agent against that
 * server's data bridge, and serves the server over the socket until the process
 * is asked to stop.
 * @param options - the invocation's flags.
 */
const CONNECT_RETRY_DELAY_MS = 5000

/** Flatten an error and its `cause` chain for logging and retry classification. */
function formatNodeError(error: unknown): string {
  const parts: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current)
    if (current.message !== '') parts.push(current.message)
    current = current.cause
  }
  if (parts.length === 0) return String(error)
  return parts.join(' | ')
}

function isRetryableNodeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const detail = formatNodeError(error)
  if ([
    'ea node: cannot reach ',
    'ea node: connection closed',
    'ea node: the server closed ',
    'ea node: the connection closed ',
    'ea node: pairing ended ',
    'ea node: the server refused this agent:',
    'ea node: runtime boot failed:',
  ].some(prefix => message.startsWith(prefix))) {
    return true
  }
  // Pairing polls can race server-side expiry; treat as transient during connect.
  if (detail.includes('link request not found')) return true
  // Boot/storage reachability failures during reconnect must not leave a zombie process.
  if (detail.includes('plugin tree failed to load')) return true
  if (detail.includes('fetch failed')) return true
  return /\b(ETIMEDOUT|ENETUNREACH|ECONNRESET|ECONNREFUSED|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT)\b/.test(detail)
}

/**
 * Whether a refused hello means the on-disk token is dead and should be erased.
 * Transient registration failures (runtime not ready yet, etc.) must keep the
 * credential so reconnect can succeed without forcing agent-link again.
 */
function refusalRevokesCredential(reason: string | undefined): boolean {
  if (reason === undefined || reason.trim() === '') return false
  const lower = reason.toLowerCase()
  if (lower.includes('did not identify itself')) return false
  const transient = ['try again', 'temporarily', 'timeout', 'too busy', 'busy']
  if (transient.some(fragment => lower.includes(fragment))) return false
  const credential = ['token', 'credential', 'revoked', 'invalid', 'binding', 'unauthorized', 'forbidden', 'expired', 'denied']
  return credential.some(fragment => lower.includes(fragment))
}

export async function runNode(options: ConnectOptions): Promise<void> {
  applyAgentEnvProxy(options.configPath)
  const logger = surfaceLogger('ea-node')
  if (process.env.NODE_USE_ENV_PROXY === '1') {
    logger.info('Outbound HTTPS uses proxy %s', process.env.HTTPS_PROXY ?? process.env.https_proxy ?? '(env)')
  }
  while (true) {
    try {
      await runNodeAttempt(options)
      return
    } catch (error) {
      const message = formatNodeError(error)
      if (!isRetryableNodeError(error)) {
        throw error
      }
      logger.error(message)
      logger.info('连接失败，%d 秒后重试…', CONNECT_RETRY_DELAY_MS / 1000)
      await new Promise(resolve => setTimeout(resolve, CONNECT_RETRY_DELAY_MS))
    }
  }
}

async function runNodeAttempt(options: ConnectOptions): Promise<void> {
  const file = loadAgentConfig(options.configPath)
  const logger = surfaceLogger('ea-node')
  logger.info('Loading agent config from %s', file.path)
  if (file.created) {
    // The file is generated, not demanded: an operator meets a template they
    // fill in rather than an error about a file they never heard of.
    logger.info('Created %s from %s', file.path, AGENT_EXAMPLE_PATH)
  }
  // A stated URL is the operator's answer to the generated file's question, so
  // it is kept: the next start needs no flags at all.
  const statedUrl = (options.url ?? '').trim().replace(/\/$/, '')
  if (statedUrl !== '') {
    writeAgentConfig(options.configPath, { url: statedUrl, ...(options.label === undefined ? {} : { label: options.label }) })
  }
  const configured = statedUrl === '' ? file.config : loadAgentConfig(options.configPath).config
  const url = statedUrl === '' ? configured.url : statedUrl
  if (url === '') {
    throw new Error([
      `ea node: ${file.path} has no \`ejunz.url\` yet.`,
      'Fill in the address of your Ejunz server there and run again:',
      '    ejunz:',
      '        url: http://192.168.88.198:2333',
      'Or state it once here, which writes it into that file:',
      '    yarn agent --url http://192.168.88.198:2333',
    ].join('\n'))
  }
  const label = options.label ?? configured.label ?? hostname()

  const socket = new WebSocket(socketUrl(url))
  const pending = new Map<string, (frame: ServerFrame) => void>()
  const streams = new Map<'mux' | 'host', AbortController>()
  let agent: EmbeddedAgentRuntime | undefined
  /** Set when the server sent a `restart` frame; after cleanup we exit 0. */
  let restartRequested = false
  /** Bound once the serve-until-stop promise is armed. */
  let requestStop: () => void = () => {
    restartRequested = true
  }
  let resourcesReleased = false
  const releaseResources = async (): Promise<void> => {
    if (resourcesReleased) return
    resourcesReleased = true
    for (const controller of streams.values()) controller.abort()
    streams.clear()
    pending.clear()
    if (agent !== undefined) {
      try {
        await agent.ctx.fiber.dispose()
      } catch { /* disposal races with a half-built tree */ }
      agent = undefined
    }
    try {
      socket.removeAllListeners()
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
        socket.terminate()
      }
    } catch { /* the socket is already gone */ }
  }

  try {
    const send = (frame: Record<string, unknown>): boolean => {
      if (socket.readyState !== WebSocket.OPEN) return false
      socket.send(JSON.stringify(frame))
      return true
    }

    const reply = (rpcId: string, status: number, contentType: string, text: string): void => {
      send({ key: 'response', rpcId, status, contentType, text })
    }

    /** Answer one `/api` request with this agent's own composed handler. */
    const handleRequest = async (frame: ServerFrame): Promise<void> => {
      const rpcId = String(frame.rpcId || '')
      if (agent === undefined) {
        reply(rpcId, 503, 'application/json', JSON.stringify({ error: { message: 'this agent is not serving yet' } }))
        return
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        const response = await agent.api.fetch(new Request(`http://agent${String(frame.path || '')}`, {
          method: 'POST',
          headers: { host: '127.0.0.1', 'content-type': 'application/json' },
          body: JSON.stringify(frame.body ?? {}),
          signal: controller.signal,
        }))
        reply(rpcId, response.status, response.headers.get('content-type') || 'application/json', await response.text())
      } catch (error) {
        reply(rpcId, 500, 'application/json', JSON.stringify({ error: { message: String(error) } }))
      } finally {
        clearTimeout(timer)
      }
    }

    /** Pump one downlink stream into the server until it unsubscribes. */
    const handleSubscribe = (stream: 'mux' | 'host'): void => {
      if (agent === undefined || streams.has(stream)) return
      const controller = new AbortController()
      streams.set(stream, controller)
      const source = stream === 'mux' ? agent.events.mux(controller.signal) : agent.events.host(controller.signal)
      void (async () => {
        try {
          for await (const frame of source) send({ key: 'event', stream, frame })
        } catch (error) {
          if (!controller.signal.aborted) send({ key: 'stream-error', stream, message: String(error) })
        } finally {
          streams.delete(stream)
        }
      })()
    }

    /**
   * The credential to serve with, asking an operator for one on a first start.
   * @returns the credential an approval issued.
   */
    const obtainCredential = async (): Promise<string> => {
      if (configured.token !== undefined) {
      // Presented as-is: an unknown token is what a revoked binding looks like,
      // and the server answers that with a fresh request instead of a refusal.
        return configured.token
      }
      const pairSecret = randomBytes(24).toString('hex')
      let code = ''
      logger.info('%s 上还没有这台机器的绑定，正在申请…', url)
      return await new Promise<string>((resolve, reject) => {
        let settled = false
        const poll = setInterval(() => {
          if (code !== '') send({ key: 'link-poll', code, pairSecret })
        }, LINK_POLL_MS)
        const finish = (token?: string, error?: string): void => {
          if (settled) return
          settled = true
          clearInterval(poll)
          if (token !== undefined) resolve(token)
          else reject(new Error(error ?? 'ea node: pairing ended without a credential'))
        }
        pending.set('pairing', (frame) => {
          if (frame.key === 'pairing' && typeof frame.code === 'string' && typeof frame.url === 'string') {
            code = frame.code
            logger.info('打开下面的链接完成授权（登录后点「授权」即可）：\n  %s\n  授权后本进程会自动继续，无需重启。绑定码 %s%s',
              frame.url, frame.code, frame.staleToken === true ? '\n  （之前的绑定已失效，需要重新授权）' : '')
            send({ key: 'link-poll', code, pairSecret })
            return
          }
          if (frame.key === 'link' && frame.status === 'approved' && typeof frame.token === 'string') {
            writeAgentConfig(options.configPath, { url, label, token: frame.token })
            logger.info('已授权，凭据已写入 %s', agentConfigPath(options.configPath))
            finish(frame.token)
            return
          }
          if (frame.key === 'link' && typeof frame.error === 'string') finish(undefined, frame.error)
        })
        socket.once('close', () => finish(undefined, 'ea node: the server closed the connection before it was approved'))
        send({ key: 'hello', label, host: hostname(), pid: process.pid, startedAt: Date.now() - Math.round(process.uptime() * 1000), pairSecret })
      })
    }

    socket.on('message', (raw: unknown) => {
      if (isCarrierPing(raw)) {
      // A host that serves nothing for a minute must stay bound and reachable:
      // an unanswered probe is what makes the server drop its socket.
        socket.send('pong')
        return
      }
      const frame = parseServerFrame(raw)
      if (frame === undefined) return
      if (frame.key === 'ping') {
        send({ key: 'pong' })
        return
      }
      if (frame.key === 'restart') {
      // The server asked this process to exit so PM2 (or another manager) can
      // bring it back with freshly loaded code. Exit 0 after the same cleanup
      // SIGTERM would use.
        const note = typeof frame.reason === 'string' && frame.reason !== '' ? frame.reason : 'server requested restart'
        logger.info('收到重启请求：%s', note)
        restartRequested = true
        requestStop()
        return
      }
      if (frame.key === 'request') {
        void handleRequest(frame)
        return
      }
      if (frame.key === 'subscribe') handleSubscribe(frame.stream === 'host' ? 'host' : 'mux')
      if (frame.key === 'unsubscribe') {
        const stream = frame.stream === 'host' ? 'host' : 'mux'
        streams.get(stream)?.abort()
        streams.delete(stream)
      }
      pending.get(routeKey(frame))?.(frame)
    })

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve())
        socket.once('error', (error: Error) => reject(new Error(`ea node: cannot reach ${url}: ${error.message}`)))
      })
    } catch (error) {
      throw error
    }

    const token = await obtainCredential()
    // The bridge is how this agent's sessions, storage, and tools reach the
    // server; the same credential authorizes both it and this socket.
    try {
      agent = await embedAgentRuntime({ bridge: { origin: url, token } })
    } catch (error) {
      throw new Error(`ea node: runtime boot failed: ${formatNodeError(error)}`, { cause: error })
    }
    logger.info('运行时已就绪，正在向服务器注册…')

    try {
      await new Promise<void>((resolve, reject) => {
        pending.set('hello', (frame) => {
          if (frame.key !== 'hello') return
          if (frame.accepted === true) {
          // The name comes from the server's own record of the binding, so the
          // file states the identity every report and every row carries.
            const bound = String(frame.runtimeId)
            if (configured.id !== undefined && configured.id !== bound) {
              logger.info('注意：%s 里记的绑定码是 %s，服务器现在把本机认作 %s。', file.path, configured.id, bound)
            }
            writeAgentConfig(options.configPath, { url, label, token, id: bound })
            logger.info('已绑定并开始服务：绑定码 %s（凭据已写入 %s）', bound, file.path)
            resolve()
            return
          }
          const reason = frame.reason ?? 'unknown reason'
          if (refusalRevokesCredential(frame.reason)) {
            writeAgentConfig(options.configPath, { token: undefined, id: undefined })
            logger.warn('服务器拒绝注册，已清除本地凭据：%s', reason)
          } else {
            logger.warn('服务器拒绝注册（凭据保留，将重试）：%s', reason)
          }
          reject(new Error(`ea node: the server refused this agent: ${reason}`))
        })
        if (!send({ key: 'hello', label, host: hostname(), pid: process.pid, startedAt: Date.now() - Math.round(process.uptime() * 1000), token })) {
          reject(new Error('ea node: the connection closed before this agent could register'))
        }
      })
    } catch (error) {
      throw error
    }

    // Process lifetime belongs to whoever started this agent: the socket stays
    // open and the agent serves until the process is asked to stop.
    try {
      await new Promise<void>((resolve, reject) => {
        const stop = (): void => {
          logger.info('正在停止…')
          resolve()
        }
        requestStop = stop
        process.once('SIGINT', stop)
        process.once('SIGTERM', stop)
        socket.once('close', () => {
          if (restartRequested) stop()
          else reject(new Error('ea node: connection closed'))
        })
        if (restartRequested) stop()
      })
    } finally {
      await releaseResources()
    }
    if (restartRequested) {
    // Exit 0 so PM2 (or similar) treats this as a clean restart, not a crash.
      process.exit(0)
    }
  } catch (error) {
    await releaseResources()
    throw error
  }
}
