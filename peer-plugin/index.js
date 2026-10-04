/**
 * dsh-peer-bridge -- bootstrap layer (stable; try not to edit this file).
 *
 * Why two files:
 *   The host caches ES modules, so editing THIS file requires restarting the whole
 *   app before it takes effect. Therefore this file only does three things:
 *   declare dependencies, bust the CommonJS cache, and hand off to impl.cjs.
 *   From now on, edit impl.cjs only, then re-mount the plugin -- no app restart.
 *
 * Re-mount helper: %WORKSPACE_A%\tools\reload-plugin.ps1
 */

import { createRequire } from 'node:module'

export const name = 'dsh-peer-bridge'

// Must be declared: in cordis, reading ctx.<service> without declaring it in
// "inject" throws "cannot get property ... without inject".
export const inject = ['sessions', 'sessionQuery']

const require = createRequire(import.meta.url)

export function apply(ctx) {
  const implPath = require.resolve('./impl.cjs')
  delete require.cache[implPath]
  const impl = require(implPath)
  return impl.apply(ctx)
}