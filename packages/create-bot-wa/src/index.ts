/**
 * create-bot-wa — programmatic API of the project scaffolder
 * (the CLI bin in `cli.js` wraps these).
 */

export { scaffold, sanitizeName } from './scaffold.js'
export type { ScaffoldOptions, ScaffoldResult } from './scaffold.js'
export { TEMPLATES, TEMPLATE_NAMES, getTemplate } from './templates.js'
export type { TemplateName, TemplateFile, ProjectTemplate } from './templates.js'
export { agentsMd } from './agentsMd.js'
export type { AgentsMdInfo } from './agentsMd.js'
