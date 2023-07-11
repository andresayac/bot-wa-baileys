/// <reference types="node" />
import { EventEmitter } from 'events';
import { WAMessageContent, WAMessageKey } from '@whiskeysockets/baileys';
type SendMessageOptions = {
    buttons?: {
        body: string;
    }[];
    media?: string;
};
export declare class BaileysClass extends EventEmitter {
    private vendor;
    private store;
    private globalVendorArgs;
    private sock;
    constructor(args?: {});
    getMessage: (key: WAMessageKey) => Promise<WAMessageContent | undefined>;
    getInstance: () => any;
    initBailey: () => Promise<void>;
    setUpBaileySock: ({ version, logger, state, saveCreds }: {
        version: any;
        logger: any;
        state: any;
        saveCreds: any;
    }) => Promise<void>;
    handleConnectionUpdate: (update: any) => Promise<void>;
    clearSessionAndRestart: () => void;
    busEvents: () => any[];
    initBusEvents: (_sock: any) => void;
    /**
     * Send Media
     * @alpha
     * @param {string} number
     * @param {string} message
     * @example await sendMessage('+XXXXXXXXXXX', 'https://dominio.com/imagen.jpg' | 'img/imagen.jpg')
     */
    sendMedia: (number: string, mediaUrl: string, text: string) => Promise<any>;
    /**
     * Send image
     * @param {*} number
     * @param {*} filePath
     * @param {*} text
     * @returns
     */
    sendImage: (number: string, filePath: string, text: string) => Promise<any>;
    /**
     * Enviar video
     * @param {*} number
     * @param {*} imageUrl
     * @param {*} text
     * @returns
     */
    sendVideo: (number: string, filePath: string, text: string) => Promise<any>;
    /**
     * Enviar audio
     * @alpha
     * @param {string} number
     * @param {string} message
     * @param {boolean} voiceNote optional
     * @example await sendMessage('+XXXXXXXXXXX', 'audio.mp3')
     */
    sendAudio: (number: string, audioUrl: string) => Promise<any>;
    /**
     *
     * @param {string} number
     * @param {string} message
     * @returns
     */
    sendText: (number: string, message: string) => Promise<any>;
    /**
     *
     * @param {string} number
     * @param {string} filePath
     * @example await sendMessage('+XXXXXXXXXXX', './document/file.pdf')
     */
    sendFile: (number: string, filePath: string) => Promise<any>;
    /**
     *
     * @param {string} number
     * @param {string} text
     * @param {string} footer
     * @param {Array} buttons
     * @example await sendMessage("+XXXXXXXXXXX", "Your Text", "Your Footer", [{"buttonId": "id", "buttonText": {"displayText": "Button"}, "type": 1}])
     */
    sendButtons: (number: string, text: string, buttons: any[]) => Promise<any>;
    /**
    *
    * @param {string} number
    * @param {string} text
    * @param {string} footer
    * @param {Array} poll
    * @example await sendMessage("+XXXXXXXXXXX", "Your Text", "Your Footer", [{"buttonId": "id", "buttonText": {"displayText": "Button"}, "type": 1}])
    */
    sendPoll: (number: string, text: string, poll: any) => Promise<boolean>;
    /**
     * @param {string} number
     * @param {string} message
     * @example await sendMessage('+XXXXXXXXXXX', 'Hello World')
     */
    sendMessage: (numberIn: string, message: string, options: SendMessageOptions) => Promise<any>;
    /**
     * @param {string} remoteJid
     * @param {string} latitude
     * @param {string} longitude
     * @param {any} messages
     * @example await sendLocation("xxxxxxxxxxx@c.us" || "xxxxxxxxxxxxxxxxxx@g.us", "xx.xxxx", "xx.xxxx", messages)
     */
    sendLocation: (remoteJid: string, latitude: string, longitude: string, messages?: any) => Promise<{
        status: string;
    }>;
    /**
     * @param {string} remoteJid
     * @param {string} contactNumber
     * @param {string} displayName
     * @param {any} messages - optional
     * @example await sendContact("xxxxxxxxxxx@c.us" || "xxxxxxxxxxxxxxxxxx@g.us", "+xxxxxxxxxxx", "Robin Smith", messages)
     */
    sendContact: (remoteJid: string, contactNumber: string, displayName: string, messages?: any) => Promise<{
        status: string;
    }>;
    /**
     * @param {string} remoteJid
     * @param {string} WAPresence
     * @example await sendPresenceUpdate("xxxxxxxxxxx@c.us" || "xxxxxxxxxxxxxxxxxx@g.us", "recording")
     */
    sendPresenceUpdate: (remoteJid: string, WAPresence: string) => Promise<void>;
    /**
     * @param {string} remoteJid
     * @param {string} url
     * @param {object} stickerOptions
     * @param {any} messages - optional
     * @example await sendSticker("xxxxxxxxxxx@c.us" || "xxxxxxxxxxxxxxxxxx@g.us", "https://dn/image.png" || "https://dn/image.gif" || "https://dn/image.mp4", {pack: 'User', author: 'Me'}, messages)
     */
    sendSticker: (remoteJid: string, url: string, stickerOptions: any, messages?: any) => Promise<void>;
}
export {};
