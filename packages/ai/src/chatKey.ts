/** Chat-key con la fórmula del core (scope participante por defecto). */
export function chatKeyOf(ctx: { from: string; sender: string; isGroup: boolean }): string {
  return ctx.isGroup ? `${ctx.from}:${ctx.sender}` : ctx.from
}
