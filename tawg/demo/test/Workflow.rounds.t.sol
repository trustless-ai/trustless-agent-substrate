// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {AgentReply, AgentTask, RunStatus} from "@agent-ercs/execution/ERC8301/IAgentWorkflow.sol";
import {PassThroughVerifier} from "../contracts/PassThroughVerifier.sol";
import {Workflow} from "../contracts/Workflow.sol";
import {TestBase} from "./TestBase.sol";

contract RoundRegistry {
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

contract RoundProfile {
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

contract WorkflowRoundsTest is TestBase {
    uint256 private constant EVALUATOR_ID = 9_007_199_254_740_993_000_000_001;
    uint256 private constant CONTRIBUTOR_A_ID = 9_007_199_254_740_993_123_456_789;
    uint256 private constant CONTRIBUTOR_B_ID = 9_007_199_254_740_993_987_654_321;
    address private constant OWNER = address(0x0A11);
    address private constant EVALUATOR_WALLET_A = address(0xE0A1);
    address private constant EVALUATOR_WALLET_B = address(0xE0B2);
    address private constant CONTRIBUTOR_A_WALLET = address(0xA11CE);
    address private constant CONTRIBUTOR_B_WALLET = address(0xB0B);

    RoundRegistry private registry;
    RoundProfile private profile;
    PassThroughVerifier private verifier;
    Workflow private workflow;
    bytes32 private firstRoundId;
    bytes32 private firstCollectTaskHash;

    event WorkflowCompleted(bytes32 indexed workflowRunId, RunStatus status, bytes32 finalTaskHash, uint256 timestamp);
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
        registry = new RoundRegistry();
        profile = new RoundProfile(address(registry));
        verifier = new PassThroughVerifier();
        workflow = new Workflow(address(profile), address(verifier), EVALUATOR_ID);
        _register(EVALUATOR_ID, EVALUATOR_WALLET_A);
        _register(CONTRIBUTOR_A_ID, CONTRIBUTOR_A_WALLET);
        _register(CONTRIBUTOR_B_ID, CONTRIBUTOR_B_WALLET);
        (firstRoundId, firstCollectTaskHash) = _startInitialRound();
    }

    function testInitialRunCreatesOnlyCurrentOpenRoundAndSecondExternalRunFails() public {
        assertEq(workflow.evaluatorAgentId(), EVALUATOR_ID);
        assertEq(workflow.currentRoundId(), firstRoundId);
        assertEq(uint256(workflow.globalState()), uint256(Workflow.GlobalState.Active));

        Workflow.RoundView memory round = workflow.getRound(firstRoundId);
        assertTrue(round.exists);
        assertEq(uint256(round.status), uint256(Workflow.RoundStatus.Open));
        assertEq(round.previousRoundId, bytes32(0));
        assertEq(round.collectTaskHash, firstCollectTaskHash);
        assertEq(round.contributionCount, 0);
        assertEq(round.scoredCount, 0);
        assertEq(round.totalScore, 0);

        bytes memory input = bytes("forbidden second external run");
        VM.expectRevert(Workflow.InitialRoundAlreadyStarted.selector);
        workflow.run(keccak256(input), input, block.timestamp + 7 days);
    }

    function testUnauthorizedCallerCannotConsumeInitialRunLatch() public {
        Workflow fresh = new Workflow(address(profile), address(verifier), EVALUATOR_ID);
        bytes memory input = bytes("authorized initial round");
        bytes32 inputHash = keccak256(input);
        uint256 expiresAt = block.timestamp + 7 days;

        VM.expectRevert(
            abi.encodeWithSelector(
                Workflow.WrongAuthenticationWallet.selector, EVALUATOR_ID, EVALUATOR_WALLET_A, address(this)
            )
        );
        fresh.run(inputHash, input, expiresAt);

        bytes32 expectedRunId =
            keccak256(abi.encode(address(fresh), block.chainid, uint256(1), EVALUATOR_WALLET_A, inputHash, expiresAt));
        VM.prank(EVALUATOR_WALLET_A);
        assertEq(fresh.run(inputHash, input, expiresAt), expectedRunId);
    }

    function testEvaluatorWalletRotationBeforeInitialRunRejectsOldAndAcceptsCurrent() public {
        Workflow fresh = new Workflow(address(profile), address(verifier), EVALUATOR_ID);
        registry.setAgentWallet(EVALUATOR_ID, EVALUATOR_WALLET_B);
        bytes memory input = bytes("rotated initial round");
        bytes32 inputHash = keccak256(input);
        uint256 expiresAt = block.timestamp + 7 days;

        VM.prank(EVALUATOR_WALLET_A);
        VM.expectRevert(
            abi.encodeWithSelector(
                Workflow.WrongAuthenticationWallet.selector, EVALUATOR_ID, EVALUATOR_WALLET_B, EVALUATOR_WALLET_A
            )
        );
        fresh.run(inputHash, input, expiresAt);

        bytes32 expectedRunId =
            keccak256(abi.encode(address(fresh), block.chainid, uint256(1), EVALUATOR_WALLET_B, inputHash, expiresAt));
        VM.prank(EVALUATOR_WALLET_B);
        assertEq(fresh.run(inputHash, input, expiresAt), expectedRunId);
    }

    function testCurrentEvaluatorWalletOpensInitialRoundWithCallerBoundRunId() public {
        Workflow fresh = new Workflow(address(profile), address(verifier), EVALUATOR_ID);
        bytes memory input = bytes("current evaluator initial round");
        bytes32 inputHash = keccak256(input);
        uint256 expiresAt = block.timestamp + 7 days;
        bytes32 expectedRunId =
            keccak256(abi.encode(address(fresh), block.chainid, uint256(1), EVALUATOR_WALLET_A, inputHash, expiresAt));

        VM.prank(EVALUATOR_WALLET_A);
        assertEq(fresh.run(inputHash, input, expiresAt), expectedRunId);
    }

    function testScoreRejectsUnknownContributionWrongTaskAgentAndWallet() public {
        (bytes32 contributionId, bytes32 scoreTaskHash) = _submitContribution(
            firstRoundId, firstCollectTaskHash, CONTRIBUTOR_A_ID, CONTRIBUTOR_A_WALLET, keccak256("score target")
        );

        bytes32 unknownContribution = keccak256("unknown contribution");
        AgentReply memory unknown =
            _scoreReply(firstRoundId, firstCollectTaskHash, EVALUATOR_WALLET_A, EVALUATOR_ID, unknownContribution, 1);
        VM.prank(EVALUATOR_WALLET_A);
        VM.expectRevert(abi.encodeWithSelector(Workflow.UnknownContribution.selector, unknownContribution));
        workflow.onAgentReply(unknown);

        AgentReply memory wrongTask =
            _scoreReply(firstRoundId, firstCollectTaskHash, EVALUATOR_WALLET_A, EVALUATOR_ID, contributionId, 2);
        VM.prank(EVALUATOR_WALLET_A);
        VM.expectRevert(
            abi.encodeWithSelector(Workflow.InvalidScoreTask.selector, contributionId, firstCollectTaskHash)
        );
        workflow.onAgentReply(wrongTask);

        AgentReply memory wrongAgent =
            _scoreReply(firstRoundId, scoreTaskHash, CONTRIBUTOR_A_WALLET, CONTRIBUTOR_A_ID, contributionId, 3);
        VM.prank(CONTRIBUTOR_A_WALLET);
        VM.expectRevert(
            abi.encodeWithSelector(Workflow.EvaluatorAgentMismatch.selector, EVALUATOR_ID, CONTRIBUTOR_A_ID)
        );
        workflow.onAgentReply(wrongAgent);

        AgentReply memory wrongWallet =
            _scoreReply(firstRoundId, scoreTaskHash, EVALUATOR_WALLET_B, EVALUATOR_ID, contributionId, 4);
        VM.prank(EVALUATOR_WALLET_B);
        VM.expectRevert(
            abi.encodeWithSelector(
                Workflow.WrongAuthenticationWallet.selector, EVALUATOR_ID, EVALUATOR_WALLET_A, EVALUATOR_WALLET_B
            )
        );
        workflow.onAgentReply(wrongWallet);
    }

    function testScoreStoresRootLatestGateAndFullEvaluatorIdentityOnce() public {
        (bytes32 contributionId, bytes32 scoreTaskHash) = _submitContribution(
            firstRoundId, firstCollectTaskHash, CONTRIBUTOR_A_ID, CONTRIBUTOR_A_WALLET, keccak256("score accepted")
        );
        AgentReply memory accepted =
            _scoreReply(firstRoundId, scoreTaskHash, EVALUATOR_WALLET_A, EVALUATOR_ID, contributionId, 42);
        bytes32 scoreReplyHash = _replyHash(accepted);
        (AgentTask memory scoreTask,) = workflow.getAgentTask(scoreTaskHash);
        assertEq(scoreTask.stage, uint8(Workflow.Stage.ScoreContribution));
        assertEq(scoreTask.taskSeq, 1);
        assertEq(
            scoreTask.inputHash,
            keccak256(abi.encode(firstRoundId, contributionId, CONTRIBUTOR_A_ID, keccak256("score accepted")))
        );
        bytes32 expectedDigest = keccak256(
            abi.encode(
                scoreTaskHash, bytes32(EVALUATOR_ID), scoreTask.inputHash, accepted.outputHash, true, address(verifier)
            )
        );
        VM.prank(EVALUATOR_WALLET_A);
        VM.expectEmit(true, true, false, true, address(verifier));
        emit VerificationCompleted(
            scoreTaskHash, bytes32(EVALUATOR_ID), scoreTask.inputHash, accepted.outputHash, true, expectedDigest
        );
        workflow.onAgentReply(accepted);

        Workflow.ContributionView memory contribution = workflow.getContribution(contributionId);
        assertTrue(contribution.scored);
        assertEq(contribution.score, 42);
        assertEq(contribution.scoreReplyHash, scoreReplyHash);
        assertEq(scoreTask.prevReplyHashes.length, 1);
        assertEq(scoreTask.prevReplyHashes[0], contribution.submitReplyHash);
        (,,, bytes32 storedDigest) = workflow.getAgentReply(scoreReplyHash);
        assertEq(storedDigest, expectedDigest);

        Workflow.RoundView memory round = workflow.getRound(firstRoundId);
        bytes32 expectedRoot = keccak256(abi.encode(bytes32(0), contributionId, uint256(42), scoreReplyHash));
        assertEq(round.scoreRoot, expectedRoot);
        assertEq(round.scoredCount, 1);
        assertEq(round.totalScore, 42);
        (AgentTask memory settleTask, bool proven) = workflow.getAgentTask(round.latestSettleTaskHash);
        assertTrue(proven);
        assertEq(settleTask.stage, uint8(Workflow.Stage.SettleRound));
        assertEq(settleTask.taskSeq, 2);
        assertEq(settleTask.inputHash, keccak256(abi.encode(firstRoundId, expectedRoot, uint256(1), uint256(42))));
        assertEq(settleTask.expiresAt, type(uint256).max);
        assertEq(settleTask.prevReplyHashes.length, 1);
        assertEq(settleTask.prevReplyHashes[0], scoreReplyHash);
    }

    function testScoreRejectsSecondScore() public {
        (bytes32 contributionId, bytes32 scoreTaskHash) = _submitContribution(
            firstRoundId, firstCollectTaskHash, CONTRIBUTOR_A_ID, CONTRIBUTOR_A_WALLET, keccak256("duplicate score")
        );
        _score(firstRoundId, scoreTaskHash, contributionId, 42, EVALUATOR_WALLET_A);

        VM.warp(block.timestamp + 1);
        VM.prank(EVALUATOR_WALLET_A);
        VM.expectRevert(abi.encodeWithSelector(Workflow.ContributionAlreadyScored.selector, contributionId));
        workflow.onAgentReply(
            _scoreReply(firstRoundId, scoreTaskHash, EVALUATOR_WALLET_A, EVALUATOR_ID, contributionId, 42)
        );
    }

    function testLatestSettlementGateAndSettlementFailuresAreExplicit() public {
        AgentReply memory noScore =
            _settleReply(firstRoundId, firstCollectTaskHash, EVALUATOR_WALLET_A, EVALUATOR_ID, bytes32(0));
        VM.prank(EVALUATOR_WALLET_A);
        VM.expectRevert(abi.encodeWithSelector(Workflow.NoScoredContributions.selector, firstRoundId));
        workflow.onAgentReply(noScore);

        (bytes32 firstContribution, bytes32 firstScoreTask) = _submitContribution(
            firstRoundId, firstCollectTaskHash, CONTRIBUTOR_A_ID, CONTRIBUTOR_A_WALLET, keccak256("first latest gate")
        );
        _score(firstRoundId, firstScoreTask, firstContribution, 10, EVALUATOR_WALLET_A);
        bytes32 oldSettleTask = workflow.getRound(firstRoundId).latestSettleTaskHash;

        (bytes32 secondContribution, bytes32 secondScoreTask) = _submitContribution(
            firstRoundId, firstCollectTaskHash, CONTRIBUTOR_B_ID, CONTRIBUTOR_B_WALLET, keccak256("second latest gate")
        );
        _score(firstRoundId, secondScoreTask, secondContribution, 20, EVALUATOR_WALLET_A);
        Workflow.RoundView memory round = workflow.getRound(firstRoundId);

        AgentReply memory stale =
            _settleReply(firstRoundId, oldSettleTask, EVALUATOR_WALLET_A, EVALUATOR_ID, round.scoreRoot);
        VM.prank(EVALUATOR_WALLET_A);
        VM.expectRevert(abi.encodeWithSelector(Workflow.InvalidLatestSettleTask.selector, firstRoundId, oldSettleTask));
        workflow.onAgentReply(stale);

        AgentReply memory wrongRoot = _settleReply(
            firstRoundId, round.latestSettleTaskHash, EVALUATOR_WALLET_A, EVALUATOR_ID, keccak256("wrong root")
        );
        VM.prank(EVALUATOR_WALLET_A);
        VM.expectRevert(
            abi.encodeWithSelector(Workflow.ScoreRootMismatch.selector, round.scoreRoot, keccak256("wrong root"))
        );
        workflow.onAgentReply(wrongRoot);

        AgentReply memory nonEvaluator = _settleReply(
            firstRoundId, round.latestSettleTaskHash, CONTRIBUTOR_A_WALLET, CONTRIBUTOR_A_ID, round.scoreRoot
        );
        VM.prank(CONTRIBUTOR_A_WALLET);
        VM.expectRevert(
            abi.encodeWithSelector(Workflow.EvaluatorAgentMismatch.selector, EVALUATOR_ID, CONTRIBUTOR_A_ID)
        );
        workflow.onAgentReply(nonEvaluator);

        _settle(firstRoundId, EVALUATOR_WALLET_A);
        VM.warp(block.timestamp + 1);
        AgentReply memory duplicate =
            _settleReply(firstRoundId, round.latestSettleTaskHash, EVALUATOR_WALLET_A, EVALUATOR_ID, round.scoreRoot);
        VM.prank(EVALUATOR_WALLET_A);
        VM.expectRevert(abi.encodeWithSelector(Workflow.RoundAlreadySettled.selector, firstRoundId));
        workflow.onAgentReply(duplicate);
    }

    function testSettlementAggregatesExactRoundAndCumulativePointsAndTerminalResult() public {
        (bytes32 firstA, bytes32 firstATask) = _submitContribution(
            firstRoundId, firstCollectTaskHash, CONTRIBUTOR_A_ID, CONTRIBUTOR_A_WALLET, keccak256("a ten")
        );
        (bytes32 zeroA, bytes32 zeroATask) = _submitContribution(
            firstRoundId, firstCollectTaskHash, CONTRIBUTOR_A_ID, CONTRIBUTOR_A_WALLET, keccak256("a zero")
        );
        (bytes32 unscoredB,) = _submitContribution(
            firstRoundId, firstCollectTaskHash, CONTRIBUTOR_B_ID, CONTRIBUTOR_B_WALLET, keccak256("b unscored")
        );
        (bytes32 scoredB, bytes32 scoredBTask) = _submitContribution(
            firstRoundId, firstCollectTaskHash, CONTRIBUTOR_B_ID, CONTRIBUTOR_B_WALLET, keccak256("b seven")
        );
        _score(firstRoundId, firstATask, firstA, 10, EVALUATOR_WALLET_A);
        _score(firstRoundId, zeroATask, zeroA, 0, EVALUATOR_WALLET_A);
        _score(firstRoundId, scoredBTask, scoredB, 7, EVALUATOR_WALLET_A);

        Workflow.RoundView memory beforeSettlement = workflow.getRound(firstRoundId);
        AgentReply memory settlement = _settlementReply(firstRoundId, EVALUATOR_WALLET_A);
        bytes32 settlementReplyHash = _replyHash(settlement);
        bytes32 expectedTransitionTaskHash = _derivedTaskHash(
            Workflow.Stage.RoundTransition,
            beforeSettlement.latestTaskSeq + 1,
            abi.encode(
                firstRoundId,
                beforeSettlement.scoreRoot,
                beforeSettlement.scoredCount,
                beforeSettlement.totalScore,
                settlementReplyHash
            ),
            block.timestamp,
            _taskExpiry(beforeSettlement.latestSettleTaskHash),
            settlementReplyHash,
            firstRoundId
        );

        VM.prank(EVALUATOR_WALLET_A);
        VM.expectEmit(true, false, false, true, address(workflow));
        emit WorkflowCompleted(firstRoundId, RunStatus.Success, expectedTransitionTaskHash, block.timestamp);
        workflow.onAgentReply(settlement);

        Workflow.RoundView memory settled = workflow.getRound(firstRoundId);
        assertEq(uint256(settled.status), uint256(Workflow.RoundStatus.Settled));
        assertEq(settled.settlementReplyHash, settlementReplyHash);
        assertEq(settled.transitionTaskHash, expectedTransitionTaskHash);
        assertEq(settled.totalScore, 17);
        assertEq(settled.settledAt, block.timestamp);
        assertEq(workflow.roundPoints(firstRoundId, CONTRIBUTOR_A_ID), 10);
        assertEq(workflow.roundPoints(firstRoundId, CONTRIBUTOR_B_ID), 7);
        assertEq(workflow.cumulativePoints(CONTRIBUTOR_A_ID), 10);
        assertEq(workflow.cumulativePoints(CONTRIBUTOR_B_ID), 7);
        assertFalse(workflow.getContribution(unscoredB).scored);

        (RunStatus status, bytes32 finalTaskHash, uint256 completedAt) = workflow.result(firstRoundId);
        assertEq(uint256(status), uint256(RunStatus.Success));
        assertEq(finalTaskHash, expectedTransitionTaskHash);
        assertEq(completedAt, block.timestamp);
        (AgentTask memory transitionTask, bool proven) = workflow.getAgentTask(expectedTransitionTaskHash);
        assertTrue(proven);
        assertEq(transitionTask.stage, uint8(Workflow.Stage.RoundTransition));
        assertEq(transitionTask.expiresAt, type(uint256).max);
        assertEq(transitionTask.prevReplyHashes.length, 1);
        assertEq(transitionTask.prevReplyHashes[0], settlementReplyHash);
    }

    function testEvaluatorWalletRotationAppliesToScoreSettleOpenAndComplete() public {
        (bytes32 firstContribution, bytes32 firstScoreTask) = _submitContribution(
            firstRoundId, firstCollectTaskHash, CONTRIBUTOR_A_ID, CONTRIBUTOR_A_WALLET, keccak256("rotation first")
        );
        registry.setAgentWallet(EVALUATOR_ID, EVALUATOR_WALLET_B);

        AgentReply memory oldScore =
            _scoreReply(firstRoundId, firstScoreTask, EVALUATOR_WALLET_A, EVALUATOR_ID, firstContribution, 1);
        VM.prank(EVALUATOR_WALLET_A);
        VM.expectRevert(
            abi.encodeWithSelector(
                Workflow.WrongAuthenticationWallet.selector, EVALUATOR_ID, EVALUATOR_WALLET_B, EVALUATOR_WALLET_A
            )
        );
        workflow.onAgentReply(oldScore);
        _score(firstRoundId, firstScoreTask, firstContribution, 1, EVALUATOR_WALLET_B);

        Workflow.RoundView memory scoredRound = workflow.getRound(firstRoundId);
        AgentReply memory oldSettlement = _settleReply(
            firstRoundId, scoredRound.latestSettleTaskHash, EVALUATOR_WALLET_A, EVALUATOR_ID, scoredRound.scoreRoot
        );
        VM.prank(EVALUATOR_WALLET_A);
        VM.expectRevert(
            abi.encodeWithSelector(
                Workflow.WrongAuthenticationWallet.selector, EVALUATOR_ID, EVALUATOR_WALLET_B, EVALUATOR_WALLET_A
            )
        );
        workflow.onAgentReply(oldSettlement);
        _settle(firstRoundId, EVALUATOR_WALLET_B);

        bytes32 transitionTask = workflow.getRound(firstRoundId).transitionTaskHash;
        AgentReply memory oldOpen =
            _transitionReply(Workflow.ActionKind.OpenNextRound, firstRoundId, transitionTask, EVALUATOR_WALLET_A);
        VM.prank(EVALUATOR_WALLET_A);
        VM.expectRevert(
            abi.encodeWithSelector(
                Workflow.WrongAuthenticationWallet.selector, EVALUATOR_ID, EVALUATOR_WALLET_B, EVALUATOR_WALLET_A
            )
        );
        workflow.onAgentReply(oldOpen);
        bytes32 secondRound = _openNextRound(firstRoundId, EVALUATOR_WALLET_B);

        Workflow.RoundView memory second = workflow.getRound(secondRound);
        (bytes32 secondContribution, bytes32 secondScoreTask) = _submitContribution(
            secondRound, second.collectTaskHash, CONTRIBUTOR_A_ID, CONTRIBUTOR_A_WALLET, keccak256("rotation second")
        );
        _score(secondRound, secondScoreTask, secondContribution, 2, EVALUATOR_WALLET_B);
        _settle(secondRound, EVALUATOR_WALLET_B);

        registry.setAgentWallet(EVALUATOR_ID, EVALUATOR_WALLET_A);
        bytes32 secondTransitionTask = workflow.getRound(secondRound).transitionTaskHash;
        AgentReply memory oldComplete = _transitionReply(
            Workflow.ActionKind.CompleteWorkflow, secondRound, secondTransitionTask, EVALUATOR_WALLET_B
        );
        VM.prank(EVALUATOR_WALLET_B);
        VM.expectRevert(
            abi.encodeWithSelector(
                Workflow.WrongAuthenticationWallet.selector, EVALUATOR_ID, EVALUATOR_WALLET_A, EVALUATOR_WALLET_B
            )
        );
        workflow.onAgentReply(oldComplete);
        _complete(secondRound, EVALUATOR_WALLET_A);
        assertEq(uint256(workflow.globalState()), uint256(Workflow.GlobalState.Completed));
    }

    function testThreeRoundsHaveDeterministicChainUniqueContributionsAndCumulativePoints() public {
        bytes32 sharedDigest = keccak256("same content each round");
        (bytes32 firstContribution, bytes32 firstScoreTask) = _submitContribution(
            firstRoundId, firstCollectTaskHash, CONTRIBUTOR_A_ID, CONTRIBUTOR_A_WALLET, sharedDigest
        );
        _score(firstRoundId, firstScoreTask, firstContribution, 1, EVALUATOR_WALLET_A);
        _settle(firstRoundId, EVALUATOR_WALLET_A);
        bytes32 secondRoundId = _openNextRound(firstRoundId, EVALUATOR_WALLET_A);
        assertEq(secondRoundId, keccak256(abi.encode(address(workflow), block.chainid, uint256(2), firstRoundId)));

        Workflow.RoundView memory secondRound = workflow.getRound(secondRoundId);
        assertEq(secondRound.previousRoundId, firstRoundId);
        _assertLinkedCollect(secondRoundId, firstRoundId, workflow.getRound(firstRoundId).transitionReplyHash);
        (bytes32 secondContribution, bytes32 secondScoreTask) = _submitContribution(
            secondRoundId, secondRound.collectTaskHash, CONTRIBUTOR_A_ID, CONTRIBUTOR_A_WALLET, sharedDigest
        );
        assertTrue(secondContribution != firstContribution);
        _score(secondRoundId, secondScoreTask, secondContribution, 2, EVALUATOR_WALLET_A);
        _settle(secondRoundId, EVALUATOR_WALLET_A);
        bytes32 thirdRoundId = _openNextRound(secondRoundId, EVALUATOR_WALLET_A);
        assertEq(thirdRoundId, keccak256(abi.encode(address(workflow), block.chainid, uint256(3), secondRoundId)));

        Workflow.RoundView memory thirdRound = workflow.getRound(thirdRoundId);
        assertEq(thirdRound.previousRoundId, secondRoundId);
        (bytes32 thirdContribution, bytes32 thirdScoreTask) = _submitContribution(
            thirdRoundId, thirdRound.collectTaskHash, CONTRIBUTOR_A_ID, CONTRIBUTOR_A_WALLET, sharedDigest
        );
        assertTrue(thirdContribution != firstContribution && thirdContribution != secondContribution);
        _score(thirdRoundId, thirdScoreTask, thirdContribution, 3, EVALUATOR_WALLET_A);
        _settle(thirdRoundId, EVALUATOR_WALLET_A);
        _complete(thirdRoundId, EVALUATOR_WALLET_A);

        assertEq(workflow.roundPoints(firstRoundId, CONTRIBUTOR_A_ID), 1);
        assertEq(workflow.roundPoints(secondRoundId, CONTRIBUTOR_A_ID), 2);
        assertEq(workflow.roundPoints(thirdRoundId, CONTRIBUTOR_A_ID), 3);
        assertEq(workflow.cumulativePoints(CONTRIBUTOR_A_ID), 6);
        assertEq(uint256(workflow.globalState()), uint256(Workflow.GlobalState.Completed));

        VM.prank(CONTRIBUTOR_A_WALLET);
        VM.expectRevert(Workflow.WorkflowIsCompleted.selector);
        workflow.onAgentReply(
            _contributionReply(
                thirdRoundId,
                thirdRound.collectTaskHash,
                CONTRIBUTOR_A_WALLET,
                CONTRIBUTOR_A_ID,
                keccak256("after complete")
            )
        );
        bytes memory input = bytes("after complete");
        VM.expectRevert(Workflow.WorkflowIsCompleted.selector);
        workflow.run(keccak256(input), input, block.timestamp + 7 days);
    }

    function testScoredRoundCanSettleAfterCollectWindowExpires() public {
        (bytes32 contributionId, bytes32 scoreTaskHash) = _submitContribution(
            firstRoundId, firstCollectTaskHash, CONTRIBUTOR_A_ID, CONTRIBUTOR_A_WALLET, keccak256("settle after window")
        );
        _score(firstRoundId, scoreTaskHash, contributionId, 5, EVALUATOR_WALLET_A);
        (AgentTask memory collectTask,) = workflow.getAgentTask(firstCollectTaskHash);
        VM.warp(collectTask.expiresAt + 1);

        _settle(firstRoundId, EVALUATOR_WALLET_A);
        assertEq(uint256(workflow.getRound(firstRoundId).status), uint256(Workflow.RoundStatus.Settled));
    }

    function testTransitionsRequireSettlementAndOnlyOneTransitionPerRound() public {
        AgentReply memory earlyOpen =
            _transitionReply(Workflow.ActionKind.OpenNextRound, firstRoundId, firstCollectTaskHash, EVALUATOR_WALLET_A);
        VM.prank(EVALUATOR_WALLET_A);
        VM.expectRevert(abi.encodeWithSelector(Workflow.RoundNotSettled.selector, firstRoundId));
        workflow.onAgentReply(earlyOpen);

        AgentReply memory earlyComplete = _transitionReply(
            Workflow.ActionKind.CompleteWorkflow, firstRoundId, firstCollectTaskHash, EVALUATOR_WALLET_A
        );
        VM.prank(EVALUATOR_WALLET_A);
        VM.expectRevert(abi.encodeWithSelector(Workflow.RoundNotSettled.selector, firstRoundId));
        workflow.onAgentReply(earlyComplete);

        (bytes32 contribution, bytes32 scoreTask) = _submitContribution(
            firstRoundId, firstCollectTaskHash, CONTRIBUTOR_A_ID, CONTRIBUTOR_A_WALLET, keccak256("transition")
        );
        _score(firstRoundId, scoreTask, contribution, 1, EVALUATOR_WALLET_A);
        _settle(firstRoundId, EVALUATOR_WALLET_A);
        bytes32 secondRound = _openNextRound(firstRoundId, EVALUATOR_WALLET_A);

        VM.warp(block.timestamp + 1);
        bytes32 oldTransitionTask = workflow.getRound(firstRoundId).transitionTaskHash;
        AgentReply memory secondOpen =
            _transitionReply(Workflow.ActionKind.OpenNextRound, firstRoundId, oldTransitionTask, EVALUATOR_WALLET_A);
        VM.prank(EVALUATOR_WALLET_A);
        VM.expectRevert(abi.encodeWithSelector(Workflow.RoundAlreadyTransitioned.selector, firstRoundId));
        workflow.onAgentReply(secondOpen);

        AgentReply memory secondComplete =
            _transitionReply(Workflow.ActionKind.CompleteWorkflow, firstRoundId, oldTransitionTask, EVALUATOR_WALLET_A);
        VM.prank(EVALUATOR_WALLET_A);
        VM.expectRevert(abi.encodeWithSelector(Workflow.RoundAlreadyTransitioned.selector, firstRoundId));
        workflow.onAgentReply(secondComplete);

        Workflow.RoundView memory current = workflow.getRound(secondRound);
        AgentReply memory completeBeforeSettlement = _transitionReply(
            Workflow.ActionKind.CompleteWorkflow, secondRound, current.collectTaskHash, EVALUATOR_WALLET_A
        );
        VM.prank(EVALUATOR_WALLET_A);
        VM.expectRevert(abi.encodeWithSelector(Workflow.RoundNotSettled.selector, secondRound));
        workflow.onAgentReply(completeBeforeSettlement);
    }

    function testSettledCurrentRoundRejectsContributionAndScoreAsNotOpenBeforeTransition() public {
        (bytes32 scoredContribution, bytes32 scoredTask) = _submitContribution(
            firstRoundId, firstCollectTaskHash, CONTRIBUTOR_A_ID, CONTRIBUTOR_A_WALLET, keccak256("scored before close")
        );
        (bytes32 unscoredContribution, bytes32 unscoredTask) = _submitContribution(
            firstRoundId,
            firstCollectTaskHash,
            CONTRIBUTOR_B_ID,
            CONTRIBUTOR_B_WALLET,
            keccak256("unscored before close")
        );
        _score(firstRoundId, scoredTask, scoredContribution, 1, EVALUATOR_WALLET_A);
        _settle(firstRoundId, EVALUATOR_WALLET_A);

        VM.prank(CONTRIBUTOR_A_WALLET);
        VM.expectRevert(abi.encodeWithSelector(Workflow.RoundNotOpen.selector, firstRoundId));
        workflow.onAgentReply(
            _contributionReply(
                firstRoundId,
                firstCollectTaskHash,
                CONTRIBUTOR_A_WALLET,
                CONTRIBUTOR_A_ID,
                keccak256("late contribution")
            )
        );

        VM.prank(EVALUATOR_WALLET_A);
        VM.expectRevert(abi.encodeWithSelector(Workflow.RoundNotOpen.selector, firstRoundId));
        workflow.onAgentReply(
            _scoreReply(firstRoundId, unscoredTask, EVALUATOR_WALLET_A, EVALUATOR_ID, unscoredContribution, 2)
        );
    }

    function testHistoricalRoundRejectsContributionAndScoreAsNotCurrentAfterNextRoundOpens() public {
        (bytes32 scoredContribution, bytes32 scoredTask) = _submitContribution(
            firstRoundId, firstCollectTaskHash, CONTRIBUTOR_A_ID, CONTRIBUTOR_A_WALLET, keccak256("score then advance")
        );
        (bytes32 unscoredContribution, bytes32 unscoredTask) = _submitContribution(
            firstRoundId, firstCollectTaskHash, CONTRIBUTOR_B_ID, CONTRIBUTOR_B_WALLET, keccak256("historical unscored")
        );
        _score(firstRoundId, scoredTask, scoredContribution, 1, EVALUATOR_WALLET_A);
        _settle(firstRoundId, EVALUATOR_WALLET_A);
        bytes32 secondRoundId = _openNextRound(firstRoundId, EVALUATOR_WALLET_A);

        VM.prank(CONTRIBUTOR_A_WALLET);
        VM.expectRevert(abi.encodeWithSelector(Workflow.RoundNotCurrent.selector, secondRoundId, firstRoundId));
        workflow.onAgentReply(
            _contributionReply(
                firstRoundId,
                firstCollectTaskHash,
                CONTRIBUTOR_A_WALLET,
                CONTRIBUTOR_A_ID,
                keccak256("historical contribution")
            )
        );

        VM.prank(EVALUATOR_WALLET_A);
        VM.expectRevert(abi.encodeWithSelector(Workflow.RoundNotCurrent.selector, secondRoundId, firstRoundId));
        workflow.onAgentReply(
            _scoreReply(firstRoundId, unscoredTask, EVALUATOR_WALLET_A, EVALUATOR_ID, unscoredContribution, 2)
        );
    }

    function testEveryNewActionRejectsNonCanonicalStaticEncoding() public {
        bytes[] memory canonical = new bytes[](4);
        canonical[0] = abi.encode(
            Workflow.ActionKind.ScoreContribution, EVALUATOR_ID, firstRoundId, keccak256("contribution"), uint256(1)
        );
        canonical[1] = abi.encode(Workflow.ActionKind.SettleRound, EVALUATOR_ID, firstRoundId, keccak256("root"));
        canonical[2] = abi.encode(Workflow.ActionKind.OpenNextRound, EVALUATOR_ID, firstRoundId);
        canonical[3] = abi.encode(Workflow.ActionKind.CompleteWorkflow, EVALUATOR_ID, firstRoundId);

        for (uint256 i; i < canonical.length; ++i) {
            bytes memory malformed = abi.encodePacked(canonical[i], bytes1(0));
            VM.prank(EVALUATOR_WALLET_A);
            VM.expectRevert(Workflow.MalformedAction.selector);
            workflow.onAgentReply(_rawReply(firstRoundId, firstCollectTaskHash, EVALUATOR_WALLET_A, malformed));
        }

        VM.prank(EVALUATOR_WALLET_A);
        VM.expectRevert(abi.encodeWithSelector(Workflow.UnsupportedAction.selector, uint256(5)));
        workflow.onAgentReply(_rawReply(firstRoundId, firstCollectTaskHash, EVALUATOR_WALLET_A, abi.encode(uint256(5))));
    }

    function _register(uint256 agentId, address wallet) private {
        registry.register(agentId, OWNER, wallet);
        profile.setMember(agentId, true);
    }

    function _assertLinkedCollect(bytes32 roundId, bytes32 previousRoundId, bytes32 transitionReplyHash) private view {
        Workflow.RoundView memory round = workflow.getRound(roundId);
        (AgentTask memory collectTask, bool proven) = workflow.getAgentTask(round.collectTaskHash);
        assertTrue(proven);
        assertEq(collectTask.taskSeq, 0);
        assertEq(collectTask.prevReplyHashes.length, 0);
        assertEq(keccak256(collectTask.input), keccak256(abi.encode(previousRoundId, transitionReplyHash)));
    }

    function _startInitialRound() private returns (bytes32 roundId, bytes32 collectTaskHash) {
        bytes memory input = bytes("demo initial round");
        bytes32 inputHash = keccak256(input);
        uint256 expiresAt = block.timestamp + 7 days;
        VM.prank(EVALUATOR_WALLET_A);
        roundId = workflow.run(inputHash, input, expiresAt);
        collectTaskHash = _initialTaskHash(roundId, inputHash, input, expiresAt, block.timestamp);
    }

    function _submitContribution(
        bytes32 roundId,
        bytes32 collectTaskHash,
        uint256 contributorAgentId,
        address wallet,
        bytes32 digest
    ) private returns (bytes32 contributionId, bytes32 scoreTaskHash) {
        AgentReply memory reply = _contributionReply(roundId, collectTaskHash, wallet, contributorAgentId, digest);
        contributionId = keccak256(abi.encode(address(workflow), roundId, contributorAgentId, digest));
        VM.prank(wallet);
        workflow.onAgentReply(reply);
        scoreTaskHash = workflow.getContribution(contributionId).scoreTaskHash;
    }

    function _score(bytes32 roundId, bytes32 scoreTaskHash, bytes32 contributionId, uint256 score, address wallet)
        private
    {
        VM.prank(wallet);
        workflow.onAgentReply(_scoreReply(roundId, scoreTaskHash, wallet, EVALUATOR_ID, contributionId, score));
    }

    function _settle(bytes32 roundId, address wallet) private {
        AgentReply memory reply = _settlementReply(roundId, wallet);
        VM.prank(wallet);
        workflow.onAgentReply(reply);
    }

    function _settlementReply(bytes32 roundId, address wallet) private view returns (AgentReply memory) {
        Workflow.RoundView memory round = workflow.getRound(roundId);
        return _settleReply(roundId, round.latestSettleTaskHash, wallet, EVALUATOR_ID, round.scoreRoot);
    }

    function _openNextRound(bytes32 settledRoundId, address wallet) private returns (bytes32 nextRoundId) {
        Workflow.RoundView memory settled = workflow.getRound(settledRoundId);
        VM.prank(wallet);
        workflow.onAgentReply(
            _transitionReply(Workflow.ActionKind.OpenNextRound, settledRoundId, settled.transitionTaskHash, wallet)
        );
        nextRoundId = workflow.currentRoundId();
    }

    function _complete(bytes32 settledRoundId, address wallet) private {
        Workflow.RoundView memory settled = workflow.getRound(settledRoundId);
        VM.prank(wallet);
        workflow.onAgentReply(
            _transitionReply(Workflow.ActionKind.CompleteWorkflow, settledRoundId, settled.transitionTaskHash, wallet)
        );
    }

    function _contributionReply(
        bytes32 roundId,
        bytes32 collectTaskHash,
        address wallet,
        uint256 contributorAgentId,
        bytes32 digest
    ) private view returns (AgentReply memory) {
        bytes32 contributionId = keccak256(abi.encode(address(workflow), roundId, contributorAgentId, digest));
        bytes memory output = abi.encode(
            Workflow.ActionKind.SubmitContribution,
            contributorAgentId,
            roundId,
            contributionId,
            bytes("git:contribution"),
            digest
        );
        return _rawReply(roundId, collectTaskHash, wallet, output);
    }

    function _scoreReply(
        bytes32 roundId,
        bytes32 scoreTaskHash,
        address wallet,
        uint256 evaluatorId,
        bytes32 contributionId,
        uint256 score
    ) private view returns (AgentReply memory) {
        return _rawReply(
            roundId,
            scoreTaskHash,
            wallet,
            abi.encode(Workflow.ActionKind.ScoreContribution, evaluatorId, roundId, contributionId, score)
        );
    }

    function _settleReply(
        bytes32 roundId,
        bytes32 settleTaskHash,
        address wallet,
        uint256 evaluatorId,
        bytes32 expectedScoreRoot
    ) private view returns (AgentReply memory) {
        return _rawReply(
            roundId,
            settleTaskHash,
            wallet,
            abi.encode(Workflow.ActionKind.SettleRound, evaluatorId, roundId, expectedScoreRoot)
        );
    }

    function _transitionReply(
        Workflow.ActionKind action,
        bytes32 settledRoundId,
        bytes32 transitionTaskHash,
        address wallet
    ) private view returns (AgentReply memory) {
        return _rawReply(settledRoundId, transitionTaskHash, wallet, abi.encode(action, EVALUATOR_ID, settledRoundId));
    }

    function _rawReply(bytes32 roundId, bytes32 taskHash, address wallet, bytes memory output)
        private
        view
        returns (AgentReply memory reply)
    {
        bytes32[] memory previousTasks = new bytes32[](1);
        previousTasks[0] = taskHash;
        reply = AgentReply({
            outputHash: keccak256(output),
            output: output,
            timestamp: block.timestamp,
            replier: wallet,
            prevTaskHashes: previousTasks,
            workflowRunId: roundId
        });
    }

    function _initialTaskHash(bytes32 roundId, bytes32 inputHash, bytes memory, uint256 expiresAt, uint256 timestamp)
        private
        pure
        returns (bytes32)
    {
        bytes32[] memory previousReplies = new bytes32[](0);
        return keccak256(
            abi.encode(
                uint8(Workflow.Stage.Collect),
                uint256(0),
                inputHash,
                timestamp,
                expiresAt,
                keccak256(abi.encodePacked(previousReplies)),
                roundId
            )
        );
    }

    function _derivedTaskHash(
        Workflow.Stage stage,
        uint256 taskSeq,
        bytes memory input,
        uint256 timestamp,
        uint256 expiresAt,
        bytes32 previousReplyHash,
        bytes32 roundId
    ) private pure returns (bytes32) {
        bytes32[] memory previousReplies = new bytes32[](1);
        previousReplies[0] = previousReplyHash;
        return keccak256(
            abi.encode(
                uint8(stage),
                taskSeq,
                keccak256(input),
                timestamp,
                expiresAt,
                keccak256(abi.encodePacked(previousReplies)),
                roundId
            )
        );
    }

    function _taskExpiry(bytes32 taskHash) private view returns (uint256 expiresAt) {
        (AgentTask memory task,) = workflow.getAgentTask(taskHash);
        return task.expiresAt;
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
