/// <reference types="node" />
declare const utils: {
    formatPhone: (contact: string, full?: boolean) => string;
    generateRefprovider: (prefix?: string) => string;
    isValidNumber: (rawNumber: string) => boolean;
    prepareMedia: (media: string) => {
        url: string;
    } | {
        buffer: Buffer;
    };
    isUrl: (s: string) => boolean;
    generalDownload: (url: string) => Promise<string>;
    convertAudio: (filePath?: string, format?: string) => Promise<string>;
    fileTypeFromFile: (response: {
        headers: {
            'content-type': string;
        };
    }) => Promise<{
        type: string;
        ext: string | any;
    }>;
};
export default utils;
