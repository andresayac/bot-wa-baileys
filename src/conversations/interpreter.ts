import type { CompiledFlow, CompiledStep, FlowAction } from '../flows/FlowBuilder.js'
import { isCompiledFlow } from '../flows/FlowBuilder.js'
import type { ConversationFn, RuntimeMessage } from './ConversationRuntime.js'
import type { ConversationControls } from './controls.js'
import { ConversationGoto } from './errors.js'

async function resolveText(t: CompiledStep & { kind: 'say' | 'ask' }, ctx: RuntimeMessage, c: ConversationControls): Promise<string> {
  return typeof t.text === 'function' ? await t.text(ctx, c) : t.text
}

export async function runSteps(
  flow: CompiledFlow,
  ctx: RuntimeMessage,
  c: ConversationControls,
  startAt = 0,
  onStepDone?: (stepIndex: number) => Promise<void>,   // hook de checkpoint (Task 5)
): Promise<void> {
  for (let i = startAt; i < flow.steps.length; i++) {
    const step = flow.steps[i]
    switch (step.kind) {
      case 'say':
        await c.say(await resolveText(step, ctx, c))
        break
      case 'ask': {
        const text = await resolveText(step, ctx, c)
        const answer = await c.ask(text, { timeout: flow.opts.timeoutMs, ...step.opts })
        c.state[step.stateKey] = answer
        break
      }
      case 'do':
        await step.fn(ctx, c)
        break
      case 'choose': {
        const labels = Object.fromEntries(Object.entries(step.options).map(([k, v]) => [k, v.label]))
        const picked = await c.choose(step.prompt, labels, { timeout: flow.opts.timeoutMs, ...step.opts })
        const then = step.options[picked]?.then
        if (isCompiledFlow(then)) await runSteps(then, ctx, c, 0, undefined)   // sub-flow y RETORNA al padre
        else if (typeof then === 'function') await (then as FlowAction)(ctx, c)
        break
      }
      case 'goto':
        throw new ConversationGoto(step.target)
    }
    if (onStepDone) await onStepDone(i)
  }
}

export function flowToConversation(flow: CompiledFlow): ConversationFn {
  return async (c, ctx) => { await runSteps(flow, ctx, c as ConversationControls) }
}
