// The original OPAQUE identity is bound into existing registration records.
export const opaqueServerIdentity = origin => origin === 'https://app.housecall.chat' ? 'https://housecall.chat' : origin;