/**
 * Scheduled task runs as spans (`bot.task`). A run has no causing message, so its span is
 * a ROOT span (never the span that happened to be active when the task was registered);
 * sends and AI calls made by the handler nest under it. Task ids go through the `ids`
 * policy (hashed by default: durable ids often embed a chat or user id). Installed on the
 * scheduler only when `BotConfig.telemetry` is set.
 */
import type { TaskRunInfo, TaskTraceHooks } from '../scheduler/tracing.js'
import { SPAN_NAMES, TRACE_ATTR } from './attributes.js'
import type { TracingImpl } from './tracing.js'

export function createTaskTracing(t: TracingImpl): TaskTraceHooks {
  return {
    run<T>(info: TaskRunInfo, fn: () => T): T {
      return t.trace(SPAN_NAMES.task, {
        parent: null,
        kind: 'internal',
        attributes: {
          [TRACE_ATTR.taskId]: t.idAttribute(info.id),
          [TRACE_ATTR.taskKind]: info.kind,
          [TRACE_ATTR.taskDurable]: info.durable,
          [TRACE_ATTR.taskCron]: info.cron,
          [TRACE_ATTR.taskIntervalMs]: info.intervalMs,
          [TRACE_ATTR.taskTimeZone]: info.timeZone,
          [TRACE_ATTR.taskScheduledAt]: info.scheduledAt !== undefined ? new Date(info.scheduledAt).toISOString() : undefined,
          [TRACE_ATTR.taskMissed]: info.missed,
          [TRACE_ATTR.taskFencingToken]: info.fencingToken,
          [TRACE_ATTR.schedulerRole]: info.role,
          [TRACE_ATTR.schedulerOwner]: info.owner,
        },
      }, () => fn())
    },
  }
}
