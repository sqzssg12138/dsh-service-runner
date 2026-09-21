/**
 * dsh-service-runner — browser half.
 *
 * Contributes one entry to the session header's action row (the same slot the
 * official background-job list uses), which is the "top-right corner" of DSH.
 */
import type { ActionProps } from './ServiceRunnerAction.tsx'
import { ServiceRunnerAction } from './ServiceRunnerAction.tsx'
import { installStyles } from './styles.ts'

/** The slot owned by the conversation header action row. */
const SLOT = 'conversation.session.header.actions'

/** Services this client plugin needs from the shell. */
export const inject = ['slots']

/** Minimal shape of the client root context used here. */
interface ClientContext {
  slots: {
    inject(key: string, callback: () => (() => void) | void): void
    register(
      spec: { name: string; id: string; order?: number; locale?: string },
      component: (props: ActionProps) => unknown,
    ): () => void
  }
}

/**
 * Client plugin body.
 *
 * Registration is left to the slot service's own disposal semantics (the same
 * shape `@deepseek-ai/dsh-client-ui-jobs` uses), so a reload tears the entry
 * down without leaving a stale registration behind.
 */
export function apply(ctx: ClientContext): void {
  installStyles()
  ctx.slots.inject(SLOT, () =>
    ctx.slots.register(
      {
        name: SLOT,
        id: 'service-runner',
        // After the background-job list (order 20): services are the wider
        // surface, jobs the more transient one.
        order: 21,
      },
      ServiceRunnerAction,
    ),
  )
}
