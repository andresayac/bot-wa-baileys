/** Webhook fixtures shaped like Twilio's documented incoming-message / status-callback params. */

export const WA_TEXT = {
  SmsMessageSid: 'SM11111111111111111111111111111111',
  NumMedia: '0',
  ProfileName: 'Ana',
  SmsSid: 'SM11111111111111111111111111111111',
  WaId: '573001112233',
  SmsStatus: 'received',
  Body: 'hola',
  To: 'whatsapp:+14155238886',
  NumSegments: '1',
  MessageSid: 'SM11111111111111111111111111111111',
  AccountSid: 'AC00000000000000000000000000000000',
  From: 'whatsapp:+573001112233',
  ApiVersion: '2010-04-01',
}

export const WA_IMAGE = {
  ...WA_TEXT,
  MessageSid: 'MM22222222222222222222222222222222',
  SmsMessageSid: 'MM22222222222222222222222222222222',
  SmsSid: 'MM22222222222222222222222222222222',
  Body: 'mira',
  NumMedia: '1',
  MediaContentType0: 'image/jpeg',
  MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/AC00000000000000000000000000000000/Messages/MM22222222222222222222222222222222/Media/ME1',
}

export const WA_BUTTON = {
  ...WA_TEXT,
  MessageSid: 'SM33333333333333333333333333333333',
  Body: 'Sí, confirmar',
  ButtonText: 'Sí, confirmar',
  ButtonPayload: 'confirm_yes',
  ButtonType: 'REPLY',
  OriginalRepliedMessageSid: 'SM99999999999999999999999999999999',
  OriginalRepliedMessageSender: 'whatsapp:+14155238886',
}

export const WA_LOCATION = {
  ...WA_TEXT,
  MessageSid: 'SM44444444444444444444444444444444',
  Body: '',
  Latitude: '4.6097',
  Longitude: '-74.0817',
  Address: 'Bogotá',
}

export const WA_REPLY = {
  ...WA_TEXT,
  MessageSid: 'SM55555555555555555555555555555555',
  Body: 'respondo a eso',
  OriginalRepliedMessageSid: 'SM99999999999999999999999999999999',
  OriginalRepliedMessageSender: 'whatsapp:+14155238886',
}

export const SMS_TEXT = {
  MessageSid: 'SM66666666666666666666666666666666',
  SmsSid: 'SM66666666666666666666666666666666',
  AccountSid: 'AC00000000000000000000000000000000',
  From: '+15005550006',
  To: '+15017122661',
  Body: 'STOP? no, hello',
  NumMedia: '0',
  SmsStatus: 'received',
  FromCountry: 'US',
}

export const STATUS_DELIVERED = {
  MessageSid: 'SM77777777777777777777777777777777',
  MessageStatus: 'delivered',
  SmsStatus: 'delivered',
  To: 'whatsapp:+573001112233',
  From: 'whatsapp:+14155238886',
  AccountSid: 'AC00000000000000000000000000000000',
  ChannelToAddress: '+573001112233',
}

export const STATUS_UNDELIVERED = {
  MessageSid: 'SM88888888888888888888888888888888',
  MessageStatus: 'undelivered',
  To: 'whatsapp:+573001112233',
  From: 'whatsapp:+14155238886',
  ErrorCode: '63016',
  ErrorMessage: 'Outside the allowed window',
}

export function form(params: Record<string, string>): string {
  return new URLSearchParams(params).toString()
}
