// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {AgentReply, AgentTask, IAgentWorkflow, RunStatus} from "@agent-ercs/execution/ERC8301/IAgentWorkflow.sol";
import {IAgentVerifier} from "@agent-ercs/verify/ERC8274/IAgentVerifier.sol";
import {PassThroughVerifier} from "../contracts/PassThroughVerifier.sol";
import {Workflow} from "../contracts/Workflow.sol";
import {TestBase} from "./TestBase.sol";

contract FalseVerifier is IAgentVerifier {
    function verify(bytes32 taskId, bytes32 agentId, bytes32 inputHash, bytes32 outputHash, bytes calldata)
        external
        returns (bool valid, bytes32 verificationDigest)
    {
        valid = false;
        verificationDigest = keccak256(abi.encode(taskId, agentId, inputHash, outputHash, valid, address(this)));
        emit VerificationCompleted(taskId, agentId, inputHash, outputHash, valid, verificationDigest);
    }
}

contract ZeroDigestVerifier is IAgentVerifier {
    function verify(bytes32 taskId, bytes32 agentId, bytes32 inputHash, bytes32 outputHash, bytes calldata)
        external
        returns (bool valid, bytes32 verificationDigest)
    {
        valid = true;
        verificationDigest = bytes32(0);
        emit VerificationCompleted(taskId, agentId, inputHash, outputHash, valid, verificationDigest);
    }
}

contract ReentrantVerifier is IAgentVerifier {
    Workflow private _target;
    bytes32 private _expectedReplyHash;

    bool public sawAnchoredEffects;
    bool public reentryAttempted;
    bool public reentrySucceeded;

    function configure(Workflow target, bytes32 expectedReplyHash) external {
        _target = target;
        _expectedReplyHash = expectedReplyHash;
    }

    function verify(bytes32 taskId, bytes32 agentId, bytes32 inputHash, bytes32 outputHash, bytes calldata)
        external
        returns (bool valid, bytes32 verificationDigest)
    {
        try _target.getAgentReply(_expectedReplyHash) returns (
            AgentReply memory reply, address verifier, bool proven, bytes32
        ) {
            sawAnchoredEffects = reply.replier != address(0) && verifier == address(this) && !proven;
        } catch {}

        reentryAttempted = true;
        try _target.run(keccak256("reentry"), bytes("reentry"), block.timestamp + 1 days) returns (bytes32) {
            reentrySucceeded = true;
        } catch {}

        valid = true;
        verificationDigest = keccak256(abi.encode(taskId, agentId, inputHash, outputHash, valid, address(this)));
        emit VerificationCompleted(taskId, agentId, inputHash, outputHash, valid, verificationDigest);
    }
}

contract FoundationRegistry {
    mapping(uint256 agentId => address owner) private _owners;
    mapping(uint256 agentId => address wallet) private _wallets;

    function register(uint256 agentId, address owner, address wallet) external {
        _owners[agentId] = owner;
        _wallets[agentId] = wallet;
    }

    function ownerOf(uint256 agentId) external view returns (address owner) {
        owner = _owners[agentId];
        require(owner != address(0));
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        return _wallets[agentId];
    }
}

contract FoundationProfile {
    address private immutable _identityRegistry;
    mapping(uint256 agentId => bool member) private _members;

    constructor(address identityRegistry_) {
        _identityRegistry = identityRegistry_;
    }

    function identityRegistry() external view returns (address) {
        return _identityRegistry;
    }

    function getAgent(uint256 agentId) external view returns (bool, string memory, address) {
        return (_members[agentId], "{}", address(0));
    }

    function setMember(uint256 agentId, bool member) external {
        _members[agentId] = member;
    }
}

contract WorkflowERC8301Test is TestBase {
    address private constant REPLIER = address(0xA11CE);
    address private constant EVALUATOR_WALLET = address(0xE0A1);
    address private constant OWNER = address(0x0A11);
    uint256 private constant CONTRIBUTOR_AGENT_ID = 9_007_199_254_740_993_987_654_321;
    uint256 private constant EVALUATOR_AGENT_ID = 9_007_199_254_740_993_123_456_789;
    uint8 private constant INITIAL_STAGE = 0;

    PassThroughVerifier private verifier;
    Workflow private workflow;
    FoundationRegistry private registry;
    FoundationProfile private profile;

    event NewAgentTask(bytes32 indexed workflowRunId, uint8 indexed stage, bytes32 indexed taskHash);
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
        verifier = new PassThroughVerifier();
        registry = new FoundationRegistry();
        profile = new FoundationProfile(address(registry));
        registry.register(EVALUATOR_AGENT_ID, OWNER, EVALUATOR_WALLET);
        profile.setMember(EVALUATOR_AGENT_ID, true);
        registry.register(CONTRIBUTOR_AGENT_ID, OWNER, REPLIER);
        profile.setMember(CONTRIBUTOR_AGENT_ID, true);
        workflow = new Workflow(address(profile), address(verifier), EVALUATOR_AGENT_ID);
    }

    function testConstructorStoresFutureCompatibleImmutableConfiguration() public view {
        assertEq(workflow.profile(), address(profile));
        assertEq(workflow.passThroughVerifier(), address(verifier));
        assertEq(workflow.evaluatorAgentId(), EVALUATOR_AGENT_ID);
    }

    function testConstructorRejectsZeroProfileAndVerifierWithoutCode() public {
        VM.expectRevert(Workflow.InvalidConfiguration.selector);
        new Workflow(address(0), address(verifier), EVALUATOR_AGENT_ID);

        VM.expectRevert(Workflow.InvalidConfiguration.selector);
        new Workflow(address(profile), address(0), EVALUATOR_AGENT_ID);

        VM.expectRevert(Workflow.InvalidConfiguration.selector);
        new Workflow(address(profile), address(0x1234), EVALUATOR_AGENT_ID);
    }

    function testConstructorAllowsPredictedProfileWithoutCodeAndZeroEvaluatorId() public {
        Workflow configured = new Workflow(address(0xCAFE), address(verifier), 0);
        assertEq(configured.profile(), address(0xCAFE));
        assertEq(configured.evaluatorAgentId(), 0);
    }

    function testRunRejectsWrongInputCommitmentAndNonfutureExpiry() public {
        VM.expectRevert(Workflow.InvalidInputCommitment.selector);
        workflow.run(keccak256("other"), bytes("goal"), block.timestamp + 1 days);

        VM.expectRevert(Workflow.InvalidExpiry.selector);
        workflow.run(keccak256("goal"), bytes("goal"), block.timestamp);
    }

    function testRunCreatesExactInitialTaskAndPendingResult() public {
        bytes memory input = bytes("goal");
        bytes32 inputHash = keccak256(input);
        uint256 expiresAt = block.timestamp + 1 days;
        bytes32 runId = _runId(workflow, 1, EVALUATOR_WALLET, inputHash, expiresAt);
        bytes32 taskHash = _initialTaskHash(runId, inputHash, expiresAt, block.timestamp);

        VM.expectEmit(true, true, true, false, address(workflow));
        emit NewAgentTask(runId, INITIAL_STAGE, taskHash);
        VM.prank(EVALUATOR_WALLET);
        assertEq(workflow.run(inputHash, input, expiresAt), runId);

        (RunStatus status, bytes32 finalTaskHash, uint256 completedAt) = workflow.result(runId);
        assertEq(uint256(status), uint256(RunStatus.Pending));
        assertEq(finalTaskHash, bytes32(0));
        assertEq(completedAt, 0);

        (AgentTask memory task, bool proven) = workflow.getAgentTask(taskHash);
        assertTrue(proven);
        assertEq(task.stage, INITIAL_STAGE);
        assertEq(task.taskSeq, 0);
        assertEq(task.inputHash, inputHash);
        assertEq(keccak256(task.input), keccak256(input));
        assertEq(task.timestamp, block.timestamp);
        assertEq(task.expiresAt, expiresAt);
        assertEq(task.prevReplyHashes.length, 0);
        assertEq(task.workflowRunId, runId);
    }

    function testSecondExternalRunIsForbiddenAfterInitialRound() public {
        bytes memory input = bytes("goal");
        bytes32 inputHash = keccak256(input);
        uint256 expiresAt = block.timestamp + 1 days;

        VM.prank(EVALUATOR_WALLET);
        bytes32 first = workflow.run(inputHash, input, expiresAt);
        assertEq(first, _runId(workflow, 1, EVALUATOR_WALLET, inputHash, expiresAt));
        VM.expectRevert(Workflow.InitialRoundAlreadyStarted.selector);
        workflow.run(inputHash, input, expiresAt);
    }

    function testUnknownRunTaskAndReplyUseDistinctErrors() public {
        bytes32 unknown = keccak256("unknown");
        VM.expectRevert(abi.encodeWithSelector(Workflow.UnknownRun.selector, unknown));
        workflow.result(unknown);
        VM.expectRevert(abi.encodeWithSelector(Workflow.UnknownTask.selector, unknown));
        workflow.getAgentTask(unknown);
        VM.expectRevert(abi.encodeWithSelector(Workflow.UnknownReply.selector, unknown));
        workflow.getAgentReply(unknown);
    }

    function testPassThroughVerifierUsesOwnIdentityAndIgnoresProofBytes() public {
        bytes32 taskId = keccak256("task");
        bytes32 agentId = bytes32(uint256(42));
        bytes32 inputHash = keccak256("input");
        bytes32 outputHash = keccak256("output");
        bytes32 expected = keccak256(abi.encode(taskId, agentId, inputHash, outputHash, true, address(verifier)));

        VM.expectEmit(true, true, false, true, address(verifier));
        emit VerificationCompleted(taskId, agentId, inputHash, outputHash, true, expected);
        (bool firstValid, bytes32 firstDigest) = verifier.verify(taskId, agentId, inputHash, outputHash, "");
        (bool secondValid, bytes32 secondDigest) =
            verifier.verify(taskId, agentId, inputHash, outputHash, hex"deadbeef");

        assertTrue(firstValid);
        assertTrue(secondValid);
        assertEq(firstDigest, expected);
        assertEq(secondDigest, expected);
        assertTrue(firstDigest != bytes32(0));
    }

    function testPinnedAbiDispatchesEveryRequiredOperation() public {
        IAgentWorkflow standard = IAgentWorkflow(address(workflow));
        (bytes32 runId, bytes32 taskHash) = _startRun(standard);
        (RunStatus status,,) = standard.result(runId);
        assertEq(uint256(status), uint256(RunStatus.Pending));
        standard.getAgentTask(taskHash);

        AgentReply memory reply = _reply(workflow, runId, taskHash, REPLIER, bytes("work"), block.timestamp);
        VM.prank(REPLIER);
        standard.onAgentReply(reply);
        bytes32 replyHash = _replyHash(reply);
        (, address storedVerifier, bool proven,) = standard.getAgentReply(replyHash);
        assertEq(storedVerifier, address(verifier));
        assertTrue(proven);

        bytes32[] memory replyHashes = new bytes32[](1);
        replyHashes[0] = replyHash;
        VM.expectRevert(abi.encodeWithSelector(Workflow.ReplyAlreadyProven.selector, replyHash));
        standard.onAgentProve(replyHashes, "");
    }

    function testReplyStoresExactHashAndImmediateProofFreeResult() public {
        (bytes32 runId, bytes32 taskHash) = _startRun(IAgentWorkflow(address(workflow)));
        bytes memory output = bytes("work");
        AgentReply memory reply = _reply(workflow, runId, taskHash, REPLIER, output, block.timestamp);
        bytes32 replyHash = _replyHash(reply);

        VM.prank(REPLIER);
        workflow.onAgentReply(reply);

        (AgentReply memory stored, address storedVerifier, bool proven, bytes32 digest) =
            workflow.getAgentReply(replyHash);
        (AgentTask memory task,) = workflow.getAgentTask(taskHash);
        bytes32 expectedDigest = keccak256(
            abi.encode(
                taskHash, bytes32(CONTRIBUTOR_AGENT_ID), task.inputHash, reply.outputHash, true, address(verifier)
            )
        );

        assertEq(stored.outputHash, reply.outputHash);
        assertEq(keccak256(stored.output), keccak256(reply.output));
        assertEq(stored.timestamp, reply.timestamp);
        assertEq(stored.replier, REPLIER);
        assertEq(stored.prevTaskHashes.length, 1);
        assertEq(stored.prevTaskHashes[0], taskHash);
        assertEq(stored.workflowRunId, runId);
        assertEq(storedVerifier, address(verifier));
        assertTrue(proven);
        assertEq(digest, expectedDigest);
        assertTrue(digest != bytes32(0));
    }

    function testReplyRejectsWrongReplierAndOutputCommitment() public {
        (bytes32 runId, bytes32 taskHash) = _startRun(IAgentWorkflow(address(workflow)));
        AgentReply memory reply = _reply(workflow, runId, taskHash, REPLIER, bytes("work"), block.timestamp);

        VM.expectRevert(Workflow.UnauthorizedReplier.selector);
        workflow.onAgentReply(reply);

        reply.outputHash = keccak256("different");
        VM.prank(REPLIER);
        VM.expectRevert(Workflow.InvalidOutputCommitment.selector);
        workflow.onAgentReply(reply);
    }

    function testReplyRequiresExactlyOnePreviousTask() public {
        (bytes32 runId, bytes32 taskHash) = _startRun(IAgentWorkflow(address(workflow)));
        AgentReply memory reply = _reply(workflow, runId, taskHash, REPLIER, bytes("work"), block.timestamp);

        reply.prevTaskHashes = new bytes32[](0);
        VM.prank(REPLIER);
        VM.expectRevert(Workflow.InvalidPreviousTaskCount.selector);
        workflow.onAgentReply(reply);

        reply.prevTaskHashes = new bytes32[](2);
        reply.prevTaskHashes[0] = taskHash;
        reply.prevTaskHashes[1] = taskHash;
        VM.prank(REPLIER);
        VM.expectRevert(Workflow.InvalidPreviousTaskCount.selector);
        workflow.onAgentReply(reply);
    }

    function testReplyRejectsUnknownTaskAndRunMismatch() public {
        (bytes32 firstRun, bytes32 firstTask) = _startRun(IAgentWorkflow(address(workflow)));
        Workflow otherWorkflow = new Workflow(address(profile), address(verifier), EVALUATOR_AGENT_ID);
        VM.prank(EVALUATOR_WALLET);
        bytes32 secondRun = otherWorkflow.run(keccak256("second"), bytes("second"), block.timestamp + 1 days);
        AgentReply memory reply =
            _reply(workflow, firstRun, keccak256("missing"), REPLIER, bytes("work"), block.timestamp);

        VM.prank(REPLIER);
        VM.expectRevert(abi.encodeWithSelector(Workflow.UnknownTask.selector, reply.prevTaskHashes[0]));
        workflow.onAgentReply(reply);

        reply = _reply(workflow, secondRun, firstTask, REPLIER, bytes("work"), block.timestamp);
        VM.prank(REPLIER);
        VM.expectRevert(Workflow.RunMismatch.selector);
        workflow.onAgentReply(reply);
    }

    function testReplyRejectsTimestampOutsideTaskLifetimeAndExpiredTask() public {
        (bytes32 runId, bytes32 taskHash) = _startRun(IAgentWorkflow(address(workflow)));
        AgentReply memory reply = _reply(workflow, runId, taskHash, REPLIER, bytes("work"), block.timestamp + 1);

        VM.prank(REPLIER);
        VM.expectRevert(Workflow.FutureReplyTimestamp.selector);
        workflow.onAgentReply(reply);

        reply.timestamp = block.timestamp - 1;
        VM.prank(REPLIER);
        VM.expectRevert(Workflow.ReplyBeforeTask.selector);
        workflow.onAgentReply(reply);

        VM.warp(block.timestamp + 1 days + 1);
        reply.timestamp = block.timestamp;
        VM.prank(REPLIER);
        VM.expectRevert(Workflow.TaskExpired.selector);
        workflow.onAgentReply(reply);
    }

    function testReplyRejectsDuplicateHash() public {
        (bytes32 runId, bytes32 taskHash) = _startRun(IAgentWorkflow(address(workflow)));
        AgentReply memory reply = _reply(workflow, runId, taskHash, REPLIER, bytes("work"), block.timestamp);

        VM.prank(REPLIER);
        workflow.onAgentReply(reply);
        VM.prank(REPLIER);
        VM.expectRevert(abi.encodeWithSelector(Workflow.DuplicateReply.selector, _replyHash(reply)));
        workflow.onAgentReply(reply);
    }

    function testReplyNeverBecomesProvenWhenVerifierRejectsOrReturnsZeroDigest() public {
        FalseVerifier rejecting = new FalseVerifier();
        Workflow rejectingWorkflow = new Workflow(address(profile), address(rejecting), EVALUATOR_AGENT_ID);
        (bytes32 rejectingRun, bytes32 rejectingTask) = _startRun(IAgentWorkflow(address(rejectingWorkflow)));
        AgentReply memory rejected =
            _reply(rejectingWorkflow, rejectingRun, rejectingTask, REPLIER, bytes("rejected"), block.timestamp);
        bytes32 rejectedHash = _replyHash(rejected);

        VM.prank(REPLIER);
        VM.expectRevert(Workflow.VerifierRejected.selector);
        rejectingWorkflow.onAgentReply(rejected);
        VM.expectRevert(abi.encodeWithSelector(Workflow.UnknownReply.selector, rejectedHash));
        rejectingWorkflow.getAgentReply(rejectedHash);

        ZeroDigestVerifier zeroDigest = new ZeroDigestVerifier();
        Workflow zeroDigestWorkflow = new Workflow(address(profile), address(zeroDigest), EVALUATOR_AGENT_ID);
        (bytes32 zeroRun, bytes32 zeroTask) = _startRun(IAgentWorkflow(address(zeroDigestWorkflow)));
        AgentReply memory zeroed =
            _reply(zeroDigestWorkflow, zeroRun, zeroTask, REPLIER, bytes("zero"), block.timestamp);
        bytes32 zeroedHash = _replyHash(zeroed);

        VM.prank(REPLIER);
        VM.expectRevert(Workflow.InvalidVerificationDigest.selector);
        zeroDigestWorkflow.onAgentReply(zeroed);
        VM.expectRevert(abi.encodeWithSelector(Workflow.UnknownReply.selector, zeroedHash));
        zeroDigestWorkflow.getAgentReply(zeroedHash);
    }

    function testVerifierObservesAnchoredEffectsButCannotReenterStateMutation() public {
        ReentrantVerifier reentrant = new ReentrantVerifier();
        Workflow guarded = new Workflow(address(profile), address(reentrant), EVALUATOR_AGENT_ID);
        (bytes32 runId, bytes32 taskHash) = _startRun(IAgentWorkflow(address(guarded)));
        AgentReply memory reply = _reply(guarded, runId, taskHash, REPLIER, bytes("work"), block.timestamp);
        bytes32 replyHash = _replyHash(reply);
        reentrant.configure(guarded, replyHash);

        VM.prank(REPLIER);
        guarded.onAgentReply(reply);

        assertTrue(reentrant.sawAnchoredEffects());
        assertTrue(reentrant.reentryAttempted());
        assertFalse(reentrant.reentrySucceeded());
        (, address storedVerifier, bool proven, bytes32 digest) = guarded.getAgentReply(replyHash);
        assertEq(storedVerifier, address(reentrant));
        assertTrue(proven);
        assertTrue(digest != bytes32(0));
    }

    function testOnAgentProveRejectsMalformedUnknownAndAlreadyProvenBatches() public {
        bytes32[] memory hashes = new bytes32[](0);
        VM.expectRevert(Workflow.InvalidProofBatch.selector);
        workflow.onAgentProve(hashes, "");

        hashes = new bytes32[](2);
        hashes[0] = keccak256("one");
        hashes[1] = keccak256("two");
        VM.expectRevert(abi.encodeWithSelector(Workflow.UnknownReply.selector, hashes[0]));
        workflow.onAgentProve(hashes, "");

        hashes = new bytes32[](1);
        hashes[0] = keccak256("unknown");
        VM.expectRevert(abi.encodeWithSelector(Workflow.UnknownReply.selector, hashes[0]));
        workflow.onAgentProve(hashes, hex"1234");

        (bytes32 runId, bytes32 taskHash) = _startRun(IAgentWorkflow(address(workflow)));
        AgentReply memory reply = _reply(workflow, runId, taskHash, REPLIER, bytes("work"), block.timestamp);
        hashes[0] = _replyHash(reply);
        VM.prank(REPLIER);
        workflow.onAgentReply(reply);
        VM.expectRevert(abi.encodeWithSelector(Workflow.ReplyAlreadyProven.selector, hashes[0]));
        workflow.onAgentProve(hashes, hex"1234");

        AgentReply memory secondReply = _reply(workflow, runId, taskHash, REPLIER, bytes("second"), block.timestamp);
        bytes32 secondReplyHash = _replyHash(secondReply);
        VM.prank(REPLIER);
        workflow.onAgentReply(secondReply);
        hashes = new bytes32[](2);
        hashes[0] = secondReplyHash;
        hashes[1] = _replyHash(reply);
        VM.expectRevert(abi.encodeWithSelector(Workflow.ReplyAlreadyProven.selector, secondReplyHash));
        workflow.onAgentProve(hashes, hex"1234");
    }

    function _startRun(IAgentWorkflow target) private returns (bytes32 runId, bytes32 taskHash) {
        bytes memory input = bytes("goal");
        bytes32 inputHash = keccak256(input);
        uint256 expiresAt = block.timestamp + 1 days;
        VM.prank(EVALUATOR_WALLET);
        runId = target.run(inputHash, input, expiresAt);
        taskHash = _initialTaskHash(runId, inputHash, expiresAt, block.timestamp);
    }

    function _reply(
        Workflow target,
        bytes32 runId,
        bytes32 taskHash,
        address replier,
        bytes memory daReference,
        uint256 timestamp
    ) private pure returns (AgentReply memory reply) {
        bytes32 daDigest = keccak256(daReference);
        bytes32 contributionId = keccak256(abi.encode(address(target), runId, CONTRIBUTOR_AGENT_ID, daDigest));
        bytes memory output = abi.encode(
            Workflow.ActionKind.SubmitContribution, CONTRIBUTOR_AGENT_ID, runId, contributionId, daReference, daDigest
        );
        bytes32[] memory previousTasks = new bytes32[](1);
        previousTasks[0] = taskHash;
        reply = AgentReply({
            outputHash: keccak256(output),
            output: output,
            timestamp: timestamp,
            replier: replier,
            prevTaskHashes: previousTasks,
            workflowRunId: runId
        });
    }

    function _runId(Workflow target, uint256 sequence, address caller, bytes32 inputHash, uint256 expiresAt)
        private
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(address(target), block.chainid, sequence, caller, inputHash, expiresAt));
    }

    function _initialTaskHash(bytes32 runId, bytes32 inputHash, uint256 expiresAt, uint256 timestamp)
        private
        pure
        returns (bytes32)
    {
        bytes32[] memory previousReplies = new bytes32[](0);
        return keccak256(
            abi.encode(
                INITIAL_STAGE,
                uint256(0),
                inputHash,
                timestamp,
                expiresAt,
                keccak256(abi.encodePacked(previousReplies)),
                runId
            )
        );
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
