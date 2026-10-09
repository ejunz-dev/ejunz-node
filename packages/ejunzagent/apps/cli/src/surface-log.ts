/**
 * The logger a launcher surface speaks through before its tree is mounted.
 *
 * A surface has to say things — where it read its configuration, which URL to
 * open — before the application it is about to boot exists, so it owns a logger
 * of its own: the same cordis logger and console exporter every mounted plugin
 * logs through, which is why these lines read like the rest of the agent's.
 * @module @ejunz/ea/surface-log
 */

import { Context } from '@ejunz/cordis'
import ConsoleExporter from '@ejunz/cordis-plugin-logger-console'

/** One logger per surface name, so repeated calls in a process share it. */
const surfaces = new Map<string, ReturnType<Context['logger']>>()

/**
 * The named logger a surface logs through.
 * @param name - the surface's name, as it appears in its log lines.
 * @returns the logger.
 */
export function surfaceLogger(name: string): ReturnType<Context['logger']> {
  const existing = surfaces.get(name)
  if (existing !== undefined) return existing
  const context = new Context()
  new ConsoleExporter(context)
  const logger = context.logger(name)
  surfaces.set(name, logger)
  return logger
}
