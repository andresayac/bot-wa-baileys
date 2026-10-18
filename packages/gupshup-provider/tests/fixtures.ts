/** v2 callback fixtures copied from Gupshup's docs (inbound messages + message events). */

const sender = { phone: '918x98xx21x4', name: 'Smit', country_code: '91', dial_code: '8x98xx21x4' }

export const TEXT = {
  app: 'DemoApp', timestamp: 1580227766370, version: 2, type: 'message',
  payload: { id: 'ABEGkYaYVSEEAhAL3SLAWwHKeKrt6s3FKB0c', source: '918x98xx21x4', type: 'text', payload: { text: 'Hi' }, sender },
}

export const IMAGE = {
  app: 'docdeck', timestamp: 1718003620228, version: 2, type: 'message',
  payload: {
    id: 'ABEGkZUTIXZ0Ago69N5XB9zTUbl-', source: '918x98xx21x4', type: 'image',
    payload: {
      caption: 'Sample image',
      url: 'https://filemanager.gupshup.io/wa/23038a99/wa/media/2f997fea?download=false',
      contentType: 'image/jpeg', urlExpiry: 1718608420228,
    },
    sender,
  },
}

export const FILE = {
  app: 'docdeck', timestamp: 1718004253390, version: 2, type: 'message',
  payload: {
    id: 'ABEGkZUTIXZ0Ago6VPYl8mM5nl8R', source: '918x98xx21x4', type: 'file',
    payload: {
      caption: 'Document caption', name: 'IMG_0068.PNG',
      url: 'https://filemanager.gupshup.io/wa/23038a99/wa/media/f716a5c0?download=false&fileName=IMG_0068.PNG',
      contentType: 'image/png', urlExpiry: 1718609053390,
    },
    sender,
  },
}

export const LOCATION = {
  app: 'DemoApp', timestamp: 1580228767338, version: 2, type: 'message',
  payload: { id: 'ABEGkYaYVSEEAhCIxTq7KXQIqby1Uo-IO7_E', source: '918x98xx21x4', type: 'location', payload: { longitude: '72.8552172', latitude: '19.1453658' }, sender },
}

export const REPLY = {
  app: 'docdeck', timestamp: 1718007189549, version: 2, type: 'message',
  payload: {
    id: 'ABEGkZUTIXZ0Ago6jWqOZm-Sz0WD', source: '918x98xx21x4', type: 'text', payload: { text: 'Hi' }, sender,
    context: { id: 'gBEGkYaYVSEEAgnPFrOLcjkFjL8', gsId: '9b71295f-f7af-4c1f-b2b4-31b4a4867bad' },
  },
}

export const TEMPLATE_BUTTON = {
  app: 'docdeck', timestamp: 1718007189549, version: 2, type: 'message',
  payload: {
    id: 'ABEGkZUTIXZ0Ago6jWqOZm-Sz0WE', source: '918x98xx21x4', type: 'text',
    payload: { text: 'View Account Balance', type: 'button' }, sender,
    context: { id: 'gBEGkYaYVSEEAgnPFrOLcjkFjL8', gsId: '9b71295f-f7af-4c1f-b2b4-31b4a4867bad' },
  },
}

export const BUTTON_REPLY = {
  app: 'DemoApp', timestamp: 1718007189600, version: 2, type: 'message',
  payload: { id: 'ABEGkbutton', source: '918x98xx21x4', type: 'button_reply', payload: { title: 'Sí', id: 'gs-generated', reply: 'Sí 1', postbackText: 'confirm_yes' }, sender },
}

export const LIST_REPLY = {
  app: 'DemoApp', timestamp: 1718007189700, version: 2, type: 'message',
  payload: { id: 'ABEGklist', source: '918x98xx21x4', type: 'list_reply', payload: { title: 'Fila 2', id: 'gs-row', reply: 'Fila 2', postbackText: 'row_2', description: 'desc' }, sender },
}

export const REACTION = {
  app: 'DemoApp', timestamp: 1718007189800, version: 2, type: 'message',
  payload: { id: 'wamid.reaction', source: '918x98xx21x4', type: 'reaction', payload: { id: '9340ac2e', gsId: 'd8b6b10a', emoji: '❤️' }, sender },
}

export const EV_ENQUEUED = {
  app: 'DemoAPI', timestamp: 1580546677791, version: 2, type: 'message-event',
  payload: { id: '59f8db90-c37e-4408-90ab-cc54ef8246ad', type: 'enqueued', destination: '91XX985XX10X', payload: { whatsappMessageId: 'gBEG', type: 'session' } },
}

export const EV_DELIVERED = {
  app: 'DemoAPI', timestamp: 1585344476683, version: 2, type: 'message-event',
  payload: { id: 'gBEGkYaYVSEEAgnZxQ3JmKK6Wvg', gsId: 'ee4a68a0-1203-4c85-8dc3-49d0b3226a35', type: 'delivered', destination: '918x98xx21x4', payload: { ts: 1585344476 } },
}

export const EV_FAILED = {
  app: 'DemoAPI', timestamp: 1663138637856, version: 2, type: 'message-event',
  payload: {
    id: '9163a016-710e-41ee-978b-79a1adbd734e', gsId: '72f61f22-5aa4-4615-a970-943edf6da01c', type: 'failed', destination: '918x98xx21x4',
    payload: { code: 470, reason: 'Message failed to send because more than 24 hours have passed since the customer last replied to this number' },
  },
}

export const USER_EVENT = { app: 'DemoApp', timestamp: 1, version: 2, type: 'user-event', payload: { phone: '918x98xx21x4', type: 'opted-in' } }
