import { EventEmitter } from 'events';
import pino from 'pino'
import { Boom } from '@hapi/boom';
import NodeCache from 'node-cache'
import makeWASocket, {
    DisconnectReason,
    fetchLatestBaileysVersion,
    getAggregateVotesInPollMessage,
    makeCacheableSignalKeyStore,
    makeInMemoryStore,
    useMultiFileAuthState,
    Browsers
} from '@whiskeysockets/baileys'
import { readFileSync } from 'fs';
import crypto from 'crypto';
import { Sticker } from 'wa-sticker-formatter'

import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import path from 'path';
import mime from 'mime-types';
import { rename, createWriteStream, existsSync } from 'fs'
import { tmpdir } from 'os'
import followRedirects from 'follow-redirects';

const { http, https } = followRedirects;

ffmpeg.setFfmpegPath(ffmpegInstaller.path)

const msgRetryCounterCache = new NodeCache()
const SESSION_DIRECTORY_NAME = `baileys_sessions`;

// These are utility functions
const utils = {
    formatPhone: (phone, full = false) => {
        phone = phone.replace('@s.whatsapp.net', '');
        return !full ? `${phone}@s.whatsapp.net` : `${phone}`;
    },
    generateRefprovider: (prefix = '') => prefix ? `${prefix}_${crypto.randomUUID()}` : crypto.randomUUID(),
    isValidNumber: (rawNumber) => !rawNumber.match(/\@g.us\b/gm),
    prepareMedia: (media) => {
        if (isUrl(media)) {
            return { url: media };
        } else {
            try {
                return { buffer: readFileSync(media) };
            } catch (e) {
                console.error(`Failed to read file at ${media}`, e);
                throw e;
            }
        }
    },
    generalDownload: async (url) => {
        const checkIsLocal = existsSync(url)

        const handleDownload = () => {
            const checkProtocol = url.includes('https:')
            const handleHttp = checkProtocol ? https : http

            const name = `tmp-${Date.now()}-dat`
            const fullPath = `${tmpdir()}/${name}`
            const file = createWriteStream(fullPath)

            if (checkIsLocal) {
                /**
                 * From Local
                 */
                return new Promise((res) => {
                    const response = {
                        headers: {
                            'content-type': mime.contentType(extname(url)),
                        },
                    }
                    res({ response, fullPath: url })
                })
            } else {
                /**
                 * From URL
                 */
                return new Promise((res, rej) => {
                    handleHttp.get(url, function (response) {
                        response.pipe(file)
                        file.on('finish', async function () {
                            file.close()
                            res({ response, fullPath })
                        })
                        file.on('error', function () {
                            file.close()
                            rej(null)
                        })
                    })
                })
            }
        }

        const handleFile = (pathInput, ext) =>
            new Promise((resolve, reject) => {
                const fullPath = `${pathInput}.${ext}`
                rename(pathInput, fullPath, (err) => {
                    if (err) reject(null)
                    resolve(fullPath)
                })
            })

        const httpResponse = await handleDownload()
        const { ext } = await utils.fileTypeFromFile(httpResponse.response)
        const getPath = await handleFile(httpResponse.fullPath, ext)

        return getPath
    },
    convertAudio: async (filePath = null, format = 'opus') => {
        const formats = {
            mp3: {
                code: 'libmp3lame',
                ext: 'mp3',
            },
            opus: {
                code: 'libopus',
                ext: 'opus',
            },
        }

        const opusFilePath = path.join(path.dirname(filePath), `${path.basename(filePath, path.extname(filePath))}.${formats[format].ext}`)
        await new Promise((resolve, reject) => {
            ffmpeg(filePath)
                .audioCodec(formats[format].code)
                .audioBitrate('64k')
                .format(formats[format].ext)
                .output(opusFilePath)
                .on('end', resolve)
                .on('error', reject)
                .run()
        })
        return opusFilePath
    },
    fileTypeFromFile: async (response) => {
        const type = response.headers['content-type'] ?? null
        const ext = mime.extension(type)
        return {
            type,
            ext,
        }
    }
}

class BaileysClass extends EventEmitter {
    constructor(args = {}) {
        super()
        this.vendor = null;
        this.store = null;
        this.globalVendorArgs = { name: `bot`, gifPlayback: false, ...args };
        this.initBailey();
    }

    sendMessage = async (userId, message) => {
        return message
    }

    getMessage = async (key) => {
        if (this.store) {
            const msg = await this.store.loadMessage(key.remoteJid, key.id)
            return msg?.message || undefined
        }
        // only if store is present
        return proto.Message.fromObject({})
    }

    getInstance = () => this.vendor;

    initBailey = async () => {
        const logger = pino({ level: 'fatal' })

        const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIRECTORY_NAME);
        const { version, isLatest } = await fetchLatestBaileysVersion()
        console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)

        this.store = makeInMemoryStore({ logger })
        this.store.readFromFile(`./${SESSION_DIRECTORY_NAME}/baileys_store.json`)
        setInterval(() => {
            this.store.writeToFile(`./${SESSION_DIRECTORY_NAME}/baileys_store.json`)
        }, 10_000)

        try {
            this.setUpBaileySock({ version, logger, state, saveCreds });
        } catch (e) {
            this.emit('auth_failure', e);
        }
    }

    setUpBaileySock = async ({ version, logger, state, saveCreds }) => {
        this.sock = makeWASocket.default({
            version,
            logger,
            printQRInTerminal: true,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            browser: Browsers.macOS('Desktop'),
            msgRetryCounterCache,
            generateHighQualityLinkPreview: true,
            getMessage: this.getMessage,
        })

        this.store?.bind(this.sock.ev)

        this.sock.ev.on('connection.update', this.handleConnectionUpdate);
        this.sock.ev.on('creds.update', saveCreds)
    }

    handleConnectionUpdate = async (update) => {
        const { connection, lastDisconnect, qr } = update;
        const statusCode = lastDisconnect?.error?.output?.statusCode;

        if (connection === 'close') {
            if (statusCode !== DisconnectReason.loggedOut) this.initBailey();
            if (statusCode === DisconnectReason.loggedOut) this.clearSessionAndRestart();
        }

        if (connection === 'open') {
            this.vendor = this.sock;
            this.initBusEvents(this.sock);
            this.emit('ready', true);
        }

        if (qr) this.emit('qr', qr);
    }

    clearSessionAndRestart = () => {
        const PATH_BASE = join(process.cwd(), SESSION_DIRECTORY_NAME);
        rimraf(PATH_BASE, (err) => {
            if (err) return;
            this.initBailey();
        });
    }



    busEvents = () => [
        {
            event: 'messages.upsert',
            func: ({ messages, type }) => {
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
                        payload = { ...payload, body: utils.generateRefprovider('_event_location_'), type: 'location' };
                    }
                }

                //Detectar media
                if (messageCtx.message?.imageMessage) {
                    payload = { ...payload, body: utils.generateRefprovider('_event_media_'), type: 'image' };
                }

                //Detectar file
                if (messageCtx.message?.documentMessage) {
                    payload = { ...payload, body: utils.generateRefprovider('_event_document_'), type: 'file' };
                }

                //Detectar voice note
                if (messageCtx.message?.audioMessage) {
                    payload = { ...payload, body: utils.generateRefprovider('_event_voice_note_'), type: 'voice' };
                }

                if (payload.from === 'status@broadcast') return

                if (payload?.key?.fromMe) return

                if (!utils.formatPhone(payload.from)) {
                    return
                }

                const btnCtx = payload?.message?.buttonsResponseMessage?.selectedDisplayText;
                if (btnCtx) payload.body = btnCtx;

                const listRowId = payload?.message?.listResponseMessage?.title;
                if (listRowId) payload.body = listRowId;

                payload.from = utils.formatPhone(payload.from, true);
                this.emit('message', payload);
            },
        },
        {
            event: 'messages.update',
            func: async (message) => {
                for (const { key, update } of message) {
                    if (update.pollUpdates) {
                        const pollCreation = await this.getMessage(key)
                        if (pollCreation) {
                            const pollMessage = await getAggregateVotesInPollMessage({
                                message: pollCreation,
                                pollUpdates: update.pollUpdates,
                            })
                            const [messageCtx] = message;

                            let payload = {
                                ...messageCtx,
                                body: pollMessage.find(poll => poll.voters.length > 0)?.name || '',
                                from: key.remoteJid,
                                voters: pollCreation,
                                type: 'poll'
                            };

                            this.emit('message', payload);
                        }
                    }
                }
            }
        }
    ]

    initBusEvents = (_sock) => {
        this.vendor = _sock;
        const listEvents = this.busEvents();

        for (const { event, func } of listEvents) {
            this.vendor.ev.on(event, func);
        }
    }

    /**
     * Send Media
     * @alpha
     * @param {string} number
     * @param {string} message
     * @example await sendMessage('+XXXXXXXXXXX', 'https://dominio.com/imagen.jpg' | 'img/imagen.jpg')
     */

    sendMedia = async (number, mediaUrl, text) => {
        try {
            const fileDownloaded = await utils.generalDownload(mediaUrl);
            const mimeType = mime.lookup(fileDownloaded);

            if (mimeType.includes('image')) return this.sendImage(number, fileDownloaded, text)
            if (mimeType.includes('video')) return this.sendVideo(number, fileDownloaded, text)
            if (mimeType.includes('audio')) {
                const fileOpus = await utils.convertAudio(fileDownloaded);
                return this.sendAudio(number, fileOpus, text)
            }

            return this.sendFile(number, fileDownloaded)
        } catch (error) {
            console.error(`Error enviando media: ${error}`);
            throw error;
        }
    }

    /**
     * Send image
     * @param {*} number
     * @param {*} filePath
     * @param {*} text
     * @returns
     */
    sendImage = async (number, filePath, text) => {
        const numberClean = utils.formatPhone(number)
        return this.vendor.sendMessage(numberClean, {
            image: readFileSync(filePath),
            caption: text ?? '',
        })
    }

    /**
     * Enviar video
     * @param {*} number
     * @param {*} imageUrl
     * @param {*} text
     * @returns
     */
    sendVideo = async (number, filePath, text) => {
        const numberClean = utils.formatPhone(number)
        return this.vendor.sendMessage(numberClean, {
            video: readFileSync(filePath),
            caption: text,
            gifPlayback: this.globalVendorArgs.gifPlayback,
        })
    }

    /**
     * Enviar audio
     * @alpha
     * @param {string} number
     * @param {string} message
     * @param {boolean} voiceNote optional
     * @example await sendMessage('+XXXXXXXXXXX', 'audio.mp3')
     */

    sendAudio = async (number, audioUrl) => {
        const numberClean = utils.formatPhone(number)
        return this.vendor.sendMessage(numberClean, {
            audio: { url: audioUrl },
            ptt: true,
        })
    }

    /**
     *
     * @param {string} number
     * @param {string} message
     * @returns
     */
    sendText = async (number, message) => {
        const numberClean = utils.formatPhone(number)
        return this.vendor.sendMessage(numberClean, { text: message })
    }

    /**
     *
     * @param {string} number
     * @param {string} filePath
     * @example await sendMessage('+XXXXXXXXXXX', './document/file.pdf')
     */

    sendFile = async (number, filePath) => {
        const numberClean = utils.formatPhone(number)
        const mimeType = mime.lookup(filePath);
        console.log({ mimeType })
        const fileName = filePath.split('/').pop();
        return this.vendor.sendMessage(numberClean, {
            document: { url: filePath },
            mimetype: mimeType,
            fileName: fileName,
        })
    }

    /**
     *
     * @param {string} number
     * @param {string} text
     * @param {string} footer
     * @param {Array} buttons
     * @example await sendMessage("+XXXXXXXXXXX", "Your Text", "Your Footer", [{"buttonId": "id", "buttonText": {"displayText": "Button"}, "type": 1}])
     */

    sendButtons = async (number, text, buttons) => {
        const numberClean = utils.formatPhone(number)

        const templateButtons = buttons.map((btn, i) => ({
            buttonId: `id-btn-${i}`,
            buttonText: { displayText: btn.body },
            type: 1,
        }));

        const buttonMessage = {
            text,
            footer: '',
            buttons: templateButtons,
            headerType: 1,
        };

        return this.vendor.sendMessage(numberClean, buttonMessage)
    }

    /**
    *
    * @param {string} number
    * @param {string} text
    * @param {string} footer
    * @param {Array} poll
    * @example await sendMessage("+XXXXXXXXXXX", "Your Text", "Your Footer", [{"buttonId": "id", "buttonText": {"displayText": "Button"}, "type": 1}])
    */

    sendPoll = async (number, text, poll) => {
        const numberClean = utils.formatPhone(number)

        if (poll.options.length < 2) return false

        const pollMessage = {
            name: text,
            values: poll.options,
            selectableCount: 1
        };
        return this.vendor.sendMessage(numberClean, { poll: pollMessage })
    }

    /**
     * @param {string} number
     * @param {string} message
     * @example await sendMessage('+XXXXXXXXXXX', 'Hello World')
     */

    sendMessage = async (numberIn, message, { options }) => {
        const number = utils.formatPhone(numberIn);
        if (options?.buttons?.length) return this.sendButtons(number, message, options.buttons)
        if (options?.media) return this.sendMedia(number, options.media, message)
        return this.sendText(number, message)
    }

    /**
     * @param {string} remoteJid
     * @param {string} latitude
     * @param {string} longitude
     * @param {any} messages
     * @example await sendLocation("xxxxxxxxxxx@c.us" || "xxxxxxxxxxxxxxxxxx@g.us", "xx.xxxx", "xx.xxxx", messages)
     */

    sendLocation = async (remoteJid, latitude, longitude, messages = null) => {
        await this.vendor.sendMessage(
            remoteJid,
            {
                location: {
                    degreesLatitude: latitude,
                    degreesLongitude: longitude,
                },
            },
            { quoted: messages }
        );

        return { status: 'success' }
    }

    /**
     * @param {string} remoteJid
     * @param {string} contactNumber
     * @param {string} displayName
     * @param {any} messages - optional
     * @example await sendContact("xxxxxxxxxxx@c.us" || "xxxxxxxxxxxxxxxxxx@g.us", "+xxxxxxxxxxx", "Robin Smith", messages)
     */

    sendContact = async (remoteJid, contactNumber, displayName, messages = null) => {
        const cleanContactNumber = contactNumber.replaceAll(' ', '');
        const waid = cleanContactNumber.replace('+', '');

        const vcard =
            'BEGIN:VCARD\n' +
            'VERSION:3.0\n' +
            `FN:${displayName}\n` +
            'ORG:Ashoka Uni;\n' +
            `TEL;type=CELL;type=VOICE;waid=${waid}:${cleanContactNumber}\n` +
            'END:VCARD';

        await this.vendor.sendMessage(
            remoteJid,
            {
                contacts: {
                    displayName: displayName,
                    contacts: [{ vcard }],
                },
            },
            { quoted: messages }
        );

        return { status: 'success' }
    }

    /**
     * @param {string} remoteJid
     * @param {string} WAPresence
     * @example await sendPresenceUpdate("xxxxxxxxxxx@c.us" || "xxxxxxxxxxxxxxxxxx@g.us", "recording")
     */
    sendPresenceUpdate = async (remoteJid, WAPresence) => {
        await this.vendor.sendPresenceUpdate(WAPresence, remoteJid);
    }

    /**
     * @param {string} remoteJid
     * @param {string} url
     * @param {object} stickerOptions
     * @param {any} messages - optional
     * @example await sendSticker("xxxxxxxxxxx@c.us" || "xxxxxxxxxxxxxxxxxx@g.us", "https://dn/image.png" || "https://dn/image.gif" || "https://dn/image.mp4", {pack: 'User', author: 'Me'}, messages)
     */

    sendSticker = async (remoteJid, url, stickerOptions, messages = null) => {
        const number = utils.formatPhone(remoteJid);
        const sticker = new Sticker(url, {
            ...stickerOptions,
            quality: 50,
            type: 'crop',
        });

        const buffer = await sticker.toMessage();

        await this.vendor.sendMessage(number, buffer, { quoted: messages });
    }
}

export default BaileysClass;
