import type { JsonValue } from '@ejunz/tools'
import type { HostCatalog, HostToolSpec } from './types.ts'

/**
 * Reject a malformed catalog payload.
 * @param detail - what is wrong with the payload.
 * @returns never; the throw is the result.
 */
function invalid(detail: string): never {
  throw new Error(`host tool catalog is invalid: ${detail}`)
}

/**
 * Require one payload value to be a plain object.
 * @param value - value read from the payload.
 * @param field - field name used in the diagnostic.
 * @returns the same value, typed as a record.
 */
function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${field} must be an object`)
  return value as Record<string, unknown>
}

/**
 * Read the tool catalog a host bridge returned.
 *
 * The catalog crosses a process boundary, so every field the registry consumes is
 * validated here: a truncated or renamed payload fails the load instead of registering a
 * tool that cannot execute.
 * @param value - decoded `tools/catalog` payload.
 * @returns the declared tools and the guidance that came with them.
 * @throws when the payload is not a catalog, or an entry omits a field.
 */
export function parseHostCatalog(value: JsonValue | undefined): HostCatalog {
  const payload = record(value, 'catalog')
  const tools = payload.tools
  if (!Array.isArray(tools)) invalid('tools must be an array')
  const guidance = payload.guidance
  if (guidance !== undefined && typeof guidance !== 'string') invalid('guidance must be a string')

  const parsed: HostToolSpec[] = tools.map((entry, index) => {
    const spec = record(entry, `tools[${index}]`)
    const { name, description } = spec
    if (typeof name !== 'string' || name.length === 0) invalid(`tools[${index}].name must be a non-empty string`)
    if (typeof description !== 'string') invalid(`tools[${index}].description must be a string`)
    return {
      name,
      description,
      inputSchema: record(spec.inputSchema, `tools[${index}].inputSchema`),
    }
  })

  return { tools: parsed, ...(guidance === undefined ? {} : { guidance }) }
}
