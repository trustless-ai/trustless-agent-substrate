// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {AgentTask} from "@agent-ercs/execution/ERC8301/IAgentWorkflow.sol";
import {PassThroughVerifier} from "../contracts/PassThroughVerifier.sol";
import {Workflow} from "../contracts/Workflow.sol";
import {DemoDeployer, DemoProfileFixture} from "../script/Deploy.s.sol";
import {TestBase} from "./TestBase.sol";

contract DeploymentRegistryFixture {
    error NonexistentAgent(uint256 agentId);

    mapping(uint256 agentId => address owner) private _owners;
    mapping(uint256 agentId => address wallet) private _wallets;

    function register(uint256 agentId, address owner, address wallet) external {
        _owners[agentId] = owner;
        _wallets[agentId] = wallet;
    }

    function setAgentWallet(uint256 agentId, address wallet) external {
        _wallets[agentId] = wallet;
    }

    function ownerOf(uint256 agentId) external view returns (address owner) {
        owner = _owners[agentId];
        if (owner == address(0)) revert NonexistentAgent(agentId);
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        return _wallets[agentId];
    }
}

contract DemoDeploymentTest is TestBase {
    uint256 private constant EVALUATOR_AGENT_ID = 9_007_199_254_740_993_000_000_001;
    address private constant EVALUATOR_OWNER = address(0xE001);
    address private constant EVALUATOR_WALLET = address(0xE0A1);

    DeploymentRegistryFixture private registry;
    DemoDeployer private deployer;

    function setUp() public {
        VM.warp(1_000_000);
        registry = new DeploymentRegistryFixture();
        deployer = new DemoDeployer();
    }

    function testPredictsCircularProfileAddressAndBindsEveryCrossReference() public {
        registry.register(EVALUATOR_AGENT_ID, EVALUATOR_OWNER, EVALUATOR_WALLET);
        address predictedProfile = deployer.predictProfileFixture();

        (address verifierAddress, address workflowAddress, address profileAddress) =
            deployer.deploy(address(registry), EVALUATOR_AGENT_ID);

        Workflow workflow = Workflow(workflowAddress);
        DemoProfileFixture profile = DemoProfileFixture(profileAddress);
        assertEq(profileAddress, predictedProfile);
        assertTrue(verifierAddress.code.length > 0);
        assertEq(keccak256(verifierAddress.code), keccak256(type(PassThroughVerifier).runtimeCode));
        assertTrue(workflowAddress.code.length > 0);
        assertTrue(profileAddress.code.length > 0);
        assertEq(workflow.profile(), profileAddress);
        assertEq(workflow.passThroughVerifier(), verifierAddress);
        assertEq(workflow.evaluatorAgentId(), EVALUATOR_AGENT_ID);
        assertEq(profile.identityRegistry(), address(registry));
        assertEq(profile.workflow(), workflowAddress);

        (bool isMember,,) = profile.getAgent(EVALUATOR_AGENT_ID);
        assertFalse(isMember);
    }

    function testRejectsRegistryWithoutCode() public {
        VM.expectRevert(DemoDeployer.RegistryCodeRequired.selector);
        deployer.deploy(address(0xBEEF), EVALUATOR_AGENT_ID);
    }

    function testRejectsMissingEvaluatorIdentity() public {
        VM.expectRevert(abi.encodeWithSelector(DemoDeployer.MissingEvaluatorIdentity.selector, EVALUATOR_AGENT_ID));
        deployer.deploy(address(registry), EVALUATOR_AGENT_ID);
    }

    function testRejectsUnsetEvaluatorAuthenticationWallet() public {
        registry.register(EVALUATOR_AGENT_ID, EVALUATOR_OWNER, address(0));

        VM.expectRevert(
            abi.encodeWithSelector(DemoDeployer.EvaluatorAuthenticationWalletUnset.selector, EVALUATOR_AGENT_ID)
        );
        deployer.deploy(address(registry), EVALUATOR_AGENT_ID);
    }

    function testFactoryIsOneShot() public {
        registry.register(EVALUATOR_AGENT_ID, EVALUATOR_OWNER, EVALUATOR_WALLET);
        deployer.deploy(address(registry), EVALUATOR_AGENT_ID);

        VM.expectRevert(DemoDeployer.AlreadyDeployed.selector);
        deployer.deploy(address(registry), EVALUATOR_AGENT_ID);
    }

    function testEvaluatorSelfRegistersAndStartsInitialRound() public {
        registry.register(EVALUATOR_AGENT_ID, EVALUATOR_OWNER, EVALUATOR_WALLET);
        (address verifierAddress, address workflowAddress, address profileAddress) =
            deployer.deploy(address(registry), EVALUATOR_AGENT_ID);
        Workflow workflow = Workflow(workflowAddress);
        DemoProfileFixture profile = DemoProfileFixture(profileAddress);

        VM.prank(EVALUATOR_WALLET);
        profile.registerSelf(EVALUATOR_AGENT_ID, "{\"role\":\"evaluator\"}", verifierAddress);
        (bool isMember, string memory data,) = profile.getAgent(EVALUATOR_AGENT_ID);
        assertTrue(isMember);
        assertTrue(keccak256(bytes(data)) == keccak256(bytes("{\"role\":\"evaluator\"}")));

        bytes memory input = bytes("first round");
        VM.prank(EVALUATOR_WALLET);
        bytes32 roundId = workflow.run(keccak256(input), input, block.timestamp + 7 days);
        Workflow.RoundView memory round = workflow.getRound(roundId);
        (AgentTask memory collectTask, bool proven) = workflow.getAgentTask(round.collectTaskHash);
        assertTrue(round.exists);
        assertEq(collectTask.workflowRunId, roundId);
        assertTrue(proven);
    }

    function testSelfRegistrationUsesCurrentWalletAndCannotRegisterAnotherAgent() public {
        uint256 otherAgentId = EVALUATOR_AGENT_ID + 1;
        address otherWallet = address(0xB0B);
        registry.register(EVALUATOR_AGENT_ID, EVALUATOR_OWNER, EVALUATOR_WALLET);
        registry.register(otherAgentId, address(0xB001), otherWallet);
        (,, address profileAddress) = deployer.deploy(address(registry), EVALUATOR_AGENT_ID);
        DemoProfileFixture profile = DemoProfileFixture(profileAddress);

        VM.prank(EVALUATOR_WALLET);
        VM.expectRevert(
            abi.encodeWithSelector(
                DemoProfileFixture.WrongAuthenticationWallet.selector, otherAgentId, otherWallet, EVALUATOR_WALLET
            )
        );
        profile.registerSelf(otherAgentId, "{}", address(0));

        registry.setAgentWallet(EVALUATOR_AGENT_ID, otherWallet);
        VM.prank(EVALUATOR_WALLET);
        VM.expectRevert(
            abi.encodeWithSelector(
                DemoProfileFixture.WrongAuthenticationWallet.selector, EVALUATOR_AGENT_ID, otherWallet, EVALUATOR_WALLET
            )
        );
        profile.registerSelf(EVALUATOR_AGENT_ID, "{}", address(0));
    }

    function testSelfRegistrationRequiresADeployedAgentVerifier() public {
        registry.register(EVALUATOR_AGENT_ID, EVALUATOR_OWNER, EVALUATOR_WALLET);
        (,, address profileAddress) = deployer.deploy(address(registry), EVALUATOR_AGENT_ID);
        DemoProfileFixture profile = DemoProfileFixture(profileAddress);

        VM.prank(EVALUATOR_WALLET);
        VM.expectRevert(abi.encodeWithSelector(DemoProfileFixture.InvalidAgentVerifier.selector, address(0)));
        profile.registerSelf(EVALUATOR_AGENT_ID, "{}", address(0));
    }
}
