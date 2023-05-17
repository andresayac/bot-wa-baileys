import NodeCache from 'node-cache'
import pino from 'pino'
import makeWASocket, {
    DisconnectReason,
    fetchLatestBaileysVersion,
    getAggregateVotesInPollMessage,
    makeCacheableSignalKeyStore,
    makeInMemoryStore,
    useMultiFileAuthState
} from '@whiskeysockets/baileys'

import { EventEmitter } from 'events';

export const bot = new EventEmitter();

const logger = pino({ level: 'fatal' })
const store = makeInMemoryStore({ logger })

store.readFromFile(`./baileys_store_multi.json`)
setInterval(() => {
    store?.writeToFile('./baileys_store_multi.json')
}, 10_000)

const msgRetryCounterCache = new NodeCache()

const startSock = async () => {

    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
    const { version, isLatest } = await fetchLatestBaileysVersion()
    console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)


    const wa = makeWASocket.default({
        version,
        logger,
        printQRInTerminal: true,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        msgRetryCounterCache,
        generateHighQualityLinkPreview: true,
        getMessage,
    })


    store?.bind(wa.ev)

    wa.ev.on('creds.update', saveCreds)
    wa.ev.on('chats.set', ({ chats }) => console.log('chats.set', JSON.stringify(chats)))
    wa.ev.on('messages.upsert', async ({ messages, type }) => {
        console.log('messages.upsert', JSON.stringify(messages))

        if (type !== 'notify') return
        const [messageCtx] = messages;
        let payload = {
            ...messageCtx,
            body: messageCtx?.message?.extendedTextMessage?.text ?? messageCtx?.message?.conversation,
            from: messageCtx?.key?.remoteJid,
            type: 'text'
        };

        //Detectar location
        if (messageCtx.message?.locationMessage) {
            const { degreesLatitude, degreesLongitude } = messageCtx.message.locationMessage;
            if (typeof degreesLatitude === 'number' && typeof degreesLongitude === 'number') {
                payload = { ...payload, type: 'location' };
            }
        }

        //Detectar media
        if (messageCtx.message?.imageMessage) {
            payload = { ...payload, type: 'image' };
        }

        //Detectar file
        if (messageCtx.message?.documentMessage) {
            payload = { ...payload, type: 'file' };
        }

        //Detectar voice note
        if (messageCtx.message?.audioMessage) {
            payload = { ...payload, type: 'voice' };
        }

        bot.emit('message', payload);
    })
    wa.ev.on('messages.update', async (m) => {
        console.log('messages.update', JSON.stringify(m))
        console.log('messages.update', JSON.stringify(m))
        for (const { key, update } of m) {
            if (update.pollUpdates) {
                const pollCreation = await getMessage(key)
                if (pollCreation) {
                    const pollMessage = await getAggregateVotesInPollMessage({
                        message: pollCreation,
                        pollUpdates: update.pollUpdates,
                    })
                    const [messageCtx] = m;

                    let payload = {
                        ...messageCtx,
                        body: pollMessage.find(poll => poll.voters.length > 0)?.name || '',
                        from: key.remoteJid,
                        voters: pollCreation,
                        type: 'poll'
                    };

                    bot.emit('message', payload);
                }
            }
        }
    })
    wa.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update
        if (connection === 'close') {
            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                startSock()
            } else {
                console.log('Connection closed. You are logged out.')
            }
        }

        console.log('connection update', update)
    })
}

async function getMessage(key) {
    if (store) {
        const msg = await store.loadMessage(key.remoteJid, key.id)
        return msg?.message || undefined
    }
    // only if store is present
    return proto.Message.fromObject({})
}

startSock()



bot.on('message', (message) => {
    console.log('Received messageUpsert event', message);
    if (message.type === 'text') {
        console.log('message_text_is', message?.body);
    }

    if (message.type === 'poll') {
        console.log('message_poll_is:: ', message?.body);
    }

})
