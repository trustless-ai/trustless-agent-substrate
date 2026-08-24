import { describe, expect, it } from 'vitest'
import { toFunctionSelector, type AbiFunction } from 'viem'

import {
  erc165Abi,
  erc721OwnerAbi,
  erc8004IdentityRegistryAbi,
  tawgProfileAbi,
  tawgProfileInterfaceId,
} from '../../../src/clients/chain/profileAbi.js'

const profileFunctionSignatures = [
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

function xorSelectors(signatures: readonly (string | AbiFunction)[]): `0x${string}` {
  let interfaceId = 0
  for (const signature of signatures) interfaceId ^= Number.parseInt(toFunctionSelector(signature).slice(2), 16)
  return `0x${(interfaceId >>> 0).toString(16).padStart(8, '0')}`
}

describe('fixed Profile ABIs', () => {
  it('computes the ITAWGProfile ERC-165 interface ID from every documented function selector', () => {
    const abiFunctions = tawgProfileAbi.filter((item): item is AbiFunction => item.type === 'function')
    expect(new Set(abiFunctions.map(toFunctionSelector))).toEqual(new Set(profileFunctionSignatures.map(toFunctionSelector)))
    expect(xorSelectors(abiFunctions)).toBe(xorSelectors(profileFunctionSignatures))
    expect(tawgProfileInterfaceId).toBe(xorSelectors(abiFunctions))
  })

  it('includes permanent registration/update and excludes obsolete removable membership entries', () => {
    const names = tawgProfileAbi.map((item) => item.name)
    expect(names).toContain('registerAgent')
    expect(names).toContain('updateAgent')
    expect(names).toContain('AgentRegistered')
    expect(names).toContain('AgentUpdated')
    expect(names).not.toContain('addAgent')
    expect(names).not.toContain('removeAgent')
    expect(names).not.toContain('AgentAdded')
    expect(names).not.toContain('AgentRemoved')
  })

  it('contains the exact supporting read functions', () => {
    expect(erc165Abi.map((item) => item.name)).toEqual(['supportsInterface'])
    expect(erc721OwnerAbi.map((item) => item.name)).toEqual(['ownerOf'])
    expect(erc8004IdentityRegistryAbi.map((item) => item.name)).toEqual(['getAgentWallet'])
  })
})
