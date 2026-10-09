/**
 * The file a connecting agent reads and writes.
 *
 * One file, generated from the shipped example the first time an agent starts
 * and kept up to date by the agent itself: the operator fills in the server's
 * URL, and the credential an approval issues is written back beside it. The
 * example is where the comments live, because the agent rewrites the file it
 * owns — the same division the node panel uses for its own configuration.
 * @module @ejunz/ea/node-config
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dump, load } from 'js-yaml'

/** The file the operator and the agent share. */
export const AGENT_CONFIG_NAME = 'agent.yaml'

/** The shipped template that file is generated from. */
export const AGENT_EXAMPLE_PATH = fileURLToPath(new URL('../config/agent.example.yaml', import.meta.url))

/** What the file states about this agent's server. */
export interface AgentConfig {
  /** The server this agent belongs to, e.g. `http://192.168.88.198:2333`. */
  url: string
  /** Label the operator sees when approving, defaulting to the host name. */
  label?: string
  /** The credential an approval issued; absent until one did. */
  token?: string
  /**
   * The code this host was bound under: the server's name for it, and the
   * identity every report and every row carries.
   */
  id?: string
}

/** One read of the file: its path, what it states, and whether this start created it. */
export interface AgentConfigFile {
  /** Absolute path of the file. */
  path: string
  /** What the file states. */
  config: AgentConfig
  /** Whether this call generated it from the example. */
  created: boolean
}

/**
 * Where the file lives: beside the launcher that started this agent, unless one
 * was named. A deployment that runs several agents gives each its own directory,
 * which is also what keeps their credentials apart.
 * @param configPath - an explicit path, relative to the working directory.
 * @returns the absolute path of the file.
 */
export function agentConfigPath(configPath?: string): string {
  return configPath === undefined ? resolve(AGENT_CONFIG_NAME) : resolve(configPath)
}

/** Read the file as a mapping, or an empty one when it does not exist. */
function readDocument(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {}
  let parsed: unknown
  try {
    parsed = load(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`ea node: ${file} is not valid YAML: ${String(error)}`)
  }
  if (parsed === null || parsed === undefined) return {}
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`ea node: ${file} must contain a mapping`)
  }
  return parsed as Record<string, unknown>
}

function ejunzBlock(document: Record<string, unknown>): Record<string, unknown> {
  const block = document.ejunz
  return typeof block === 'object' && block !== null && !Array.isArray(block)
    ? block as Record<string, unknown>
    : {}
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Write the file's `ejunz` block back, keeping every other key it carries.
 *
 * The agent owns this file after generating it, so it rewrites the whole
 * document; anything the operator added elsewhere in the mapping survives, and
 * the comments they might want belong in the shipped example instead.
 * @param configPath - the file to write, relative to the working directory.
 * @param patch - values to merge into the block; an undefined value removes the key.
 * @returns the file written.
 */
export function writeAgentConfig(configPath: string | undefined, patch: Record<string, string | undefined>): string {
  const file = agentConfigPath(configPath)
  const document = readDocument(file)
  const block = { ...ejunzBlock(document) }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      switch (key) {
        case 'url':
          delete block.url
          break
        case 'label':
          delete block.label
          break
        case 'token':
          delete block.token
          break
        case 'id':
          delete block.id
          break
        default:
          break
      }
      continue
    }
    switch (key) {
      case 'url':
        block.url = value
        break
      case 'label':
        block.label = value
        break
      case 'token':
        block.token = value
        break
      case 'id':
        block.id = value
        break
      default:
        break
    }
  }
  mkdirSync(dirname(file), { recursive: true })
  // The dump drops whatever comments the file carried, so the file states what
  // it is: the rewrite is the agent's, and the annotated template is the
  // shipped example.
  const header = '# Managed by `ea node` (url / label / token / id).\n'
    + '# The annotated template for this file is agent.example.yaml beside the ea app.\n'
  writeFileSync(file, header + dump({ ...document, ejunz: block }, { lineWidth: 120 }), { mode: 0o600 })
  return file
}

/**
 * Read this agent's file, generating it from the shipped example when it is absent.
 * @param configPath - the file to read, relative to the working directory.
 * @returns the path, what the file states, and whether this call created it.
 */
export function loadAgentConfig(configPath?: string): AgentConfigFile {
  const file = agentConfigPath(configPath)
  let created = false
  if (!existsSync(file) && existsSync(AGENT_EXAMPLE_PATH)) {
    mkdirSync(dirname(file), { recursive: true })
    copyFileSync(AGENT_EXAMPLE_PATH, file)
    created = true
  }
  const block = ejunzBlock(readDocument(file))
  const url = optionalText(block.url)
  const label = optionalText(block.label)
  const token = optionalText(block.token)
  const id = optionalText(block.id)
  return {
    path: file,
    created,
    config: {
      url: (url ?? '').replace(/\/$/, ''),
      ...(label === undefined ? {} : { label }),
      ...(token === undefined ? {} : { token }),
      ...(id === undefined ? {} : { id }),
    },
  }
}
