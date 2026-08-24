// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

contract IdentityRegistryFixture {
    uint256 private nextAgentId = 9007199254740993;
    mapping(uint256 => address) private owners;
    mapping(uint256 => address) private wallets;
    uint256 public registrationCount;

    event Registered(uint256 indexed agentId, address indexed owner, string agentURI, bytes metadata);
    event AgentWalletEstablished(uint256 indexed agentId, address indexed wallet);

    function register(string calldata agentURI, bytes calldata metadata) external returns (uint256 agentId) {
        agentId = nextAgentId++;
        owners[agentId] = msg.sender;
        registrationCount += 1;
        emit Registered(agentId, msg.sender, agentURI, metadata);
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        address owner = owners[agentId];
        require(owner != address(0), "unknown agent");
        return owner;
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        return wallets[agentId];
    }

    function establishAgentWallet(uint256 agentId) external {
        require(owners[agentId] == msg.sender, "not owner");
        require(wallets[agentId] == address(0), "wallet exists");
        wallets[agentId] = msg.sender;
        emit AgentWalletEstablished(agentId, msg.sender);
    }
}

interface IIdentityRegistryFixture {
    function ownerOf(uint256 agentId) external view returns (address);
    function getAgentWallet(uint256 agentId) external view returns (address);
}

contract TawgProfileFixture {
    struct Charter { string repository; string commitHash; string path; }
    struct Member { bool isMember; string data; address verifier; }
    IIdentityRegistryFixture public immutable registry;
    uint256 public immutable evaluatorAgentId;
    mapping(uint256 => Member) private members;
    uint256[] private ids;

    constructor(address identityRegistry, uint256 evaluator) {
        registry = IIdentityRegistryFixture(identityRegistry);
        evaluatorAgentId = evaluator;
    }

    function supportsInterface(bytes4) external pure returns (bool) { return true; }
    function version() external pure returns (uint256) { return 1; }
    function governance() external view returns (address) { return address(this); }
    function identityRegistry() external view returns (address) { return address(registry); }
    function getCharter() external pure returns (Charter memory) { return Charter("https://github.com/trustless-ai/fixture", "0000000000000000000000000000000000000000", "charter/"); }
    function agentCount() external view returns (uint256) { return ids.length; }
    function agentIdAt(uint256 index) external view returns (uint256) { return ids[index]; }
    function dataCount() external pure returns (uint256) { return 0; }
    function getWorkflow() external view returns (address, string memory) { return (address(this), "{}"); }
    function getAgent(uint256 agentId) external view returns (bool, string memory, address) {
        Member memory member = members[agentId];
        return (member.isMember, member.data, member.verifier);
    }

    function registerAgent(uint256 agentId, string calldata data, address agentVerifier) external {
        require(!members[agentId].isMember, "already member");
        require(registry.ownerOf(agentId) == msg.sender, "not owner");
        address wallet = registry.getAgentWallet(agentId);
        require(wallet != address(0), "wallet unset");
        require(wallet == msg.sender, "wallet mismatch");
        require(agentVerifier.code.length != 0, "invalid verifier");
        members[agentId] = Member(true, data, agentVerifier);
        ids.push(agentId);
    }
}
