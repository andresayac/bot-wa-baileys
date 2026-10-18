---
"create-bot-wa": patch
---

The Baileys-based templates no longer write the QR pairing payload to the logger (anyone reading the logs could link a device while the QR is valid); the `qr` handler only logs a hint, since the provider already draws the QR in the terminal.
