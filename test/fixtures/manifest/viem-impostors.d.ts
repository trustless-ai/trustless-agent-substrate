export interface Chain {
  readonly request: (method: string) => Promise<unknown>
}

export interface Kzg {
  readonly computeProof: (blob: `0x${string}`) => `0x${string}`
}

export interface Account {
  readonly address: `0x${string}`
  readonly sign: (payload: `0x${string}`) => Promise<`0x${string}`>
}

export interface Uint8Array {
  readonly buffer: ArrayBuffer
}
