import type { CompiledFlow, CompiledStep, FlowAction } from '../flows/FlowBuilder.js'
import { isCompiledFlow } from '../flows/FlowBuilder.js'
import type { ConversationFn, RuntimeMessage } from './ConversationRuntime.js'
import type { ConversationControls } from './controls.js'
import { ConversationEnded, ConversationGoto } from './errors.js'
import { assertControlsAlive, markStep, pauseControls, replayable } from './retry.js'
import { sendFlowMedia } from '../flows/media.js'
import { runFormStep } from '../forms/runForm.js'
import { traceFlowStep } from '../telemetry/context.js'

async function resolveText(t: CompiledStep & { kind: 'say' | 'ask' }, ctx: RuntimeMessage, c: ConversationControls): Promise<string> {
  return typeof t.text === 'function' ? await t.text(ctx, c) : t.text
}

/**
 * Per-step `{ delay }` / `.delay()`: pause, then make sure the conversation is still alive before
 * sending. Aborting the conversation (abort, abortAll, `bot.stop()`, `/reset`) cuts the pause short.
 */
async function pause(ms: number | undefined, c: ConversationControls): Promise<void> {
  if (ms === undefined || ms <= 0) return
  await pauseControls(c, ms)
}

/** Run `flow` from `startAt`; a `c.retry()` inside a step replays it from the retried step (see retry.ts). */
export async function runSteps(
  flow: CompiledFlow,
  ctx: RuntimeMessage,
  c: ConversationControls,
  startAt = 0,
  onStepDone?: (stepIndex: number) => Promise<void>,   // hook de checkpoint (Task 5)
): Promise<void> {
  await replayable(c, flow, startAt, (from) => runStepsFrom(flow, ctx, c, from, onStepDone))
}

async function runStepsFrom(
  flow: CompiledFlow,
  ctx: RuntimeMessage,
  c: ConversationControls,
  startAt = 0,
  onStepDone?: (stepIndex: number) => Promise<void>,
): Promise<void> {
  for (let i = startAt; i < flow.steps.length; i++) {
    const step = flow.steps[i]
    markStep(c, flow, i)
    traceFlowStep(flow.id, i, step.kind)   // tracing: a `flow.step` event on the turn (no-op when off)
    switch (step.kind) {
      case 'say':
        await pause(step.delayMs, c)
        await c.say(await resolveText(step, ctx, c))
        break
      case 'ask': {
        await pause(step.delayMs, c)
        const text = await resolveText(step, ctx, c)
        // With `opts.schema` the controls resolve the PARSED value (not the raw body).
        const answer: unknown = await c.ask(text, { timeout: flow.opts.timeoutMs, ...step.opts })
        c.state[step.stateKey] = answer
        break
      }
      case 'media':
        await pause(step.delayMs, c)
        assertControlsAlive(c)
        await sendFlowMedia(ctx, c, step)
        break
      case 'delay':
        await pause(step.ms, c)
        break
      case 'guard': {
        if (await step.check(ctx, c)) break
        const message = typeof step.message === 'function' ? await step.message(ctx, c) : step.message
        if (step.redirect === undefined) throw new ConversationEnded(message, true)
        if (message) await c.say(message)
        const redirect = new ConversationGoto(step.redirect)
        redirect.guarded = true
        throw redirect
      }
      case 'use':
        // Inline sub-flow sharing c.state; returns here when it finishes.
        await runSteps(step.flow, ctx, c, 0, undefined)
        break
      case 'do':
        await step.fn(ctx, c)
        break
      case 'choose': {
        await pause(step.delayMs, c)
        const labels = Object.fromEntries(Object.entries(step.options).map(([k, v]) => [k, v.label]))
        const picked = await c.choose(step.prompt, labels, { timeout: flow.opts.timeoutMs, ...step.opts })
        // Persist the selection so downstream steps can read it (default key: 'choice').
        c.state[step.stateKey ?? 'choice'] = picked
        markStep(c, flow, i)   // new phase: a c.retry() inside `then` re-prompts this menu
        const option = step.options[picked]
        const then = option?.then
        if (isCompiledFlow(then)) await runSteps(then, ctx, c, 0, undefined)   // sub-flow y RETORNA al padre
        else if (typeof then === 'function') await (then as FlowAction)(ctx, c)
        if (option?.goto !== undefined) throw new ConversationGoto(option.goto)
        break
      }
      case 'form':
        await runFormStep(step.form, ctx, c, step.opts, flow.opts.timeoutMs)
        break
      case 'goto':
        throw new ConversationGoto(step.target)
    }
    if (onStepDone) await onStepDone(i)
  }
}

export function flowToConversation(flow: CompiledFlow): ConversationFn {
  return async (c, ctx) => { await runSteps(flow, ctx, c as ConversationControls) }
}
