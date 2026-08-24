import type {
  Account as ForeignAccount,
  Chain as ForeignChain,
  Kzg as ForeignKzg,
  Uint8Array as ForeignUint8Array,
} from './viem-impostors.js'

export interface PrivateKeyAccount {
  readonly address: `0x${string}`
  readonly type: 'local'
  readonly sign: (value: `0x${string}`) => Promise<`0x${string}`>
}

export type Account = PrivateKeyAccount | {
  readonly address: `0x${string}`
  readonly type: 'json-rpc'
}

export interface OpaqueClient {
  request(parameters: { readonly method: string }): Promise<unknown>
}

export interface AbiParameter {
  readonly name?: string
  readonly type: string
  readonly components?: readonly AbiParameter[]
}

export interface Kzg {
  readonly blobToCommitment: (blob: `0x${string}`) => `0x${string}`
  readonly computeProof: (blob: `0x${string}`) => `0x${string}`
}

export type ContractFunctionReturnType<abi> = abi extends readonly unknown[] ? unknown : never
export type Hex = `0x${string}`
export type TransactionSerializedGeneric = Hex & { readonly __serializedTransactionBrand?: never }

export type PublicActions = {
  getChainId(): Promise<number>
  getBalance(parameters: { readonly address: `0x${string}` }): Promise<bigint>
  waitForReceipt(parameters: {
    readonly hash: `0x${string}`
    readonly onReplaced?: (replacement: { readonly hash: `0x${string}` }) => void
  }): Promise<{ readonly status: 'success' | 'reverted' }>
  watchBlocks(parameters: {
    readonly onBlock: (block: { readonly number: bigint }) => void
  }): () => void
  getCallback(): Promise<() => void>
  getClient(): Promise<OpaqueClient>
  /** Fills a transaction request with the fields needed to be signed over. */
  fillTransaction(parameters: { readonly to: `0x${string}` }): Promise<{ readonly to: `0x${string}` }>
  /** Sends a signed transaction. JSON-RPC Method: `eth_sendRawTransaction`. */
  broadcastSigned(parameters: { readonly serializedTransaction: `0x${string}` }): Promise<`0x${string}`>
  /** Sends a signed transaction through an undocumented transport. */
  broadcastUnknown(parameters: { readonly serializedTransaction: `0x${string}` }): Promise<`0x${string}`>
  relayBytes(parameters: { readonly serializedTransaction: `0x${string}` }): Promise<`0x${string}`>
  deepRelay(parameters: { readonly envelope: { readonly payload: { readonly signedTransaction: `0x${string}` } } }): Promise<`0x${string}`>
  abiWithUnknown(parameters: { readonly abi: readonly AbiParameter[]; readonly metadata: unknown }): Promise<boolean>
  abiWithUnsafeOutput(parameters: { readonly abi: readonly AbiParameter[] }): Promise<{ readonly metadata: unknown }>
  abiResult<const abi extends readonly AbiParameter[]>(parameters: { readonly abi: abi }): Promise<ContractFunctionReturnType<abi>>
  abiPromise(parameters: { readonly abi: Promise<readonly AbiParameter[]> }): Promise<boolean>
  untrustedAbi(parameters: { readonly abi: unknown; readonly args?: readonly unknown[] }): Promise<unknown>
  promiseInput(parameters: Promise<string>): Promise<boolean>
  nestedPromise(parameters: { readonly payload: Promise<string> }): Promise<boolean>
  nestedPromiseOutput(): Promise<{ readonly nested: Promise<string> }>
  nestedAccount(parameters: { readonly payload: { readonly account?: `0x${string}` | Account } }): Promise<boolean>
  providerInput(parameters: { readonly provider?: { readonly run: (value: string) => string } }): Promise<boolean>
  foreignChain(parameters: { readonly chain?: ForeignChain }): Promise<boolean>
  foreignAccount(parameters: { readonly account?: `0x${string}` | ForeignAccount }): Promise<boolean>
  bytes(parameters: { readonly payload: Uint8Array }): Promise<boolean>
  foreignBytes(parameters: { readonly payload: ForeignUint8Array }): Promise<boolean>
  inspectSerialized(parameters: { readonly payload: TransactionSerializedGeneric }): Promise<boolean>
  inspectRaw(serializedTxBytes: Hex): Promise<boolean>
  relayAlias(parameters: { readonly payload: TransactionSerializedGeneric }): Promise<boolean>
  relayBare(payload: Hex): Promise<boolean>
  relayHex(parameters: { readonly payload: Hex }): Promise<boolean>
  readHex(parameters: { readonly payload: Hex }): Promise<boolean>
  readonly token: { readonly read: OpaqueClient }
}

export type WalletActions = {
  sendTransaction(parameters: {
    readonly account?: Account
    readonly to: `0x${string}`
    readonly value?: bigint
  }): Promise<`0x${string}`>
  /** Executes a write function and submits its transaction. */
  writeContract(parameters: {
    readonly account: Account
    readonly abi: readonly AbiParameter[]
    readonly functionName: string
    readonly args?: readonly unknown[]
    readonly kzg?: Kzg
  }): Promise<`0x${string}`>
  foreignKzg(parameters: { readonly account: Account; readonly kzg?: ForeignKzg }): Promise<boolean>
  waitForTransaction(parameters: {
    readonly account: Account
    readonly onProgress?: (state: 'submitted' | 'confirmed') => void
    readonly to: `0x${string}`
  }): Promise<`0x${string}`>
  getAddresses(): Promise<readonly `0x${string}`[]>
  readonly token: { readonly write: OpaqueClient }
}
