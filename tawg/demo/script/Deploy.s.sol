// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {PassThroughVerifier} from "../contracts/PassThroughVerifier.sol";
import {Workflow} from "../contracts/Workflow.sol";

interface IDeploymentIdentityRegistry {
    function ownerOf(uint256 agentId) external view returns (address);

    function getAgentWallet(uint256 agentId) external view returns (address);
}

/// @notice Narrow local fixture used to exercise the Demo's circular Profile/Workflow addresses.
/// @dev This fixture deliberately does not claim ERC-165 or a future production TAWG Profile ABI.
contract DemoProfileFixture {
    error IdentityNotFound(uint256 agentId);
    error AuthenticationWalletUnset(uint256 agentId);
    error WrongAuthenticationWallet(uint256 agentId, address expected, address actual);
    error InvalidAgentVerifier(address verifier);

    event AgentRegistered(uint256 indexed agentId, string data, address verifier);

    struct AgentRecord {
        bool isMember;
        string data;
        address verifier;
    }

    address public immutable identityRegistry;
    address public immutable workflow;

    mapping(uint256 agentId => AgentRecord record) private _agents;

    constructor(address identityRegistry_, address workflow_) {
        identityRegistry = identityRegistry_;
        workflow = workflow_;
    }

    function getAgent(uint256 agentId) external view returns (bool isMember, string memory data, address verifier) {
        AgentRecord storage record = _agents[agentId];
        return (record.isMember, record.data, record.verifier);
    }

    /// @notice Register or update only the caller's own live ERC-8004 identity.
    function registerSelf(uint256 agentId, string calldata data, address verifier) external {
        IDeploymentIdentityRegistry registry = IDeploymentIdentityRegistry(identityRegistry);
        try registry.ownerOf(agentId) returns (address owner) {
            if (owner == address(0)) revert IdentityNotFound(agentId);
        } catch {
            revert IdentityNotFound(agentId);
        }

        address expectedWallet = registry.getAgentWallet(agentId);
        if (expectedWallet == address(0)) revert AuthenticationWalletUnset(agentId);
        if (msg.sender != expectedWallet) {
            revert WrongAuthenticationWallet(agentId, expectedWallet, msg.sender);
        }
        if (verifier.code.length == 0) revert InvalidAgentVerifier(verifier);

        _agents[agentId] = AgentRecord({isMember: true, data: data, verifier: verifier});
        emit AgentRegistered(agentId, data, verifier);
    }
}

/// @notice One-shot factory that proves the Demo's fixed CREATE nonce deployment sequence.
contract DemoDeployer {
    error AlreadyDeployed();
    error RegistryCodeRequired();
    error MissingEvaluatorIdentity(uint256 agentId);
    error EvaluatorAuthenticationWalletUnset(uint256 agentId);
    error ProfileAddressPredictionFailed(address expected, address actual);
    error DeploymentInvariantFailed();

    bool private _deployed;

    function predictProfileFixture() public view returns (address) {
        // The factory's third child CREATE uses RLP([factory, 3]).
        return address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", address(this), hex"03")))));
    }

    function deploy(address identityRegistry, uint256 evaluatorAgentId)
        external
        returns (address verifierAddress, address workflowAddress, address profileAddress)
    {
        if (_deployed) revert AlreadyDeployed();
        _deployed = true;
        if (identityRegistry.code.length == 0) revert RegistryCodeRequired();

        IDeploymentIdentityRegistry registry = IDeploymentIdentityRegistry(identityRegistry);
        try registry.ownerOf(evaluatorAgentId) returns (address owner) {
            if (owner == address(0)) revert MissingEvaluatorIdentity(evaluatorAgentId);
        } catch {
            revert MissingEvaluatorIdentity(evaluatorAgentId);
        }
        address evaluatorWallet = registry.getAgentWallet(evaluatorAgentId);
        if (evaluatorWallet == address(0)) revert EvaluatorAuthenticationWalletUnset(evaluatorAgentId);

        address predictedProfile = predictProfileFixture();

        PassThroughVerifier verifier = new PassThroughVerifier(); // child CREATE nonce 1
        Workflow workflow = new Workflow(predictedProfile, address(verifier), evaluatorAgentId); // child nonce 2
        DemoProfileFixture profile = new DemoProfileFixture(identityRegistry, address(workflow)); // child nonce 3

        verifierAddress = address(verifier);
        workflowAddress = address(workflow);
        profileAddress = address(profile);
        if (profileAddress != predictedProfile) {
            revert ProfileAddressPredictionFailed(predictedProfile, profileAddress);
        }
        if (
            identityRegistry.code.length == 0 || verifierAddress.code.length == 0
                || workflow.profile() != profileAddress || workflow.passThroughVerifier() != verifierAddress
                || workflow.evaluatorAgentId() != evaluatorAgentId || profile.identityRegistry() != identityRegistry
                || profile.workflow() != workflowAddress
        ) revert DeploymentInvariantFailed();
    }
}

interface IForgeScriptVm {
    function startBroadcast() external;

    function stopBroadcast() external;
}

/// @notice Foundry wrapper for one deterministic local Demo deployment.
contract Deploy {
    IForgeScriptVm private constant VM = IForgeScriptVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run(address identityRegistry, uint256 evaluatorAgentId)
        external
        returns (address verifierAddress, address workflowAddress, address profileAddress)
    {
        VM.startBroadcast();
        DemoDeployer deployer = new DemoDeployer();
        (verifierAddress, workflowAddress, profileAddress) = deployer.deploy(identityRegistry, evaluatorAgentId);
        VM.stopBroadcast();
    }
}
