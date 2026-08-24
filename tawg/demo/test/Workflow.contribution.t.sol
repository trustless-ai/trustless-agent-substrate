// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {AgentReply, AgentTask} from "@agent-ercs/execution/ERC8301/IAgentWorkflow.sol";
import {IAgentVerifier} from "@agent-ercs/verify/ERC8274/IAgentVerifier.sol";
import {PassThroughVerifier} from "../contracts/PassThroughVerifier.sol";
import {Workflow} from "../contracts/Workflow.sol";
import {TestBase} from "./TestBase.sol";

contract ContributionRegistry {
    error NonexistentAgent(uint256 agentId);

    mapping(uint256 agentId => address owner) private _owners;
    mapping(uint256 agentId => address wallet) private _wallets;

    function register(uint256 agentId, address owner, address wallet) external {
        _owners[agentId] = owner;
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

contract ContributionProfile {
    address private immutable _identityRegistry;
    mapping(uint256 agentId => bool member) private _members;

    constructor(address identityRegistry_) {
        _identityRegistry = identityRegistry_;
    }

    function identityRegistry() external view returns (address) {
        return _identityRegistry;
    }

    function getAgent(uint256 agentId) external view returns (bool isMember, string memory data, address verifier) {
        return (_members[agentId], "{}", address(0xCAFE));
    }

    function setMember(uint256 agentId, bool member) external {
        _members[agentId] = member;
    }
}

contract RejectingContributionVerifier is IAgentVerifier {
    function verify(bytes32 taskId, bytes32 agentId, bytes32 inputHash, bytes32 outputHash, bytes calldata proof)
        external
        returns (bool valid, bytes32 verificationDigest)
    {
        proof;
        valid = false;
        verificationDigest = keccak256(abi.encode(taskId, agentId, inputHash, outputHash, valid, address(this)));
        emit VerificationCompleted(taskId, agentId, inputHash, outputHash, valid, verificationDigest);
    }
}

contract ContributionWorkflowHarness is Workflow {
    constructor(address profile, address verifier, uint256 evaluatorAgentId)
        Workflow(profile, verifier, evaluatorAgentId)
    {}

    function storeNonCollectTask(bytes32 runId) external returns (bytes32 taskHash) {
        bytes memory input = bytes("not collect");
        bytes32[] memory previousReplies = new bytes32[](0);
        AgentTask memory task = AgentTask({
            stage: 1,
            taskSeq: 1,
            inputHash: keccak256(input),
            input: input,
            timestamp: block.timestamp,
            expiresAt: block.timestamp + 7 days,
            prevReplyHashes: previousReplies,
            workflowRunId: runId
        });
        return _storeTask(task, true);
    }
}

contract WorkflowContributionTest is TestBase {
    uint256 private constant AGENT_ID = 9_007_199_254_740_993_123_456_789;
    uint256 private constant EVALUATOR_AGENT_ID = 9_007_199_254_740_993_000_000_001;
    address private constant OWNER = address(0x0A11);
    address private constant WALLET = address(0xA11CE);
    address private constant EVALUATOR_WALLET = address(0xE0A1);

    ContributionRegistry private registry;
    ContributionProfile private profile;
    PassThroughVerifier private verifier;
    ContributionWorkflowHarness private workflow;
    bytes32 private roundId;
    bytes32 private collectTaskHash;

    event VerificationCompleted(
        bytes32 indexed taskId,
        bytes32 indexed agentId,
        bytes32 inputHash,
        bytes32 outputHash,
        bool valid,
        bytes32 verificationDigest
    );

    function setUp() public {
        VM.warp(1_000_000);
        registry = new ContributionRegistry();
        profile = new ContributionProfile(address(registry));
        verifier = new PassThroughVerifier();
        workflow = new ContributionWorkflowHarness(address(profile), address(verifier), EVALUATOR_AGENT_ID);
        registry.register(EVALUATOR_AGENT_ID, OWNER, EVALUATOR_WALLET);
        profile.setMember(EVALUATOR_AGENT_ID, true);
        registry.register(AGENT_ID, OWNER, WALLET);
        profile.setMember(AGENT_ID, true);
        (roundId, collectTaskHash) = _startRun(workflow);
    }

    function testStoresExactContributionIdentityFieldsReplyAndReservedScoreState() public {
        bytes memory daReference = hex"001122aaff";
        bytes32 digest = keccak256("exact bytes");
        bytes32 contributionId = _contributionId(workflow, roundId, digest);
        AgentReply memory reply =
            _reply(workflow, roundId, collectTaskHash, WALLET, AGENT_ID, contributionId, daReference, digest);
        bytes32 replyHash = _replyHash(reply);
        (AgentTask memory collectTask,) = workflow.getAgentTask(collectTaskHash);
        bytes32 expectedVerificationDigest = keccak256(
            abi.encode(
                collectTaskHash, bytes32(AGENT_ID), collectTask.inputHash, reply.outputHash, true, address(verifier)
            )
        );

        VM.prank(WALLET);
        VM.expectEmit(true, true, false, true, address(verifier));
        emit VerificationCompleted(
            collectTaskHash,
            bytes32(AGENT_ID),
            collectTask.inputHash,
            reply.outputHash,
            true,
            expectedVerificationDigest
        );
        workflow.onAgentReply(reply);

        Workflow.ContributionView memory contribution = workflow.getContribution(contributionId);
        assertTrue(contribution.exists);
        assertEq(contribution.roundId, roundId);
        assertEq(contribution.contributorAgentId, AGENT_ID);
        assertEq(keccak256(contribution.daReference), keccak256(daReference));
        assertEq(contribution.daDigest, digest);
        assertEq(contribution.submitReplyHash, replyHash);
        assertFalse(contribution.scored);
        assertEq(contribution.score, 0);
        (, address storedVerifier, bool proven, bytes32 verificationDigest) = workflow.getAgentReply(replyHash);
        assertEq(storedVerifier, address(verifier));
        assertTrue(proven);
        assertEq(verificationDigest, expectedVerificationDigest);
    }

    function testOneMemberCanSubmitMultipleDistinctContributionsInOrder() public {
        bytes32 firstDigest = keccak256("first");
        bytes32 secondDigest = keccak256("second");
        bytes32 firstId = _submit(firstDigest, bytes("git:first"));
        bytes32 secondId = _submit(secondDigest, bytes("git:second"));

        assertTrue(firstId != secondId);
        assertEq(workflow.contributionCount(roundId), 2);
        assertEq(workflow.contributionIdAt(roundId, 0), firstId);
        assertEq(workflow.contributionIdAt(roundId, 1), secondId);
    }

    function testRejectsMismatchedCallerSuppliedContributionId() public {
        bytes32 digest = keccak256("mismatch");
        bytes32 supplied = keccak256("caller supplied");
        bytes32 expected = _contributionId(workflow, roundId, digest);
        AgentReply memory reply =
            _reply(workflow, roundId, collectTaskHash, WALLET, AGENT_ID, supplied, bytes("git:mismatch"), digest);

        VM.prank(WALLET);
        VM.expectRevert(abi.encodeWithSelector(Workflow.ContributionIdMismatch.selector, expected, supplied));
        workflow.onAgentReply(reply);
    }

    function testSameAgentRoundAndDigestIsDuplicateEvenWhenReferenceChanges() public {
        bytes32 digest = keccak256("same logical work");
        bytes32 contributionId = _submit(digest, bytes("git:first-locator"));
        AgentReply memory duplicate = _reply(
            workflow, roundId, collectTaskHash, WALLET, AGENT_ID, contributionId, bytes("ipfs:changed-locator"), digest
        );

        VM.prank(WALLET);
        VM.expectRevert(abi.encodeWithSelector(Workflow.DuplicateContribution.selector, contributionId));
        workflow.onAgentReply(duplicate);
    }

    function testRejectsWrongRoundAndNonCollectPreviousTask() public {
        bytes32 digest = keccak256("wrong round");
        bytes32 otherRound = keccak256("other round");
        bytes32 contributionId = _contributionId(workflow, otherRound, digest);
        AgentReply memory wrongRound = _reply(
            workflow, roundId, collectTaskHash, WALLET, AGENT_ID, contributionId, bytes("git:wrong-round"), digest
        );
        wrongRound.output = abi.encode(
            Workflow.ActionKind.SubmitContribution,
            AGENT_ID,
            otherRound,
            contributionId,
            bytes("git:wrong-round"),
            digest
        );
        wrongRound.outputHash = keccak256(wrongRound.output);

        VM.prank(WALLET);
        VM.expectRevert(abi.encodeWithSelector(Workflow.ContributionRoundMismatch.selector, roundId, otherRound));
        workflow.onAgentReply(wrongRound);

        bytes32 nonCollectTask = workflow.storeNonCollectTask(roundId);
        bytes32 correctId = _contributionId(workflow, roundId, digest);
        AgentReply memory nonCollect =
            _reply(workflow, roundId, nonCollectTask, WALLET, AGENT_ID, correctId, bytes("git:non-collect"), digest);
        VM.prank(WALLET);
        VM.expectRevert(abi.encodeWithSelector(Workflow.InvalidCollectTask.selector, roundId, nonCollectTask));
        workflow.onAgentReply(nonCollect);
    }

    function testRejectsUnknownRunBeforeCollectTaskPairing() public {
        bytes32 unknownRound = keccak256("unknown round with task");
        bytes32 taskHash = workflow.storeNonCollectTask(unknownRound);
        bytes32 digest = keccak256("unknown run contribution");
        bytes32 contributionId = _contributionId(workflow, unknownRound, digest);
        AgentReply memory reply =
            _reply(workflow, unknownRound, taskHash, WALLET, AGENT_ID, contributionId, bytes("git:unknown-run"), digest);

        VM.prank(WALLET);
        VM.expectRevert(abi.encodeWithSelector(Workflow.UnknownRun.selector, unknownRound));
        workflow.onAgentReply(reply);
    }

    function testRejectsEmptyDAReferenceAndZeroDigest() public {
        bytes32 digest = keccak256("nonempty digest");
        bytes32 contributionId = _contributionId(workflow, roundId, digest);
        AgentReply memory emptyReference =
            _reply(workflow, roundId, collectTaskHash, WALLET, AGENT_ID, contributionId, bytes(""), digest);
        VM.prank(WALLET);
        VM.expectRevert(Workflow.EmptyDAReference.selector);
        workflow.onAgentReply(emptyReference);

        AgentReply memory zeroDigest = _reply(
            workflow,
            roundId,
            collectTaskHash,
            WALLET,
            AGENT_ID,
            _contributionId(workflow, roundId, bytes32(0)),
            bytes("git:zero"),
            bytes32(0)
        );
        VM.prank(WALLET);
        VM.expectRevert(Workflow.ZeroDADigest.selector);
        workflow.onAgentReply(zeroDigest);
    }

    function testRejectsMalformedAndUnsupportedActionPayloads() public {
        AgentReply memory shortPayload = _rawReply(bytes("short"));
        VM.prank(WALLET);
        VM.expectRevert(Workflow.MalformedAction.selector);
        workflow.onAgentReply(shortPayload);

        AgentReply memory malformed = _rawReply(abi.encode(Workflow.ActionKind.SubmitContribution));
        VM.prank(WALLET);
        VM.expectRevert(Workflow.MalformedAction.selector);
        workflow.onAgentReply(malformed);

        AgentReply memory unsupported = _rawReply(abi.encode(uint256(5)));
        VM.prank(WALLET);
        VM.expectRevert(abi.encodeWithSelector(Workflow.UnsupportedAction.selector, uint256(5)));
        workflow.onAgentReply(unsupported);
    }

    function testRejectsNonCanonicalActionPadding() public {
        bytes32 digest = keccak256("noncanonical padding");
        bytes memory output = abi.encode(
            Workflow.ActionKind.SubmitContribution,
            AGENT_ID,
            roundId,
            _contributionId(workflow, roundId, digest),
            bytes("x"),
            digest
        );
        assembly ("memory-safe") {
            mstore8(add(add(output, 32), sub(mload(output), 1)), 1)
        }

        VM.prank(WALLET);
        VM.expectRevert(Workflow.MalformedAction.selector);
        workflow.onAgentReply(_rawReply(output));
    }

    function testVerifierRejectionLeavesNoReplyOrContribution() public {
        RejectingContributionVerifier rejecting = new RejectingContributionVerifier();
        ContributionWorkflowHarness rejectingWorkflow =
            new ContributionWorkflowHarness(address(profile), address(rejecting), EVALUATOR_AGENT_ID);
        (bytes32 rejectingRound, bytes32 rejectingTask) = _startRun(rejectingWorkflow);
        bytes32 digest = keccak256("rejected");
        bytes32 contributionId = _contributionId(rejectingWorkflow, rejectingRound, digest);
        AgentReply memory reply = _reply(
            rejectingWorkflow,
            rejectingRound,
            rejectingTask,
            WALLET,
            AGENT_ID,
            contributionId,
            bytes("git:rejected"),
            digest
        );
        bytes32 replyHash = _replyHash(reply);

        VM.prank(WALLET);
        VM.expectRevert(Workflow.VerifierRejected.selector);
        rejectingWorkflow.onAgentReply(reply);
        VM.expectRevert(abi.encodeWithSelector(Workflow.UnknownContribution.selector, contributionId));
        rejectingWorkflow.getContribution(contributionId);
        VM.expectRevert(abi.encodeWithSelector(Workflow.UnknownReply.selector, replyHash));
        rejectingWorkflow.getAgentReply(replyHash);
        assertEq(rejectingWorkflow.contributionCount(rejectingRound), 0);
    }

    function testContributionQueriesRejectUnknownAndOutOfBoundsRecords() public {
        bytes32 unknown = keccak256("unknown contribution");
        VM.expectRevert(abi.encodeWithSelector(Workflow.UnknownContribution.selector, unknown));
        workflow.getContribution(unknown);

        VM.expectRevert(abi.encodeWithSelector(Workflow.ContributionIndexOutOfBounds.selector, roundId, uint256(0)));
        workflow.contributionIdAt(roundId, 0);

        bytes32 unknownRound = keccak256("unknown round");
        VM.expectRevert(abi.encodeWithSelector(Workflow.UnknownRun.selector, unknownRound));
        workflow.contributionCount(unknownRound);
        VM.expectRevert(abi.encodeWithSelector(Workflow.UnknownRun.selector, unknownRound));
        workflow.contributionIdAt(unknownRound, 0);
    }

    function _submit(bytes32 digest, bytes memory daReference) private returns (bytes32 contributionId) {
        contributionId = _contributionId(workflow, roundId, digest);
        VM.prank(WALLET);
        workflow.onAgentReply(
            _reply(workflow, roundId, collectTaskHash, WALLET, AGENT_ID, contributionId, daReference, digest)
        );
    }

    function _startRun(Workflow target) private returns (bytes32 run, bytes32 taskHash) {
        bytes memory input = bytes("demo round");
        bytes32 inputHash = keccak256(input);
        uint256 expiresAt = block.timestamp + 7 days;
        VM.prank(EVALUATOR_WALLET);
        run = target.run(inputHash, input, expiresAt);
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

    function _reply(
        Workflow target,
        bytes32 run,
        bytes32 taskHash,
        address replier,
        uint256 agentId,
        bytes32 contributionId,
        bytes memory daReference,
        bytes32 digest
    ) private view returns (AgentReply memory reply) {
        bytes memory output =
            abi.encode(Workflow.ActionKind.SubmitContribution, agentId, run, contributionId, daReference, digest);
        bytes32[] memory previousTasks = new bytes32[](1);
        previousTasks[0] = taskHash;
        reply = AgentReply({
            outputHash: keccak256(output),
            output: output,
            timestamp: block.timestamp,
            replier: replier,
            prevTaskHashes: previousTasks,
            workflowRunId: run
        });
        target;
    }

    function _rawReply(bytes memory output) private view returns (AgentReply memory reply) {
        bytes32[] memory previousTasks = new bytes32[](1);
        previousTasks[0] = collectTaskHash;
        reply = AgentReply({
            outputHash: keccak256(output),
            output: output,
            timestamp: block.timestamp,
            replier: WALLET,
            prevTaskHashes: previousTasks,
            workflowRunId: roundId
        });
    }

    function _contributionId(Workflow target, bytes32 run, bytes32 digest) private pure returns (bytes32) {
        return keccak256(abi.encode(address(target), run, AGENT_ID, digest));
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
