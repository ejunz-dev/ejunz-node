/**
 * Typed failures shared by subagent service and provider operations.
 *
 * @module @ejunz/subagent
 */

import { EjunzAgentError } from '@ejunz/llm'

/** Typed failure for the subagent seam. */
export class SubagentError extends EjunzAgentError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'SubagentError'
  }
}
