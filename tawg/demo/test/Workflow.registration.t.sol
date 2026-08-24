// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {AgentReply, AgentTask} from "@agent-ercs/execution/ERC8301/IAgentWorkflow.sol";
import {PassThroughVerifier} from "../contracts/PassThroughVerifier.sol";
import {Workflow} from "../contracts/Workflow.sol";
import {TestBase} from "./TestBase.sol";

contract RegistrationRegistry {
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

contract RegistrationProfile {
    address private _identityRegistry;

    struct AgentRecord {
        bool isMember;
        string data;
        address verifier;
    }

    mapping(uint256 agentId => AgentRecord record) private _agents;

    constructor(address identityRegistry_) {
        _identityRegistry = identityRegistry_;
    }

    function identityRegistry() external view returns (address) {
        return _identityRegistry;
    }

    function getAgent(uint256 agentId) external view returns (bool isMember, string memory data, address verifier) {
        AgentRecord storage record = _agents[agentId];
        return (record.isMember, record.data, record.verifier);
    }

    function setAgent(uint256 agentId, bool isMember, string calldata data, address agentVerifier) external {
        _agents[agentId] = AgentRecord({isMember: isMember, data: data, verifier: agentVerifier});
    }
}

contract WorkflowRegistrationTest is TestBase {
    uint256 private constant AGENT_ID = 9_007_199_254_740_993_123_456_789;
    uint256 private constant EVALUATOR_AGENT_ID = 9_007_199_254_740_993_000_000_001;
    address private constant OWNER = address(0x0A11);
    address private constant EVALUATOR_WALLET = address(0xE0A1);
    address private constant WALLET_A = address(0xA11CE);
    address private constant WALLET_B = address(0xB0B);

    RegistrationRegistry private registry;
    RegistrationProfile private profile;
    PassThroughVerifier private verifier;
    Workflow private workflow;
    bytes32 private roundId;
    bytes32 private collectTaskHash;

    function setUp() public {
        VM.warp(1_000_000);
        registry = new RegistrationRegistry();
        profile = new RegistrationProfile(address(registry));
        verifier = new PassThroughVerifier();
        workflow = new Workflow(address(profile), address(verifier), EVALUATOR_AGENT_ID);
        registry.register(EVALUATOR_AGENT_ID, OWNER, EVALUATOR_WALLET);
        profile.setAgent(EVALUATOR_AGENT_ID, true, "{}", address(verifier));
        (roundId, collectTaskHash) = _startRun();
    }

    function testRejectsNonexistentERC8004IdentityBeforeMembership() public {
        profile.setAgent(AGENT_ID, true, "{\"role\":\"contributor\"}", address(verifier));
        AgentReply memory reply = _contributionReply(WALLET_A, keccak256("missing"), bytes("git:missing"));

        VM.prank(WALLET_A);
        VM.expectRevert(abi.encodeWithSelector(Workflow.IdentityNotFound.selector, AGENT_ID));
        workflow.onAgentReply(reply);
    }

    function testRejectsExistingIdentityThatIsNotProfileMember() public {
        registry.register(AGENT_ID, OWNER, WALLET_A);
        AgentReply memory reply = _contributionReply(WALLET_A, keccak256("nonmember"), bytes("git:nonmember"));

        VM.prank(WALLET_A);
        VM.expectRevert(abi.encodeWithSelector(Workflow.NotProfileMember.selector, AGENT_ID));
        workflow.onAgentReply(reply);
    }

    function testRejectsMemberWithUnsetAuthenticationWallet() public {
        registry.register(AGENT_ID, OWNER, address(0));
        profile.setAgent(AGENT_ID, true, "{}", address(verifier));
        AgentReply memory reply = _contributionReply(WALLET_A, keccak256("unset"), bytes("git:unset"));

        VM.prank(WALLET_A);
        VM.expectRevert(abi.encodeWithSelector(Workflow.AuthenticationWalletUnset.selector, AGENT_ID));
        workflow.onAgentReply(reply);
    }

    function testRejectsWalletOtherThanCurrentAuthenticationWallet() public {
        _registerMember(WALLET_A);
        AgentReply memory reply = _contributionReply(WALLET_B, keccak256("wrong"), bytes("git:wrong"));

        VM.prank(WALLET_B);
        VM.expectRevert(
            abi.encodeWithSelector(Workflow.WrongAuthenticationWallet.selector, AGENT_ID, WALLET_A, WALLET_B)
        );
        workflow.onAgentReply(reply);
    }

    function testCurrentAuthenticationWalletSubmitsSuccessfully() public {
        _registerMember(WALLET_A);
        bytes32 digest = keccak256("accepted");
        bytes32 contributionId = _contributionId(digest);

        VM.prank(WALLET_A);
        workflow.onAgentReply(_contributionReply(WALLET_A, digest, bytes("git:accepted")));

        Workflow.ContributionView memory contribution = workflow.getContribution(contributionId);
        assertTrue(contribution.exists);
        assertEq(contribution.contributorAgentId, AGENT_ID);
    }

    function testWalletRotationImmediatelyAuthorizesNewWalletAndRejectsOldWallet() public {
        _registerMember(WALLET_A);
        registry.setAgentWallet(AGENT_ID, WALLET_B);

        AgentReply memory oldWalletReply =
            _contributionReply(WALLET_A, keccak256("old-wallet"), bytes("git:old-wallet"));
        VM.prank(WALLET_A);
        VM.expectRevert(
            abi.encodeWithSelector(Workflow.WrongAuthenticationWallet.selector, AGENT_ID, WALLET_B, WALLET_A)
        );
        workflow.onAgentReply(oldWalletReply);

        bytes32 newDigest = keccak256("new-wallet");
        VM.prank(WALLET_B);
        workflow.onAgentReply(_contributionReply(WALLET_B, newDigest, bytes("git:new-wallet")));
        assertTrue(workflow.getContribution(_contributionId(newDigest)).exists);
    }

    function testWalletRotationPreservesFullERC8004IdentityInVerifierPreimage() public {
        _registerMember(WALLET_A);
        AgentReply memory firstReply =
            _contributionReply(WALLET_A, keccak256("before rotation"), bytes("git:before-rotation"));
        VM.prank(WALLET_A);
        workflow.onAgentReply(firstReply);

        registry.setAgentWallet(AGENT_ID, WALLET_B);
        AgentReply memory secondReply =
            _contributionReply(WALLET_B, keccak256("after rotation"), bytes("git:after-rotation"));
        VM.prank(WALLET_B);
        workflow.onAgentReply(secondReply);

        (AgentTask memory collectTask,) = workflow.getAgentTask(collectTaskHash);
        (,,, bytes32 firstVerificationDigest) = workflow.getAgentReply(_replyHash(firstReply));
        (,,, bytes32 secondVerificationDigest) = workflow.getAgentReply(_replyHash(secondReply));
        bytes32 expectedFirst = keccak256(
            abi.encode(
                collectTaskHash,
                bytes32(AGENT_ID),
                collectTask.inputHash,
                firstReply.outputHash,
                true,
                address(verifier)
            )
        );
        bytes32 expectedSecond = keccak256(
            abi.encode(
                collectTaskHash,
                bytes32(AGENT_ID),
                collectTask.inputHash,
                secondReply.outputHash,
                true,
                address(verifier)
            )
        );

        assertEq(firstVerificationDigest, expectedFirst);
        assertEq(secondVerificationDigest, expectedSecond);
    }

    function testProfileDataAndVerifierChangesDoNotReplaceWalletAuthority() public {
        _registerMember(WALLET_A);
        profile.setAgent(AGENT_ID, true, "{\"updated\":true}", address(0xCAFE));

        bytes32 acceptedDigest = keccak256("profile-update");
        VM.prank(WALLET_A);
        workflow.onAgentReply(_contributionReply(WALLET_A, acceptedDigest, bytes("git:profile-update")));
        assertTrue(workflow.getContribution(_contributionId(acceptedDigest)).exists);

        AgentReply memory wrongWalletReply =
            _contributionReply(WALLET_B, keccak256("profile-wrong"), bytes("git:profile-wrong"));
        VM.prank(WALLET_B);
        VM.expectRevert(
            abi.encodeWithSelector(Workflow.WrongAuthenticationWallet.selector, AGENT_ID, WALLET_A, WALLET_B)
        );
        workflow.onAgentReply(wrongWalletReply);
    }

    function _registerMember(address wallet) private {
        registry.register(AGENT_ID, OWNER, wallet);
        profile.setAgent(AGENT_ID, true, "{}", address(verifier));
    }

    function _startRun() private returns (bytes32 run, bytes32 taskHash) {
        bytes memory input = bytes("demo round");
        bytes32 inputHash = keccak256(input);
        uint256 expiresAt = block.timestamp + 7 days;
        VM.prank(EVALUATOR_WALLET);
        run = workflow.run(inputHash, input, expiresAt);
        bytes32[] memory previousReplies = new bytes32[](0);
        taskHash = keccak256(
            abi.encode(
                uint8(0),
                uint256(0),
                inputHash,
                block.timestamp,
                expiresAt,
                keccak256(abi.encodePacked(previousReplies)),
                run
            )
        );
    }

    function _contributionReply(address replier, bytes32 digest, bytes memory daReference)
        private
        view
        returns (AgentReply memory reply)
    {
        bytes32 contributionId = _contributionId(digest);
        bytes memory output =
            abi.encode(Workflow.ActionKind.SubmitContribution, AGENT_ID, roundId, contributionId, daReference, digest);
        bytes32[] memory previousTasks = new bytes32[](1);
        previousTasks[0] = collectTaskHash;
        reply = AgentReply({
            outputHash: keccak256(output),
            output: output,
            timestamp: block.timestamp,
            replier: replier,
            prevTaskHashes: previousTasks,
            workflowRunId: roundId
        });
    }

    function _contributionId(bytes32 digest) private view returns (bytes32) {
        return keccak256(abi.encode(address(workflow), roundId, AGENT_ID, digest));
    }

    function _replyHash(AgentReply memory reply) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                reply.outputHash,
                reply.timestamp,
                reply.replier,
                keccak256(abi.encodePacked(reply.prevTaskHashes)),
                reply.workflowRunId
            )
        );
    }
}
