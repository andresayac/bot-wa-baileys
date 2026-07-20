declare module 'qr-image' {
  import type { Readable } from 'stream'

  interface QrImageOptions {
    type?: 'png' | 'svg' | 'eps' | 'pdf'
    size?: number
    margin?: number
    [key: string]: any
  }

  export function image(text: string, options?: QrImageOptions): Readable
  export function svg(text: string, options?: QrImageOptions): string
  export function PNG(text: string, options?: QrImageOptions): Buffer
}