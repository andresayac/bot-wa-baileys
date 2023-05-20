import BaileysClass from './baileys.js';

const botBaileys = new BaileysClass(null);

botBaileys.on('auth_failure', async (error) => console.log("ERROR BOT: ", error));
botBaileys.on('qr', (qr) => console.log("NEW QR CODE: ", qr));
botBaileys.on('ready', async () => console.log('READY BOT'))

botBaileys.on('message', async (message) => {
    console.log({ message });
    await botBaileys.sendText(message.from, 'Hello world');
    await botBaileys.sendMessage(message.from, 'Hello world', {
        media: {
            url: 'https://www.w3schools.com/w3css/img_lights.jpg',
        }
    });

    await botBaileys.sendMedia(message.from, 'https://www.w3schools.com/w3css/img_lights.jpg', 'Hello world');
    await botBaileys.sendMedia(message.from, 'https://github.com/pedrazadixon/sample-files/raw/main/sample_video_mp4.mp4', 'Hello world');
    await botBaileys.sendMedia(message.from, 'https://github.com/pedrazadixon/sample-files/raw/main/sample_mp3.mp3', 'Hello world');
    await botBaileys.sendFile(message.from, 'https://github.com/pedrazadixon/sample-files/raw/main/sample_pdf.pdf')
    await botBaileys.sendPoll(message.from, 'Hello world', {
        options: ['Option 1', 'Option 2', 'Option 3', 'Option 4'],
        multiselect: false
    });

    await botBaileys.sendSticker(message.from, 'https://gifimgs.com/animations/anime/dragon-ball-z/Goku/goku_34.gif', { pack: 'User', author: 'Me' })

});


