import BaileysClass from '../baileys.js';
import MockAdapter from '@bot-whatsapp/database/mock';
import botLib from '@bot-whatsapp/bot';

const { createBot, createProvider, createFlow, EVENTS, addKeyword } = botLib;

const flowWellcome = addKeyword(['wellcome'])
    .addAnswer(['Hi there!'])
    .addAnswer([
        'How are you?',
        ' 1 - Good',
        ' 2 - Bad',
    ],
        { capture: true },
        async (ctx, { fallBack, flowDynamic, gotoFlow, provider }) => {
            let option = parseInt(ctx.body.toLowerCase().trim())
            if (![1, 2].includes(option)) {
                await flowDynamic(['Option not found, try again'])
                await fallBack()
                return
            }

            // view message 
            await provider.vendor.readMessages([ctx?.key])
            new Promise((res) => setTimeout(res, 1000))
            await provider.vendor.presenceSubscribe(ctx?.key?.remoteJid)

            // simulare writing
            await provider.vendor.sendPresenceUpdate('composing', ctx?.key?.remoteJid)
            new Promise((res) => setTimeout(res, 1000))
            await provider.vendor.sendPresenceUpdate('paused', ctx?.key?.remoteJid)


            if (option === 1) {
                await flowDynamic(['I am glad to hear that!'])
            }

            if (option === 2) {
                await flowDynamic(['I am sorry to hear that!'])
            }

            await gotoFlow(mainFlow)

        }

    );

const flowGit = addKeyword(['git'])
    .addAnswer(['Git https://github.com/andresayac/bot_baileys'])


const flowHelp = addKeyword(['help'])
    .addAnswer(['Help contact us at discord user andresaya'])


const flowTypeMessage = addKeyword(['Types Messages', 'types messages'])
    .addAnswer([
        'Select the type of message you want to send',
    ],
        { capture: true, 'buttons': [{ "body": "Text" }, { "body": "Media" }, { "body": "Sticker" }, { "body": "File" }, { 'body': 'Go to Flow Main' }] },
        async (ctx, { fallBack, flowDynamic, gotoFlow, provider }) => {
            let type = ctx.body.toLowerCase().trim()
            if (!['text', 'media', 'sticker', 'file', 'go to flow main'].includes(type)) {

                await flowDynamic(['Option type meessage not found, try again'])
                await fallBack()
                return
            }
            switch (type) {
                case 'text': await provider.sendText(ctx.from, 'This is a text message'); break;
                case 'media': await provider.sendMedia(ctx.from, 'https://www.w3schools.com/w3css/img_lights.jpg', 'This is a media message'); break;
                case 'sticker': await provider.sendSticker(ctx.from, 'https://raw.githubusercontent.com/WhiskeySockets/Baileys/master/Media/octopus.webp'); break;
                case 'file': await provider.sendFile(ctx.from, 'https://github.com/pedrazadixon/sample-files/raw/main/sample_pdf.pdf', 'This is a file message'); break;
                case 'go to flow main': await gotoFlow(mainFlow); return; break;
                default: await flowDynamic(['Native type meessage not found, try again'])
            }
            await flowDynamic('Select the type of message you want to send')
            await fallBack()

        },
        []
    )


const mainFlow = addKeyword(EVENTS.WELCOME)
    .addAnswer('🙌 Hello, welcome to this *Chatbot*')
    .addAnswer([
        '📄 Here we have the main flow',
    ],
        { capture: true, 'buttons': [{ "body": "Wellcome" }, { "body": "Types Messages" }, { "body": "Git" }, { "body": "Help" }] },
        async (ctx, { fallBack, flowDynamic }) => {
            if (!['wellcome', 'git', 'help', 'types messages'].includes(ctx.body.toLowerCase().trim())) {
                await flowDynamic(['Option not found, try again'])
                await fallBack()
                return
            }
        },
        [flowWellcome, flowGit, flowHelp, flowTypeMessage]
    )


const main = async () => {
    const adapterFlow = createFlow([mainFlow])
    const adapterProvider = createProvider(BaileysClass)
    const adapterDB = new MockAdapter()

    createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB
    })

}

main()
