import { createHash } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'

import solc from 'solc'
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  stringToHex,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { describe, expect, it, onTestFinished } from 'vitest'

import { createAgentSdkBindingClient } from '../../src/clients/workflow/agentSdkClient.js'
import type { DaClient } from '../../src/core/da/client.js'
import { createDaService } from '../../src/core/da/service.js'
import type { RepositoryResolver } from '../../src/core/repository/resolver.js'
import type { RepositorySource } from '../../src/core/repository/types.js'
import { createWorkflowContractAddressResolver } from '../../src/core/workflow/contractAddressResolver.js'
import { createWorkflowOperationService } from '../../src/core/workflow/operationService.js'
import type {
  VerifiedWorkflowContext,
  WorkflowMemberResolver,
  WorkflowVerificationGate,
} from '../../src/core/workflow/types.js'
import { getManifestRegistry } from '../../src/mcp/manifest/registry.js'

const evaluatorPrivateKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const contributorPrivateKey = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const evaluatorAgentId = '340282366920938463463374607431768211457'
const contributorAgentId = '340282366920938463463374607431768211458'
const demoRoot = fileURLToPath(new URL('../../tawg/demo/', import.meta.url))
const emptyFingerprint = `sha256:${'0'.repeat(64)}`

const fixtureSource = `// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

contract IdentityRegistryFixture {
    error AlreadyRegistered(uint256 agentId);
    error NonexistentAgent(uint256 agentId);

    mapping(uint256 agentId => address owner) private _owners;
    mapping(uint256 agentId => address wallet) private _wallets;

    function register(uint256 agentId) external {
        if (_owners[agentId] != address(0)) revert AlreadyRegistered(agentId);
        _owners[agentId] = msg.sender;
        _wallets[agentId] = msg.sender;
    }

    function ownerOf(uint256 agentId) external view returns (address owner) {
        owner = _owners[agentId];
        if (owner == address(0)) revert NonexistentAgent(agentId);
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        return _wallets[agentId];
    }
}

contract ProfileFixture {
    struct AgentRecord {
        bool isMember;
        string data;
        address verifier;
    }

    address public immutable identityRegistry;
    mapping(uint256 agentId => AgentRecord record) private _agents;

    constructor(address identityRegistry_) {
        identityRegistry = identityRegistry_;
    }

    function join(uint256 agentId, string calldata data, address verifier) external {
        if (IIdentityRegistryFixture(identityRegistry).ownerOf(agentId) != msg.sender) revert();
        _agents[agentId] = AgentRecord({isMember: true, data: data, verifier: verifier});
    }

    function getAgent(uint256 agentId) external view returns (bool isMember, string memory data, address verifier) {
        AgentRecord storage record = _agents[agentId];
        return (record.isMember, record.data, record.verifier);
    }
}

interface IIdentityRegistryFixture {
    function ownerOf(uint256 agentId) external view returns (address);
}
`

interface CompiledArtifact {
  readonly abi: Abi
  readonly bytecode: Hex
}

interface CompilerOutput {
  readonly contracts?: Readonly<Record<string, Readonly<Record<string, {
    readonly abi?: Abi
    readonly evm?: { readonly bytecode?: { readonly object?: string } }
  }>>>>
  readonly errors?: readonly { readonly severity?: string; readonly formattedMessage?: string }[]
}

function compileDemo(): Readonly<Record<'registry' | 'profile' | 'verifier' | 'workflow', CompiledArtifact>> {
  const input = {
    language: 'Solidity',
    sources: {
      'contracts/Workflow.sol': { content: readFileSync(`${demoRoot}/contracts/Workflow.sol`, 'utf8') },
      'contracts/PassThroughVerifier.sol': {
        content: readFileSync(`${demoRoot}/contracts/PassThroughVerifier.sol`, 'utf8'),
      },
      '@agent-ercs/execution/ERC8301/IAgentWorkflow.sol': {
        content: readFileSync(
          `${demoRoot}/vendor/agent-ercs/contracts/execution/ERC8301/IAgentWorkflow.sol`,
          'utf8',
        ),
      },
      '@agent-ercs/verify/ERC8274/IAgentVerifier.sol': {
        content: readFileSync(
          `${demoRoot}/vendor/agent-ercs/contracts/verify/ERC8274/IAgentVerifier.sol`,
          'utf8',
        ),
      },
      'test/Fixtures.sol': { content: fixtureSource },
    },
    settings: {
      evmVersion: 'cancun',
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  }
  const output = JSON.parse(solc.compile(JSON.stringify(input))) as CompilerOutput
  const errors = output.errors?.filter((error) => error.severity === 'error') ?? []
  if (errors.length > 0) {
    throw new Error(errors.map((error) => error.formattedMessage ?? 'Solidity compilation failed').join('\n'))
  }

  function artifact(path: string, contractName: string): CompiledArtifact {
    const compiled = output.contracts?.[path]?.[contractName]
    const bytecode = compiled?.evm?.bytecode?.object
    if (compiled?.abi === undefined || bytecode === undefined || !/^[0-9a-f]+$/i.test(bytecode)) {
      throw new Error(`Missing compiled artifact ${path}:${contractName}`)
    }
    return { abi: compiled.abi, bytecode: `0x${bytecode}` }
  }

  return {
    registry: artifact('test/Fixtures.sol', 'IdentityRegistryFixture'),
    profile: artifact('test/Fixtures.sol', 'ProfileFixture'),
    verifier: artifact('contracts/PassThroughVerifier.sol', 'PassThroughVerifier'),
    workflow: artifact('contracts/Workflow.sol', 'Workflow'),
  }
}

async function unusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Could not allocate an Anvil port')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

async function stopAnvilProcess(process: ChildProcessWithoutNullStreams): Promise<void> {
  const running = (): boolean => process.pid !== undefined && process.exitCode === null && process.signalCode === null
  const waitForExit = (timeoutMs: number): Promise<boolean> => new Promise((resolve) => {
    if (!running()) { resolve(true); return }
    const exited = (): void => { clearTimeout(timer); resolve(true) }
    const timer = setTimeout(() => { process.off('exit', exited); resolve(false) }, timeoutMs)
    process.once('exit', exited)
  })
  if (running()) {
    process.kill('SIGTERM')
    if (!await waitForExit(2_000) && running()) {
      process.kill('SIGKILL')
      await waitForExit(2_000)
    }
  }
  process.stdin.destroy()
  process.stdout.destroy()
  process.stderr.destroy()
}

async function startAnvil(): Promise<{
  readonly process: ChildProcessWithoutNullStreams
  readonly rpcUrl: string
  readonly stop: () => Promise<void>
}> {
  let latestDiagnostics = ''
  for (let launch = 0; launch < 4; launch += 1) {
    const port = await unusedPort()
    const process = spawn('anvil', [
      '--accounts', '2', '--chain-id', '31337', '--host', '127.0.0.1', '--port', String(port), '--silent',
    ], { stdio: 'pipe' })
    let stopPromise: Promise<void> | undefined
    const stop = (): Promise<void> => stopPromise ??= stopAnvilProcess(process)
    let diagnostics = ''
    let spawnError: Error | undefined
    process.once('error', (error) => { spawnError = error })
    process.stderr.on('data', (chunk: Buffer) => { diagnostics = `${diagnostics}${chunk.toString()}`.slice(-4_096) })
    const rpcUrl = `http://127.0.0.1:${port}`
    const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl, { retryCount: 0 }) })
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (spawnError !== undefined || process.exitCode !== null || process.signalCode !== null) break
      try {
        if (await publicClient.getChainId() === 31337) {
          return { process, rpcUrl, stop }
        }
      } catch {
        await new Promise<void>((resolve) => setTimeout(resolve, 50))
      }
    }
    latestDiagnostics = spawnError?.message ?? diagnostics
    await stop()
    if (spawnError !== undefined && 'code' in spawnError && spawnError.code === 'ENOENT') break
  }
  throw new Error(`Anvil did not become ready after bounded retries: ${latestDiagnostics}`)
}

function inMemoryDa(): ReturnType<typeof createDaService> {
  const exactObjects = new Map<string, Uint8Array>()
  const source: RepositorySource = {
    provider: 'github',
    locator: 'https://github.com/trustless-ai/tasg-demo',
    owner: 'trustless-ai',
    repository: 'tasg-demo',
    profile: { blockNumber: '1', blockHash: `0x${'1'.repeat(64)}`, version: '1' },
    charter: { commit: '2'.repeat(40), path: 'charter/' },
  }
  const resolver: RepositoryResolver = { resolve: async () => source }
  const client: DaClient = {
    capabilities: () => ({
      backend: 'git',
      reference_types: ['git'],
      read: true,
      write: true,
      content_encodings: ['utf8', 'base64'],
      max_inline_bytes: 1_048_576,
    }),
    async put(_source, path, bytes) {
      const commit = createHash('sha1').update(path).update(bytes).digest('hex')
      exactObjects.set(`${commit}:${path}`, bytes.slice())
      return { type: 'git', commit, path }
    },
    async get(_source, ref) {
      const bytes = exactObjects.get(`${ref.commit}:${ref.path}`)
      if (bytes === undefined) throw new Error('Immutable DA object not found')
      return { bytes: bytes.slice() }
    },
  }
  return createDaService(resolver, client)
}

describe('agent-sdk ERC-8301 integration on Anvil', () => {
  it('runs the Demo Workflow and anchors an exact immutable Git DA contribution through two Agent services', async () => {
    const anvil = await startAnvil()
    onTestFinished(anvil.stop)
    try {
      const artifacts = compileDemo()
      const publicClient = createPublicClient({ chain: foundry, transport: http(anvil.rpcUrl) })
      const evaluator = privateKeyToAccount(evaluatorPrivateKey)
      const contributor = privateKeyToAccount(contributorPrivateKey)
      const evaluatorWallet = createWalletClient({ account: evaluator, chain: foundry, transport: http(anvil.rpcUrl) })
      const contributorWallet = createWalletClient({ account: contributor, chain: foundry, transport: http(anvil.rpcUrl) })

      const deploy = async (artifact: CompiledArtifact, arguments_: readonly unknown[] = []): Promise<Address> => {
        const hash = await evaluatorWallet.deployContract({
          abi: artifact.abi,
          bytecode: artifact.bytecode,
          args: arguments_,
        } as never)
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        if (receipt.contractAddress === null) throw new Error('Deployment did not return a contract address')
        return receipt.contractAddress
      }
      const send = async (
        wallet: typeof evaluatorWallet,
        address: Address,
        abi: Abi,
        functionName: string,
        arguments_: readonly unknown[],
      ): Promise<void> => {
        const hash = await wallet.writeContract({ address, abi, functionName, args: arguments_ } as never)
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        if (receipt.status !== 'success') throw new Error(`${functionName} transaction reverted`)
      }

      const registryAddress = await deploy(artifacts.registry)
      const profileAddress = await deploy(artifacts.profile, [registryAddress])
      const verifierAddress = await deploy(artifacts.verifier)
      const workflowAddress = await deploy(artifacts.workflow, [profileAddress, verifierAddress, BigInt(evaluatorAgentId)])

      await send(evaluatorWallet, registryAddress, artifacts.registry.abi, 'register', [BigInt(evaluatorAgentId)])
      await send(evaluatorWallet, profileAddress, artifacts.profile.abi, 'join', [
        BigInt(evaluatorAgentId), '{"role":"evaluator"}', verifierAddress,
      ])
      await send(contributorWallet, registryAddress, artifacts.registry.abi, 'register', [BigInt(contributorAgentId)])
      await send(contributorWallet, profileAddress, artifacts.profile.abi, 'join', [
        BigInt(contributorAgentId), '{"role":"contributor"}', verifierAddress,
      ])

      const createGate = (): WorkflowVerificationGate => ({
        async assertCurrent(): Promise<VerifiedWorkflowContext> {
          const block = await publicClient.getBlock()
          if (block.hash === null) throw new Error('Latest Anvil block has no hash')
          return {
            chainId: '31337',
            rpcUrl: anvil.rpcUrl,
            workflowAddress,
            blockSelector: { kind: 'block_hash', blockHash: block.hash },
            fingerprint: emptyFingerprint,
          }
        },
      })
      const createMemberResolver = (): WorkflowMemberResolver => ({
        async getAgent(agentId, selector) {
          const [isMember, data, agentVerifier] = await publicClient.readContract({
            address: profileAddress,
            abi: artifacts.profile.abi,
            functionName: 'getAgent',
            args: [BigInt(agentId)],
            blockHash: selector.blockHash,
          } as never) as readonly [boolean, string, Address]
          const authenticationWallet = await publicClient.readContract({
            address: registryAddress,
            abi: artifacts.registry.abi,
            functionName: 'getAgentWallet',
            args: [BigInt(agentId)],
            blockHash: selector.blockHash,
          } as never) as Address
          const block = await publicClient.getBlock({ blockHash: selector.blockHash })
          return {
            data: {
              agent_id: agentId,
              is_member: isMember,
              data: JSON.parse(data) as Readonly<Record<string, string>>,
              agent_verifier: agentVerifier,
              authentication_wallet: authenticationWallet,
            },
            resolution: {
              chain: { block_number: block.number.toString(), block_hash: selector.blockHash },
              profile: { version: '1' },
            },
          }
        },
      })
      const manifest = getManifestRegistry()
      const createAgentService = (agentId: string) => createWorkflowOperationService({
        agentId,
        gate: createGate(),
        registry: manifest,
        memberResolver: createMemberResolver(),
        contractAddressResolver: createWorkflowContractAddressResolver(),
        client: createAgentSdkBindingClient(manifest.list('agent-sdk')),
      })
      const evaluatorService = createAgentService(evaluatorAgentId)
      const contributorService = createAgentService(contributorAgentId)

      const runInput = stringToHex('Demo contribution round')
      const latestBeforeRun = await publicClient.getBlock()
      const runResult = await evaluatorService.invoke({
        toolName: 'workflow.execution.erc8301.agent_workflow.run',
        arguments: {
          inputHash: keccak256(runInput),
          input: runInput,
          expiresAt: (latestBeforeRun.timestamp + 3_600n).toString(),
          credential: { type: 'inline', secret: evaluatorPrivateKey },
        },
      }) as Readonly<{ workflowRunId: Hex; taskHash: Hex; stage: number }>
      expect(runResult.stage).toBe(0)

      const collectResult = await contributorService.invoke({
        toolName: 'workflow.execution.erc8301.agent_workflow.get_task',
        arguments: { taskHash: runResult.taskHash },
      }) as Readonly<{ proven: boolean; task: Readonly<{ timestamp: string; workflowRunId: Hex }> }>
      expect(collectResult).toMatchObject({ proven: true, task: { workflowRunId: runResult.workflowRunId } })

      const da = inMemoryDa()
      const exactContributionBytes = new TextEncoder().encode(JSON.stringify({
        agent_id: contributorAgentId,
        kind: 'contribution',
        summary: 'Anchored through the generated ERC-8301 binding.',
      }))
      const put = await da.put({
        content: { encoding: 'base64', value: Buffer.from(exactContributionBytes).toString('base64') },
        destination: { path: 'data/rounds/1/contribution.json' },
      })
      const loaded = await da.get({ ref: put.ref })
      const loadedBytes = new Uint8Array(Buffer.from(loaded.content.value, 'base64'))
      expect(loadedBytes).toEqual(exactContributionBytes)
      const daDigest = keccak256(toHex(loadedBytes))
      const daReferenceBytes = new TextEncoder().encode(JSON.stringify(put.ref))
      const daReference = toHex(daReferenceBytes)
      const contributionId = keccak256(encodeAbiParameters(
        [{ type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes32' }],
        [workflowAddress, runResult.workflowRunId, BigInt(contributorAgentId), daDigest],
      ))
      const contributionOutput = encodeAbiParameters(
        [
          { type: 'uint8' },
          { type: 'uint256' },
          { type: 'bytes32' },
          { type: 'bytes32' },
          { type: 'bytes' },
          { type: 'bytes32' },
        ],
        [0, BigInt(contributorAgentId), runResult.workflowRunId, contributionId, daReference, daDigest],
      )
      const outputHash = keccak256(contributionOutput)
      const reply = {
        outputHash,
        output: contributionOutput,
        timestamp: collectResult.task.timestamp,
        replier: contributor.address,
        prevTaskHashes: [runResult.taskHash],
        workflowRunId: runResult.workflowRunId,
      }

      const replyHash = await contributorService.invoke({
        toolName: 'workflow.execution.erc8301.recompute.compute_reply_hash',
        arguments: {
          outputHash,
          timestamp: collectResult.task.timestamp,
          replier: contributor.address,
          prevTaskHashesPacked: runResult.taskHash,
          workflowRunId: runResult.workflowRunId,
        },
      }) as Hex
      await expect(contributorService.invoke({
        toolName: 'workflow.execution.erc8301.agent_workflow.on_agent_reply',
        arguments: {
          reply,
          credential: { type: 'inline', secret: contributorPrivateKey },
        },
      })).resolves.toBeNull()

      const anchoredReply = await contributorService.invoke({
        toolName: 'workflow.execution.erc8301.agent_workflow.get_reply',
        arguments: { replyHash },
      }) as Readonly<{ verifier: Address }>
      expect(anchoredReply).toMatchObject({
        proven: true,
        reply: { output: contributionOutput, outputHash, workflowRunId: runResult.workflowRunId },
      })
      expect(anchoredReply.verifier.toLowerCase()).toBe(verifierAddress.toLowerCase())

      const contribution = await publicClient.readContract({
        address: workflowAddress,
        abi: artifacts.workflow.abi,
        functionName: 'getContribution',
        args: [contributionId],
      } as never) as Readonly<{
        exists: boolean
        roundId: Hex
        contributorAgentId: bigint
        daReference: Hex
        daDigest: Hex
        submitReplyHash: Hex
      }>
      expect(contribution).toMatchObject({
        exists: true,
        roundId: runResult.workflowRunId,
        contributorAgentId: BigInt(contributorAgentId),
        daReference,
        daDigest,
        submitReplyHash: replyHash,
      })
      expect(JSON.parse(Buffer.from(contribution.daReference.slice(2), 'hex').toString('utf8'))).toEqual(put.ref)
      expect(contribution.daDigest).toBe(keccak256(toHex(exactContributionBytes)))
    } finally {
      await anvil.stop()
    }
  }, 90_000)
})
