"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaileysClass = void 0;
const events_1 = require("events");
const pino_1 = __importDefault(require("pino"));
const node_cache_1 = __importDefault(require("node-cache"));
const baileys_1 = __importStar(require("@whiskeysockets/baileys"));
const fs_1 = require("fs");
const wa_sticker_formatter_1 = require("wa-sticker-formatter");
const fluent_ffmpeg_1 = __importDefault(require("fluent-ffmpeg"));
const ffmpeg_1 = __importDefault(require("@ffmpeg-installer/ffmpeg"));
const mime_types_1 = __importDefault(require("mime-types"));
const utils_1 = __importDefault(require("./utils"));
const path_1 = require("path");
const fs_extra_1 = __importDefault(require("fs-extra"));
fluent_ffmpeg_1.default.setFfmpegPath(ffmpeg_1.default.path);
const msgRetryCounterCache = new node_cache_1.default();
const SESSION_DIRECTORY_NAME = `baileys_sessions`;
class BaileysClass extends events_1.EventEmitter {
    constructor(args = {}) {
        super();
        this.getMessage = async (key) => {
            if (this.store) {
                const msg = await this.store.loadMessage(key.remoteJid, key.id);
                return (msg === null || msg === void 0 ? void 0 : msg.message) || undefined;
            }
            // only if store is present
            return baileys_1.proto.Message.fromObject({});
        };
        this.getInstance = () => this.vendor;
        this.initBailey = async () => {
            const logger = (0, pino_1.default)({ level: 'fatal' });
            const { state, saveCreds } = await (0, baileys_1.useMultiFileAuthState)(SESSION_DIRECTORY_NAME);
            const { version, isLatest } = await (0, baileys_1.fetchLatestBaileysVersion)();
            console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`);
            this.store = (0, baileys_1.makeInMemoryStore)({ logger });
            this.store.readFromFile(`./${SESSION_DIRECTORY_NAME}/baileys_store.json`);
            setInterval(() => {
                this.store.writeToFile(`./${SESSION_DIRECTORY_NAME}/baileys_store.json`);
            }, 10000);
            try {
                this.setUpBaileySock({ version, logger, state, saveCreds });
            }
            catch (e) {
                this.emit('auth_failure', e);
            }
        };
        this.setUpBaileySock = async ({ version, logger, state, saveCreds }) => {
            var _a;
            this.sock = (0, baileys_1.default)({
                version,
                logger,
                printQRInTerminal: true,
                auth: {
                    creds: state.creds,
                    keys: (0, baileys_1.makeCacheableSignalKeyStore)(state.keys, logger),
                },
                browser: baileys_1.Browsers.macOS('Desktop'),
                msgRetryCounterCache,
                generateHighQualityLinkPreview: true,
                getMessage: this.getMessage,
            });
            (_a = this.store) === null || _a === void 0 ? void 0 : _a.bind(this.sock.ev);
            this.sock.ev.on('connection.update', this.handleConnectionUpdate);
            this.sock.ev.on('creds.update', saveCreds);
        };
        this.handleConnectionUpdate = async (update) => {
            var _a, _b;
            const { connection, lastDisconnect, qr } = update;
            const statusCode = (_b = (_a = lastDisconnect === null || lastDisconnect === void 0 ? void 0 : lastDisconnect.error) === null || _a === void 0 ? void 0 : _a.output) === null || _b === void 0 ? void 0 : _b.statusCode;
            if (connection === 'close') {
                if (statusCode !== baileys_1.DisconnectReason.loggedOut)
                    this.initBailey();
                if (statusCode === baileys_1.DisconnectReason.loggedOut)
                    this.clearSessionAndRestart();
            }
            if (connection === 'open') {
                this.vendor = this.sock;
                this.initBusEvents(this.sock);
                this.emit('ready', true);
            }
            if (qr)
                this.emit('qr', qr);
        };
        this.clearSessionAndRestart = () => {
            const PATH_BASE = (0, path_1.join)(process.cwd(), SESSION_DIRECTORY_NAME);
            fs_extra_1.default.remove(PATH_BASE)
                .then(() => {
                this.initBailey();
            })
                .catch((err) => {
                console.error('Error to delete directory:', err);
            });
        };
        this.busEvents = () => [
            {
                event: 'messages.upsert',
                func: ({ messages, type }) => {
                    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q;
                    // Ignore notify messages
                    if (type !== 'notify')
                        return;
                    const [messageCtx] = messages;
                    let payload = {
                        ...messageCtx,
                        body: (_c = (_b = (_a = messageCtx === null || messageCtx === void 0 ? void 0 : messageCtx.message) === null || _a === void 0 ? void 0 : _a.extendedTextMessage) === null || _b === void 0 ? void 0 : _b.text) !== null && _c !== void 0 ? _c : (_d = messageCtx === null || messageCtx === void 0 ? void 0 : messageCtx.message) === null || _d === void 0 ? void 0 : _d.conversation,
                        from: (_e = messageCtx === null || messageCtx === void 0 ? void 0 : messageCtx.key) === null || _e === void 0 ? void 0 : _e.remoteJid,
                        type: 'text'
                    };
                    // Ignore pollUpdateMessage
                    if ((_f = messageCtx.message) === null || _f === void 0 ? void 0 : _f.pollUpdateMessage)
                        return;
                    // Ignore broadcast messages
                    if (payload.from === 'status@broadcast')
                        return;
                    // Ignore messages from self
                    if ((_g = payload === null || payload === void 0 ? void 0 : payload.key) === null || _g === void 0 ? void 0 : _g.fromMe)
                        return;
                    // Detect location
                    if ((_h = messageCtx.message) === null || _h === void 0 ? void 0 : _h.locationMessage) {
                        const { degreesLatitude, degreesLongitude } = messageCtx.message.locationMessage;
                        if (typeof degreesLatitude === 'number' && typeof degreesLongitude === 'number') {
                            payload = { ...payload, body: utils_1.default.generateRefprovider('_event_location_'), type: 'location' };
                        }
                    }
                    // Detect  media
                    if ((_j = messageCtx.message) === null || _j === void 0 ? void 0 : _j.imageMessage) {
                        payload = { ...payload, body: utils_1.default.generateRefprovider('_event_media_'), type: 'image' };
                    }
                    // Detect  ectar file
                    if ((_k = messageCtx.message) === null || _k === void 0 ? void 0 : _k.documentMessage) {
                        payload = { ...payload, body: utils_1.default.generateRefprovider('_event_document_'), type: 'file' };
                    }
                    // Detect voice note
                    if ((_l = messageCtx.message) === null || _l === void 0 ? void 0 : _l.audioMessage) {
                        payload = { ...payload, body: utils_1.default.generateRefprovider('_event_voice_note_'), type: 'voice' };
                    }
                    // Check from user and group is valid 
                    if (!utils_1.default.formatPhone(payload.from)) {
                        return;
                    }
                    const btnCtx = (_o = (_m = payload === null || payload === void 0 ? void 0 : payload.message) === null || _m === void 0 ? void 0 : _m.buttonsResponseMessage) === null || _o === void 0 ? void 0 : _o.selectedDisplayText;
                    if (btnCtx)
                        payload.body = btnCtx;
                    const listRowId = (_q = (_p = payload === null || payload === void 0 ? void 0 : payload.message) === null || _p === void 0 ? void 0 : _p.listResponseMessage) === null || _q === void 0 ? void 0 : _q.title;
                    if (listRowId)
                        payload.body = listRowId;
                    payload.from = utils_1.default.formatPhone(payload.from, false);
                    this.emit('message', payload);
                },
            },
            {
                event: 'messages.update',
                func: async (message) => {
                    var _a;
                    for (const { key, update } of message) {
                        if (update.pollUpdates) {
                            const pollCreation = await this.getMessage(key);
                            if (pollCreation) {
                                const pollMessage = await (0, baileys_1.getAggregateVotesInPollMessage)({
                                    message: pollCreation,
                                    pollUpdates: update.pollUpdates,
                                });
                                const [messageCtx] = message;
                                let payload = {
                                    ...messageCtx,
                                    body: ((_a = pollMessage.find(poll => poll.voters.length > 0)) === null || _a === void 0 ? void 0 : _a.name) || '',
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
        ];
        this.initBusEvents = (_sock) => {
            this.vendor = _sock;
            const listEvents = this.busEvents();
            for (const { event, func } of listEvents) {
                this.vendor.ev.on(event, func);
            }
        };
        /**
         * Send Media
         * @alpha
         * @param {string} number
         * @param {string} message
         * @example await sendMessage('+XXXXXXXXXXX', 'https://dominio.com/imagen.jpg' | 'img/imagen.jpg')
         */
        this.sendMedia = async (number, mediaUrl, text) => {
            try {
                const fileDownloaded = await utils_1.default.generalDownload(mediaUrl);
                const mimeType = mime_types_1.default.lookup(fileDownloaded);
                if (typeof mimeType === 'string' && mimeType.includes('image'))
                    return this.sendImage(number, fileDownloaded, text);
                if (typeof mimeType === 'string' && mimeType.includes('video'))
                    return this.sendVideo(number, fileDownloaded, text);
                if (typeof mimeType === 'string' && mimeType.includes('audio')) {
                    const fileOpus = await utils_1.default.convertAudio(fileDownloaded);
                    return this.sendAudio(number, fileOpus);
                }
                return this.sendFile(number, fileDownloaded);
            }
            catch (error) {
                console.error(`Error enviando media: ${error}`);
                throw error;
            }
        };
        /**
         * Send image
         * @param {*} number
         * @param {*} filePath
         * @param {*} text
         * @returns
         */
        this.sendImage = async (number, filePath, text) => {
            const numberClean = utils_1.default.formatPhone(number);
            return this.vendor.sendMessage(numberClean, {
                image: (0, fs_1.readFileSync)(filePath),
                caption: text !== null && text !== void 0 ? text : '',
            });
        };
        /**
         * Enviar video
         * @param {*} number
         * @param {*} imageUrl
         * @param {*} text
         * @returns
         */
        this.sendVideo = async (number, filePath, text) => {
            const numberClean = utils_1.default.formatPhone(number);
            return this.vendor.sendMessage(numberClean, {
                video: (0, fs_1.readFileSync)(filePath),
                caption: text,
                gifPlayback: this.globalVendorArgs.gifPlayback,
            });
        };
        /**
         * Enviar audio
         * @alpha
         * @param {string} number
         * @param {string} message
         * @param {boolean} voiceNote optional
         * @example await sendMessage('+XXXXXXXXXXX', 'audio.mp3')
         */
        this.sendAudio = async (number, audioUrl) => {
            const numberClean = utils_1.default.formatPhone(number);
            return this.vendor.sendMessage(numberClean, {
                audio: { url: audioUrl },
                ptt: true,
            });
        };
        /**
         *
         * @param {string} number
         * @param {string} message
         * @returns
         */
        this.sendText = async (number, message) => {
            const numberClean = utils_1.default.formatPhone(number);
            return this.vendor.sendMessage(numberClean, { text: message });
        };
        /**
         *
         * @param {string} number
         * @param {string} filePath
         * @example await sendMessage('+XXXXXXXXXXX', './document/file.pdf')
         */
        this.sendFile = async (number, filePath) => {
            const numberClean = utils_1.default.formatPhone(number);
            const mimeType = mime_types_1.default.lookup(filePath);
            const fileName = filePath.split('/').pop();
            return this.vendor.sendMessage(numberClean, {
                document: { url: filePath },
                mimetype: mimeType,
                fileName: fileName,
            });
        };
        /**
         *
         * @param {string} number
         * @param {string} text
         * @param {string} footer
         * @param {Array} buttons
         * @example await sendMessage("+XXXXXXXXXXX", "Your Text", "Your Footer", [{"buttonId": "id", "buttonText": {"displayText": "Button"}, "type": 1}])
         */
        this.sendButtons = async (number, text, buttons) => {
            const numberClean = utils_1.default.formatPhone(number);
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
            return this.vendor.sendMessage(numberClean, buttonMessage);
        };
        /**
        *
        * @param {string} number
        * @param {string} text
        * @param {string} footer
        * @param {Array} poll
        * @example await sendMessage("+XXXXXXXXXXX", "Your Text", "Your Footer", [{"buttonId": "id", "buttonText": {"displayText": "Button"}, "type": 1}])
        */
        this.sendPoll = async (number, text, poll) => {
            const numberClean = utils_1.default.formatPhone(number);
            if (poll.options.length < 2)
                return false;
            const pollMessage = {
                name: text,
                values: poll.options,
                selectableCount: 1
            };
            return this.vendor.sendMessage(numberClean, { poll: pollMessage });
        };
        /**
         * @param {string} number
         * @param {string} message
         * @example await sendMessage('+XXXXXXXXXXX', 'Hello World')
         */
        this.sendMessage = async (numberIn, message, options) => {
            var _a, _b;
            const number = utils_1.default.formatPhone(numberIn);
            if ((_a = options === null || options === void 0 ? void 0 : options.buttons) === null || _a === void 0 ? void 0 : _a.length) {
                return this.sendPoll(number, message, {
                    options: (_b = options.buttons.map((btn, i) => (btn.body))) !== null && _b !== void 0 ? _b : [],
                });
            }
            if (options === null || options === void 0 ? void 0 : options.media)
                return this.sendMedia(number, options.media, message);
            return this.sendText(number, message);
        };
        /**
         * @param {string} remoteJid
         * @param {string} latitude
         * @param {string} longitude
         * @param {any} messages
         * @example await sendLocation("xxxxxxxxxxx@c.us" || "xxxxxxxxxxxxxxxxxx@g.us", "xx.xxxx", "xx.xxxx", messages)
         */
        this.sendLocation = async (remoteJid, latitude, longitude, messages = null) => {
            await this.vendor.sendMessage(remoteJid, {
                location: {
                    degreesLatitude: latitude,
                    degreesLongitude: longitude,
                },
            }, { quoted: messages });
            return { status: 'success' };
        };
        /**
         * @param {string} remoteJid
         * @param {string} contactNumber
         * @param {string} displayName
         * @param {any} messages - optional
         * @example await sendContact("xxxxxxxxxxx@c.us" || "xxxxxxxxxxxxxxxxxx@g.us", "+xxxxxxxxxxx", "Robin Smith", messages)
         */
        this.sendContact = async (remoteJid, contactNumber, displayName, messages = null) => {
            const cleanContactNumber = contactNumber.replace(/ /g, '');
            const waid = cleanContactNumber.replace('+', '');
            const vcard = 'BEGIN:VCARD\n' +
                'VERSION:3.0\n' +
                `FN:${displayName}\n` +
                'ORG:Ashoka Uni;\n' +
                `TEL;type=CELL;type=VOICE;waid=${waid}:${cleanContactNumber}\n` +
                'END:VCARD';
            await this.vendor.sendMessage(remoteJid, {
                contacts: {
                    displayName: displayName,
                    contacts: [{ vcard }],
                },
            }, { quoted: messages });
            return { status: 'success' };
        };
        /**
         * @param {string} remoteJid
         * @param {string} WAPresence
         * @example await sendPresenceUpdate("xxxxxxxxxxx@c.us" || "xxxxxxxxxxxxxxxxxx@g.us", "recording")
         */
        this.sendPresenceUpdate = async (remoteJid, WAPresence) => {
            await this.vendor.sendPresenceUpdate(WAPresence, remoteJid);
        };
        /**
         * @param {string} remoteJid
         * @param {string} url
         * @param {object} stickerOptions
         * @param {any} messages - optional
         * @example await sendSticker("xxxxxxxxxxx@c.us" || "xxxxxxxxxxxxxxxxxx@g.us", "https://dn/image.png" || "https://dn/image.gif" || "https://dn/image.mp4", {pack: 'User', author: 'Me'}, messages)
         */
        this.sendSticker = async (remoteJid, url, stickerOptions, messages = null) => {
            const number = utils_1.default.formatPhone(remoteJid);
            const sticker = new wa_sticker_formatter_1.Sticker(url, {
                ...stickerOptions,
                quality: 50,
                type: 'crop',
            });
            const buffer = await sticker.toMessage();
            await this.vendor.sendMessage(number, buffer, { quoted: messages });
        };
        this.vendor = null;
        this.store = null;
        this.globalVendorArgs = { name: `bot`, gifPlayback: false, ...args };
        this.initBailey();
    }
}
exports.BaileysClass = BaileysClass;
