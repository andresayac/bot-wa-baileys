import type { StoredMessage } from '@bot-wa/core'
export type ConversationStatus = 'open' | 'pending' | 'resolved'
export interface InboxConversation { tenantId:string; id:string; status:ConversationStatus; assigneeId?:string; handoff:boolean; unread:number; slaDueAt?:number; version:number; updatedAt:number }
export interface InboxNote { id:string; tenantId:string; conversationId:string; authorId:string; body:string; createdAt:number }
export class InboxConflictError extends Error { constructor() { super('inbox conversation version conflict'); this.name='InboxConflictError' } }
export class MemoryInbox {
  private readonly conversations=new Map<string,InboxConversation>(); private readonly notes=new Map<string,InboxNote[]>();
  upsert(input:Omit<InboxConversation,'version'|'updatedAt'|'unread'> & { unread?:number }):InboxConversation { const key=k(input.tenantId,input.id); const old=this.conversations.get(key); const value={...old,...input,unread:input.unread??old?.unread??0,version:(old?.version??0)+1,updatedAt:Date.now()}; this.conversations.set(key,value); return {...value} }
  get(tenantId:string,id:string):InboxConversation|undefined { const value=this.conversations.get(k(tenantId,id)); return value&&{...value} }
  list(tenantId:string, filter:Partial<Pick<InboxConversation,'status'|'assigneeId'>>={}):InboxConversation[] { return [...this.conversations.values()].filter(x=>x.tenantId===tenantId&&(!filter.status||x.status===filter.status)&&(!filter.assigneeId||x.assigneeId===filter.assigneeId)).map(x=>({...x})) }
  assign(tenantId:string,id:string,assigneeId:string|undefined,expectedVersion:number):InboxConversation { return this.mutate(tenantId,id,expectedVersion,x=>({...x,assigneeId})) }
  handoff(tenantId:string,id:string,enabled:boolean,expectedVersion:number):InboxConversation { return this.mutate(tenantId,id,expectedVersion,x=>({...x,handoff:enabled})) }
  markRead(tenantId:string,id:string,expectedVersion:number):InboxConversation { return this.mutate(tenantId,id,expectedVersion,x=>({...x,unread:0})) }
  addNote(tenantId:string,conversationId:string,authorId:string,body:string):InboxNote { if(!this.conversations.has(k(tenantId,conversationId))) throw new Error('conversation not found'); if(!body.trim()) throw new Error('note body is required'); const note={id:crypto.randomUUID(),tenantId,conversationId,authorId,body,createdAt:Date.now()}; const key=k(tenantId,conversationId); this.notes.set(key,[...(this.notes.get(key)??[]),note]); return {...note} }
  listNotes(tenantId:string,conversationId:string):InboxNote[] { return (this.notes.get(k(tenantId,conversationId))??[]).map(x=>({...x})) }
  projectMessage(message: StoredMessage):InboxConversation { const tenantId=message.tenantId??'local';const existing=this.get(tenantId,message.chatId);return this.upsert({tenantId,id:message.chatId,status:existing?.status??'open',handoff:existing?.handoff??false,assigneeId:existing?.assigneeId,slaDueAt:existing?.slaDueAt,unread:(existing?.unread??0)+(message.direction==='inbound'?1:0)}) }
  private mutate(tenantId:string,id:string,expected:number,fn:(x:InboxConversation)=>InboxConversation):InboxConversation { const old=this.conversations.get(k(tenantId,id)); if(!old) throw new Error('conversation not found'); if(old.version!==expected) throw new InboxConflictError(); const value={...fn(old),version:old.version+1,updatedAt:Date.now()}; this.conversations.set(k(tenantId,id),value); return {...value} }
}
function k(tenant:string,id:string){return `${tenant}\u0000${id}`}
