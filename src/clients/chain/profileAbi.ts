import { parseAbi, toFunctionSelector, type Hex } from 'viem'

export const erc165Abi = parseAbi([
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
])

export const erc721OwnerAbi = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address owner)',
])

export const erc8004IdentityRegistryAbi = parseAbi([
  'function getAgentWallet(uint256 agentId) view returns (address wallet)',
])

export const tawgProfileAbi = parseAbi([
  'function version() view returns (uint256)',
  'function governance() view returns (address)',
  'function pendingGovernance() view returns (address)',
  'function identityRegistry() view returns (address)',
  'function getCharter() view returns ((string repository, string commitHash, string path))',
  'function agentCount() view returns (uint256)',
  'function agentIdAt(uint256 index) view returns (uint256 agentId)',
  'function getAgent(uint256 agentId) view returns (bool isMember, string data, address agentVerifier)',
  'function dataCount() view returns (uint256)',
  'function dataKeyAt(uint256 index) view returns (string key)',
  'function getData(string key) view returns (bool exists, string data)',
  'function getWorkflow() view returns (address workflowAddress, string data)',
  'function registerAgent(uint256 agentId, string data, address agentVerifier)',
  'function updateAgent(uint256 agentId, string data, address agentVerifier)',
  'function updateCharter((string repository, string commitHash, string path) newCharter)',
  'function setData(string key, string data)',
  'function removeData(string key)',
  'function updateWorkflow(address workflowAddress, string data)',
  'function transferGovernance(address newGovernance)',
  'function cancelGovernanceTransfer()',
  'function acceptGovernance()',
  'event ProfileCreated(uint256 indexed version, address indexed governance, address indexed identityRegistry)',
  'event CharterUpdated(uint256 indexed version, string oldRepository, string oldCommitHash, string oldPath, string newRepository, string newCommitHash, string newPath)',
  'event AgentRegistered(uint256 indexed version, uint256 indexed agentId, address indexed authenticationWallet, address agentVerifier, bytes32 dataHash)',
  'event AgentUpdated(uint256 indexed version, uint256 indexed agentId, address indexed authenticationWallet, address oldAgentVerifier, address newAgentVerifier, bytes32 oldDataHash, bytes32 newDataHash)',
  'event DataSet(uint256 indexed version, bytes32 indexed keyHash, string key, bytes32 oldDataHash, bytes32 newDataHash, bool created)',
  'event DataRemoved(uint256 indexed version, bytes32 indexed keyHash, string key, bytes32 oldDataHash)',
  'event WorkflowUpdated(uint256 indexed version, address indexed oldWorkflow, address indexed newWorkflow, bytes32 oldDataHash, bytes32 newDataHash)',
  'event GovernanceTransferStarted(address indexed governance, address indexed pendingGovernance)',
  'event GovernanceTransferCancelled(address indexed governance, address indexed cancelledGovernance)',
  'event GovernanceTransferred(uint256 indexed version, address indexed oldGovernance, address indexed newGovernance)',
  'error UnauthorizedGovernance(address caller)',
  'error ZeroAddress()',
  'error AddressHasNoCode(address value)',
  'error NoChange()',
  'error InvalidCharterReference()',
  'error InvalidDataKey(string key)',
  'error AgentIdentityNotFound(uint256 agentId)',
  'error AgentAlreadyMember(uint256 agentId)',
  'error AgentNotMember(uint256 agentId)',
  'error AgentWalletUnset(uint256 agentId)',
  'error UnauthorizedAgent(uint256 agentId, address caller, address authenticationWallet)',
  'error DataNotFound(bytes32 keyHash)',
  'error IndexOutOfBounds(uint256 index, uint256 count)',
  'error NotPendingGovernance(address caller)',
])

const tawgProfileFunctionSignatures = [
  'version()',
  'governance()',
  'pendingGovernance()',
  'identityRegistry()',
  'getCharter()',
  'agentCount()',
  'agentIdAt(uint256)',
  'getAgent(uint256)',
  'dataCount()',
  'dataKeyAt(uint256)',
  'getData(string)',
  'getWorkflow()',
  'registerAgent(uint256,string,address)',
  'updateAgent(uint256,string,address)',
  'updateCharter((string,string,string))',
  'setData(string,string)',
  'removeData(string)',
  'updateWorkflow(address,string)',
  'transferGovernance(address)',
  'cancelGovernanceTransfer()',
  'acceptGovernance()',
] as const

function computeInterfaceId(signatures: readonly string[]): Hex {
  let interfaceId = 0
  for (const signature of signatures) interfaceId ^= Number.parseInt(toFunctionSelector(signature).slice(2), 16)
  return `0x${(interfaceId >>> 0).toString(16).padStart(8, '0')}`
}

export const tawgProfileInterfaceId = computeInterfaceId(tawgProfileFunctionSignatures)
