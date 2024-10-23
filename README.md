# Bot Baileys

This repository contains a WhatsApp bot implemented in JavaScript using the [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) library.

## baileys.js

This file is a JavaScript module that exports the `BaileysClass`, which extends `EventEmitter`. This class has several methods for sending different types of messages through WhatsApp, such as text, images, videos, audios, files, buttons, polls, locations, contacts, and stickers.


## Install

Use the stable version:
```
npm i @bot-wa/bot-wa-baileys
```

Then import your code using:
``` ts 
import { BaileysClass } from '@bot-wa/bot-wa-baileys'
```
``` js 
const { BaileysClass } = require('@bot-wa/bot-wa-baileys');
```

## Example

Follow these steps to deploy the application:

- Clone this repository: `https://github.com/andresayac/bot-wa-baileys.git`
- Enter the `bot-wa-baileys` directory
- Run the command `pnpm i`
- Run the command `pnpm run example` to start the bot
- Scan the QR code in WhatsApp as if it were WhatsApp Web. You can find the QR code in `qr.png` or terminal
- Done!

### Key Methods

- `initBailey`: Initializes the connection with WhatsApp.
- `setUpBaileySock`: Sets up the connection socket with WhatsApp.
- `handleConnectionUpdate`: Handles updates to the connection with WhatsApp.
- `busEvents`: Defines various events that the bot can handle.
- `sendMessage`, `sendMedia`, `sendImage`, `sendVideo`, `sendAudio`, `sendText`, `sendFile`, `sendPoll`, `sendLocation`, `sendContact`, `sendPresenceUpdate`, `sendSticker`: Methods for sending different types of messages through WhatsApp.

### Deprecated Methods
- `sendButtons`: It will be removed in the next update

#### Method Parameters

- `sendMessage(numberIn, message, options)`: Sends a message to a given phone number. The message can include additional options like buttons or media.
- `sendMedia(number, mediaUrl, text)`: Sends media to a given phone number. The media is specified by a URL, and additional text can be sent along with the media.
- `sendImage(number, filePath, text)`: Sends an image to a given phone number. The image is specified by a file path, and additional text can be sent along with the image.
- `sendVideo(number, filePath, text)`: Sends a video to a given phone number. The video is specified by a file path, and additional text can be sent along with the video.
- `sendAudio(number, audioUrl)`: Sends audio to a given phone number. The audio is specified by a URL.
- `sendText(number, message)`: Sends a text message to a given phone number.
- `sendFile(number, filePath)`: Sends a file to a given phone number. The file is specified by a file path.
- `sendPoll(number, text, poll)`: Sends a poll to a given phone number. The poll options are displayed along with a given text.
- `sendLocation(remoteJid, latitude, longitude, messages)`: Sends a location to a given chat ID. The location is specified by latitude and longitude, and additional messages can be sent along with the location.
- `sendContact(remoteJid, contactNumber, displayName, messages)`: Sends a contact to a given chat ID. The contact is specified by a phone number and a display name, and additional messages can be sent along with the contact.
- `sendPresenceUpdate(remoteJid, WAPresence)`: Sends a presence update (e.g., "recording") to a given chat ID.
- `sendSticker(remoteJid, url, stickerOptions, messages)`: Sends a sticker to a given chat ID. The sticker is specified by a URL, and additional messages can be sent along with the sticker.

Please note that these methods are asynchronous, meaning they return a promise that resolves once the action is completed.


### Usage QR CODE

Here is an example of how to use the `BaileysClass`:

```javascript
import {BaileysClass} from '@bot-wa/bot-wa-baileys';

const botBaileys = new BaileysClass({});

botBaileys.on('auth_failure', async (error) => console.log("ERROR BOT: ", error));
botBaileys.on('qr', (qr) => console.log("NEW QR CODE: ", qr));
botBaileys.on('ready', async () => console.log('READY BOT'))

let awaitingResponse = false;

botBaileys.on('message', async (message) => {
    if (!awaitingResponse) {
        await botBaileys.sendPoll(message.from, 'Select an option', {
            options: ['text', 'media', 'file', 'sticker'],
            multiselect: false
        });
        awaitingResponse = true;
    } else {
        const command = message.body.toLowerCase().trim();
        switch (command) {
            case 'text':
                await botBaileys.sendText(message.from, 'Hello world');
                break;
            case 'media':
                await botBaileys.sendMedia(message.from, 'https://www.w3schools.com/w3css/img_lights.jpg', 'Hello world');
                break;
            case 'file':
                await botBaileys.sendFile(message.from, 'https://github.com/pedrazadixon/sample-files/raw/main/sample_pdf.pdf');
                break;
            case 'sticker':
                await botBaileys.sendSticker(message.from, 'https://gifimgs.com/animations/anime/dragon-ball-z/Goku/goku_34.gif', { pack: 'User', author: 'Me' });
                break;
            default:
                await botBaileys.sendText(message.from, 'Sorry, I did not understand that command. Please select an option from the poll.');
                break;
        }
        awaitingResponse = false;
    }
});
```

### Usage Pairing Code

Here is an example of how to use the `BaileysClass`:

```javascript
import {BaileysClass} from '@bot-wa/bot-wa-baileys';

const botBaileys = new BaileysClass({ usePairingCode: true, phoneNumber: 'XXXXXXXXXXX' });

botBaileys.on('auth_failure', async (error) => console.log("ERROR BOT: ", error));
botBaileys.on('pairing_code', (code) => console.log("NEW PAIRING CODE: ", code));
botBaileys.on('ready', async () => console.log('READY BOT'))

let awaitingResponse = false;

botBaileys.on('message', async (message) => {
    if (!awaitingResponse) {
        await botBaileys.sendPoll(message.from, 'Select an option', {
            options: ['text', 'media', 'file', 'sticker'],
            multiselect: false
        });
        awaitingResponse = true;
    } else {
        const command = message.body.toLowerCase().trim();
        switch (command) {
            case 'text':
                await botBaileys.sendText(message.from, 'Hello world');
                break;
            case 'media':
                await botBaileys.sendMedia(message.from, 'https://www.w3schools.com/w3css/img_lights.jpg', 'Hello world');
                break;
            case 'file':
                await botBaileys.sendFile(message.from, 'https://github.com/pedrazadixon/sample-files/raw/main/sample_pdf.pdf');
                break;
            case 'sticker':
                await botBaileys.sendSticker(message.from, 'https://gifimgs.com/animations/anime/dragon-ball-z/Goku/goku_34.gif', { pack: 'User', author: 'Me' });
                break;
            default:
                await botBaileys.sendText(message.from, 'Sorry, I did not understand that command. Please select an option from the poll.');
                break;
        }
        awaitingResponse = false;
    }
});
```

### Acknowledgements

This project was inspired by ideas and code from the [bot-whatsapp](https://github.com/codigoencasa/bot-whatsapp) repository by codigoencasa. Their work on creating automated conversation flows and setting up automated responses for frequently asked questions was particularly influential. We appreciate their contributions to the open-source community and their work on WhatsApp bot development.


### Contribution
If you want to contribute to this project, feel free to do so. Any type of improvement, bug fix or new features are welcome.

### Licencia

This project is licensed under the [MIT](LICENSE).

