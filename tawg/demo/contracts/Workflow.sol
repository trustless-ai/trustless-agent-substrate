// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {AgentReply, AgentTask, IAgentWorkflow, RunStatus} from "@agent-ercs/execution/ERC8301/IAgentWorkflow.sol";
import {IAgentVerifier} from "@agent-ercs/verify/ERC8274/IAgentVerifier.sol";

interface ITAWGProfileRead {
    function identityRegistry() external view returns (address);

    function getAgent(uint256 agentId) external view returns (bool isMember, string memory data, address verifier);
}

interface IIdentityRegistryRead {
    function ownerOf(uint256 agentId) external view returns (address);

    function getAgentWallet(uint256 agentId) external view returns (address);
}

/// @notice Directly deployed multi-round ERC-8301 Workflow for the Demo TAWG.
/// @dev Contributor and Evaluator replies use live Profile membership and ERC-8004 wallet
///      authority. Every action is intentionally proof-free through one immutable pass-through
///      verifier. Those results are acceptance records, not evidence that a score is correct.
contract Workflow is IAgentWorkflow {
    error InvalidConfiguration();
    error InvalidInputCommitment();
    error InvalidExpiry();
    error UnknownRun(bytes32 workflowRunId);
    error UnknownTask(bytes32 taskHash);
    error UnknownReply(bytes32 replyHash);
    error UnauthorizedReplier();
    error InvalidOutputCommitment();
    error InvalidPreviousTaskCount();
    error UnprovenTask(bytes32 taskHash);
    error RunMismatch();
    error FutureReplyTimestamp();
    error ReplyBeforeTask();
    error TaskExpired();
    error DuplicateTask(bytes32 taskHash);
    error DuplicateReply(bytes32 replyHash);
    error InvalidProofBatch();
    error ReplyAlreadyProven(bytes32 replyHash);
    error ProofSubmissionUnsupported();
    error VerifierRejected();
    error InvalidVerificationDigest();
    error ReentrantVerifierCall();
    error IdentityNotFound(uint256 agentId);
    error NotProfileMember(uint256 agentId);
    error AuthenticationWalletUnset(uint256 agentId);
    error WrongAuthenticationWallet(uint256 agentId, address expected, address actual);
    error MalformedAction();
    error UnsupportedAction(uint256 action);
    error ContributionRoundMismatch(bytes32 expected, bytes32 supplied);
    error InvalidCollectTask(bytes32 roundId, bytes32 taskHash);
    error EmptyDAReference();
    error ZeroDADigest();
    error ContributionIdMismatch(bytes32 expected, bytes32 supplied);
    error DuplicateContribution(bytes32 contributionId);
    error UnknownContribution(bytes32 contributionId);
    error ContributionIndexOutOfBounds(bytes32 roundId, uint256 index);
    error WorkflowIsCompleted();
    error InitialRoundAlreadyStarted();
    error RoundNotCurrent(bytes32 expected, bytes32 supplied);
    error RoundNotOpen(bytes32 roundId);
    error EvaluatorAgentMismatch(uint256 expected, uint256 supplied);
    error InvalidScoreTask(bytes32 contributionId, bytes32 taskHash);
    error ContributionAlreadyScored(bytes32 contributionId);
    error NoScoredContributions(bytes32 roundId);
    error InvalidLatestSettleTask(bytes32 roundId, bytes32 taskHash);
    error ScoreRootMismatch(bytes32 expected, bytes32 supplied);
    error RoundAlreadySettled(bytes32 roundId);
    error RoundNotSettled(bytes32 roundId);
    error InvalidTransitionTask(bytes32 roundId, bytes32 taskHash);
    error RoundAlreadyTransitioned(bytes32 roundId);

    event AgentReplyAnchored(bytes32 indexed workflowRunId, bytes32 indexed replyHash, address indexed replier);
    event ContributionSubmitted(
        bytes32 indexed contributionId,
        bytes32 indexed roundId,
        uint256 indexed contributorAgentId,
        bytes32 submitReplyHash,
        bytes32 daDigest
    );
    event ContributionScored(
        bytes32 indexed contributionId,
        bytes32 indexed roundId,
        uint256 indexed evaluatorAgentId,
        uint256 score,
        bytes32 scoreReplyHash,
        bytes32 scoreRoot
    );
    event RoundSettled(
        bytes32 indexed roundId,
        bytes32 indexed settlementReplyHash,
        bytes32 indexed transitionTaskHash,
        bytes32 scoreRoot,
        uint256 scoredCount,
        uint256 totalScore
    );
    event NextRoundOpened(
        bytes32 indexed settledRoundId, bytes32 indexed nextRoundId, bytes32 indexed transitionReplyHash
    );
    event DemoCompleted(bytes32 indexed finalRoundId, bytes32 indexed transitionReplyHash);

    enum ActionKind {
        SubmitContribution,
        ScoreContribution,
        SettleRound,
        OpenNextRound,
        CompleteWorkflow
    }

    enum Stage {
        Collect,
        ScoreContribution,
        SettleRound,
        RoundTransition
    }

    enum GlobalState {
        Active,
        Completed
    }

    enum RoundStatus {
        Open,
        Settled
    }

    struct RunRecord {
        bool exists;
        RunStatus status;
        bytes32 finalTaskHash;
        uint256 completedAt;
    }

    struct ContributionView {
        bool exists;
        bytes32 roundId;
        uint256 contributorAgentId;
        bytes daReference;
        bytes32 daDigest;
        bytes32 submitReplyHash;
        bytes32 scoreTaskHash;
        bool scored;
        uint256 score;
        bytes32 scoreReplyHash;
    }

    struct RoundView {
        bool exists;
        RoundStatus status;
        bytes32 previousRoundId;
        bytes32 collectTaskHash;
        bytes32 latestSettleTaskHash;
        bytes32 transitionTaskHash;
        bytes32 scoreRoot;
        uint256 contributionCount;
        uint256 scoredCount;
        uint256 totalScore;
        uint256 settledAt;
        bytes32 settlementReplyHash;
        uint256 latestTaskSeq;
        bool transitioned;
        bytes32 transitionReplyHash;
        bytes32 nextRoundId;
    }

    struct ContributionActionData {
        uint256 contributorAgentId;
        bytes32 roundId;
        bytes32 contributionId;
        bytes daReference;
        bytes32 daDigest;
    }

    uint8 internal constant INITIAL_STAGE = uint8(Stage.Collect);

    address public immutable profile;
    address public immutable passThroughVerifier;
    uint256 public immutable evaluatorAgentId;

    uint256 private _runSequence;
    bool private _verifierCallActive;
    bool private _initialRoundStarted;

    GlobalState public globalState;
    bytes32 public currentRoundId;

    mapping(bytes32 workflowRunId => RunRecord record) private _runs;
    mapping(bytes32 taskHash => AgentTask task) private _tasks;
    mapping(bytes32 taskHash => bool exists) private _taskExists;
    mapping(bytes32 taskHash => bool proven) private _taskProven;
    mapping(bytes32 replyHash => AgentReply reply) private _replies;
    mapping(bytes32 replyHash => bool exists) private _replyExists;
    mapping(bytes32 replyHash => address verifier) private _replyVerifier;
    mapping(bytes32 replyHash => bool proven) private _replyProven;
    mapping(bytes32 replyHash => bytes32 digest) private _replyVerificationDigest;
    mapping(bytes32 workflowRunId => bytes32 taskHash) private _collectTaskHashes;
    mapping(bytes32 contributionId => ContributionView contribution) private _contributions;
    mapping(bytes32 roundId => bytes32[] contributionIds) private _roundContributionIds;
    mapping(bytes32 roundId => RoundView round) private _rounds;
    mapping(bytes32 roundId => mapping(uint256 agentId => uint256 points)) private _roundPoints;
    mapping(uint256 agentId => uint256 points) private _cumulativePoints;

    modifier notDuringVerifierCall() {
        if (_verifierCallActive) revert ReentrantVerifierCall();
        _;
    }

    constructor(address profile_, address passThroughVerifier_, uint256 evaluatorAgentId_) {
        if (profile_ == address(0) || passThroughVerifier_.code.length == 0) revert InvalidConfiguration();
        profile = profile_;
        passThroughVerifier = passThroughVerifier_;
        evaluatorAgentId = evaluatorAgentId_;
    }

    function run(bytes32 inputHash, bytes calldata input, uint256 expiresAt)
        external
        override
        notDuringVerifierCall
        returns (bytes32 workflowRunId)
    {
        if (globalState == GlobalState.Completed) revert WorkflowIsCompleted();
        if (_initialRoundStarted) revert InitialRoundAlreadyStarted();
        if (inputHash != keccak256(input)) revert InvalidInputCommitment();
        if (expiresAt <= block.timestamp) revert InvalidExpiry();
        _authenticateAgent(evaluatorAgentId, msg.sender);

        _initialRoundStarted = true;
        uint256 sequence = ++_runSequence;
        workflowRunId = keccak256(abi.encode(address(this), block.chainid, sequence, msg.sender, inputHash, expiresAt));
        _runs[workflowRunId] =
            RunRecord({exists: true, status: RunStatus.Pending, finalTaskHash: bytes32(0), completedAt: 0});

        bytes32[] memory previousReplies = new bytes32[](0);
        AgentTask memory initialTask = AgentTask({
            stage: INITIAL_STAGE,
            taskSeq: 0,
            inputHash: inputHash,
            input: input,
            timestamp: block.timestamp,
            expiresAt: expiresAt,
            prevReplyHashes: previousReplies,
            workflowRunId: workflowRunId
        });
        bytes32 collectTaskHash = _storeTask(initialTask, true);
        _collectTaskHashes[workflowRunId] = collectTaskHash;
        _rounds[workflowRunId] = RoundView({
            exists: true,
            status: RoundStatus.Open,
            previousRoundId: bytes32(0),
            collectTaskHash: collectTaskHash,
            latestSettleTaskHash: bytes32(0),
            transitionTaskHash: bytes32(0),
            scoreRoot: bytes32(0),
            contributionCount: 0,
            scoredCount: 0,
            totalScore: 0,
            settledAt: 0,
            settlementReplyHash: bytes32(0),
            latestTaskSeq: 0,
            transitioned: false,
            transitionReplyHash: bytes32(0),
            nextRoundId: bytes32(0)
        });
        currentRoundId = workflowRunId;
    }

    function result(bytes32 workflowRunId)
        external
        view
        override
        returns (RunStatus status, bytes32 finalTaskHash, uint256 completedAt)
    {
        RunRecord storage record = _runs[workflowRunId];
        if (!record.exists) revert UnknownRun(workflowRunId);
        return (record.status, record.finalTaskHash, record.completedAt);
    }

    function getAgentTask(bytes32 taskHash) external view override returns (AgentTask memory task, bool proven) {
        if (!_taskExists[taskHash]) revert UnknownTask(taskHash);
        return (_tasks[taskHash], _taskProven[taskHash]);
    }

    function getAgentReply(bytes32 replyHash)
        external
        view
        override
        returns (AgentReply memory reply, address verifier, bool proven, bytes32 verificationDigest)
    {
        if (!_replyExists[replyHash]) revert UnknownReply(replyHash);
        return (
            _replies[replyHash], _replyVerifier[replyHash], _replyProven[replyHash], _replyVerificationDigest[replyHash]
        );
    }

    function getContribution(bytes32 contributionId) external view returns (ContributionView memory contribution) {
        contribution = _contributions[contributionId];
        if (!contribution.exists) revert UnknownContribution(contributionId);
    }

    function contributionCount(bytes32 roundId) external view returns (uint256) {
        if (!_runs[roundId].exists) revert UnknownRun(roundId);
        return _roundContributionIds[roundId].length;
    }

    function contributionIdAt(bytes32 roundId, uint256 index) external view returns (bytes32) {
        if (!_runs[roundId].exists) revert UnknownRun(roundId);
        if (index >= _roundContributionIds[roundId].length) revert ContributionIndexOutOfBounds(roundId, index);
        return _roundContributionIds[roundId][index];
    }

    function getRound(bytes32 roundId) external view returns (RoundView memory round) {
        round = _rounds[roundId];
        if (!round.exists) revert UnknownRun(roundId);
    }

    function roundPoints(bytes32 roundId, uint256 agentId) external view returns (uint256) {
        if (!_rounds[roundId].exists) revert UnknownRun(roundId);
        return _roundPoints[roundId][agentId];
    }

    function cumulativePoints(uint256 agentId) external view returns (uint256) {
        return _cumulativePoints[agentId];
    }

    function onAgentReply(AgentReply calldata reply) external override notDuringVerifierCall {
        if (globalState == GlobalState.Completed) revert WorkflowIsCompleted();
        if (reply.replier != msg.sender) revert UnauthorizedReplier();
        if (reply.outputHash != keccak256(reply.output)) revert InvalidOutputCommitment();
        if (reply.prevTaskHashes.length != 1) revert InvalidPreviousTaskCount();
        if (reply.timestamp > block.timestamp) revert FutureReplyTimestamp();

        bytes32 taskHash = reply.prevTaskHashes[0];
        if (!_taskExists[taskHash]) revert UnknownTask(taskHash);
        if (!_taskProven[taskHash]) revert UnprovenTask(taskHash);
        AgentTask storage previousTask = _tasks[taskHash];
        if (reply.workflowRunId != previousTask.workflowRunId) revert RunMismatch();
        if (reply.timestamp < previousTask.timestamp) revert ReplyBeforeTask();
        if (block.timestamp > previousTask.expiresAt) revert TaskExpired();
        bytes32 candidateReplyHash = _hashReply(reply);
        if (_replyExists[candidateReplyHash]) revert DuplicateReply(candidateReplyHash);

        ActionKind action = _readAction(reply.output);
        if (action == ActionKind.SubmitContribution) {
            _handleContribution(reply, taskHash, previousTask);
        } else if (action == ActionKind.ScoreContribution) {
            _handleScore(reply, taskHash, previousTask);
        } else if (action == ActionKind.SettleRound) {
            _handleSettlement(reply, taskHash, previousTask);
        } else {
            _handleTransition(reply, taskHash, previousTask, action);
        }
    }

    function _handleContribution(AgentReply calldata reply, bytes32 taskHash, AgentTask storage previousTask) private {
        ContributionActionData memory action = _decodeContributionAction(reply.output);

        if (action.roundId != reply.workflowRunId) {
            revert ContributionRoundMismatch(reply.workflowRunId, action.roundId);
        }
        if (!_runs[action.roundId].exists) revert UnknownRun(action.roundId);
        if (action.roundId != currentRoundId) revert RoundNotCurrent(currentRoundId, action.roundId);
        RoundView storage round = _rounds[action.roundId];
        if (round.status != RoundStatus.Open) revert RoundNotOpen(action.roundId);
        if (_collectTaskHashes[action.roundId] != taskHash) revert InvalidCollectTask(action.roundId, taskHash);
        if (action.daReference.length == 0) revert EmptyDAReference();
        if (action.daDigest == bytes32(0)) revert ZeroDADigest();

        _authenticateAgent(action.contributorAgentId, reply.replier);

        bytes32 expectedContributionId =
            keccak256(abi.encode(address(this), action.roundId, action.contributorAgentId, action.daDigest));
        if (action.contributionId != expectedContributionId) {
            revert ContributionIdMismatch(expectedContributionId, action.contributionId);
        }
        if (_contributions[expectedContributionId].exists) revert DuplicateContribution(expectedContributionId);

        bytes32 replyHash = _anchorProofFreeReply(reply, taskHash, previousTask, action.contributorAgentId);
        _contributions[expectedContributionId] = ContributionView({
            exists: true,
            roundId: action.roundId,
            contributorAgentId: action.contributorAgentId,
            daReference: action.daReference,
            daDigest: action.daDigest,
            submitReplyHash: replyHash,
            scoreTaskHash: bytes32(0),
            scored: false,
            score: 0,
            scoreReplyHash: bytes32(0)
        });
        _roundContributionIds[action.roundId].push(expectedContributionId);
        round.contributionCount += 1;

        bytes memory scoreTaskInput =
            abi.encode(action.roundId, expectedContributionId, action.contributorAgentId, action.daDigest);
        bytes32 scoreTaskHash = _storeDerivedTask(
            round, action.roundId, Stage.ScoreContribution, scoreTaskInput, replyHash, previousTask.expiresAt
        );
        _contributions[expectedContributionId].scoreTaskHash = scoreTaskHash;
        emit ContributionSubmitted(
            expectedContributionId, action.roundId, action.contributorAgentId, replyHash, action.daDigest
        );
    }

    function _handleScore(AgentReply calldata reply, bytes32 taskHash, AgentTask storage previousTask) private {
        (uint256 suppliedEvaluatorId, bytes32 roundId, bytes32 contributionId, uint256 score) =
            _decodeScoreAction(reply.output);
        if (suppliedEvaluatorId != evaluatorAgentId) {
            revert EvaluatorAgentMismatch(evaluatorAgentId, suppliedEvaluatorId);
        }
        if (roundId != reply.workflowRunId) revert ContributionRoundMismatch(reply.workflowRunId, roundId);
        if (!_runs[roundId].exists) revert UnknownRun(roundId);

        ContributionView storage contribution = _contributions[contributionId];
        if (!contribution.exists) revert UnknownContribution(contributionId);
        if (roundId != currentRoundId) revert RoundNotCurrent(currentRoundId, roundId);
        RoundView storage round = _rounds[roundId];
        if (round.status != RoundStatus.Open) revert RoundNotOpen(roundId);
        if (contribution.roundId != roundId) revert ContributionRoundMismatch(contribution.roundId, roundId);
        if (contribution.scoreTaskHash != taskHash) revert InvalidScoreTask(contributionId, taskHash);
        if (contribution.scored) revert ContributionAlreadyScored(contributionId);

        _authenticateAgent(evaluatorAgentId, reply.replier);
        bytes32 scoreReplyHash = _anchorProofFreeReply(reply, taskHash, previousTask, evaluatorAgentId);

        contribution.scored = true;
        contribution.score = score;
        contribution.scoreReplyHash = scoreReplyHash;
        round.scoreRoot = keccak256(abi.encode(round.scoreRoot, contributionId, score, scoreReplyHash));
        round.scoredCount += 1;
        round.totalScore += score;

        bytes memory settleTaskInput = abi.encode(roundId, round.scoreRoot, round.scoredCount, round.totalScore);
        round.latestSettleTaskHash =
            _storeDerivedTask(round, roundId, Stage.SettleRound, settleTaskInput, scoreReplyHash, type(uint256).max);
        emit ContributionScored(contributionId, roundId, evaluatorAgentId, score, scoreReplyHash, round.scoreRoot);
    }

    function _handleSettlement(AgentReply calldata reply, bytes32 taskHash, AgentTask storage previousTask) private {
        (uint256 suppliedEvaluatorId, bytes32 roundId, bytes32 expectedScoreRoot) =
            _decodeSettlementAction(reply.output);
        if (suppliedEvaluatorId != evaluatorAgentId) {
            revert EvaluatorAgentMismatch(evaluatorAgentId, suppliedEvaluatorId);
        }
        if (roundId != reply.workflowRunId) revert ContributionRoundMismatch(reply.workflowRunId, roundId);
        if (!_runs[roundId].exists) revert UnknownRun(roundId);

        RoundView storage round = _rounds[roundId];
        if (round.status == RoundStatus.Settled) revert RoundAlreadySettled(roundId);
        if (roundId != currentRoundId) revert RoundNotCurrent(currentRoundId, roundId);
        _authenticateAgent(evaluatorAgentId, reply.replier);
        if (round.scoredCount == 0) revert NoScoredContributions(roundId);
        if (round.latestSettleTaskHash != taskHash) revert InvalidLatestSettleTask(roundId, taskHash);
        if (round.scoreRoot != expectedScoreRoot) revert ScoreRootMismatch(round.scoreRoot, expectedScoreRoot);

        bytes32 settlementReplyHash = _anchorProofFreeReply(reply, taskHash, previousTask, evaluatorAgentId);
        round.status = RoundStatus.Settled;
        round.settledAt = block.timestamp;
        round.settlementReplyHash = settlementReplyHash;

        bytes32[] storage contributionIds = _roundContributionIds[roundId];
        for (uint256 i; i < contributionIds.length; ++i) {
            ContributionView storage contribution = _contributions[contributionIds[i]];
            if (contribution.scored) {
                _roundPoints[roundId][contribution.contributorAgentId] += contribution.score;
                _cumulativePoints[contribution.contributorAgentId] += contribution.score;
            }
        }

        bytes memory transitionTaskInput =
            abi.encode(roundId, round.scoreRoot, round.scoredCount, round.totalScore, settlementReplyHash);
        round.transitionTaskHash = _storeDerivedTask(
            round, roundId, Stage.RoundTransition, transitionTaskInput, settlementReplyHash, type(uint256).max
        );

        RunRecord storage runRecord = _runs[roundId];
        runRecord.status = RunStatus.Success;
        runRecord.finalTaskHash = round.transitionTaskHash;
        runRecord.completedAt = block.timestamp;
        emit RoundSettled(
            roundId, settlementReplyHash, round.transitionTaskHash, round.scoreRoot, round.scoredCount, round.totalScore
        );
        emit WorkflowCompleted(roundId, RunStatus.Success, round.transitionTaskHash, block.timestamp);
    }

    function _handleTransition(
        AgentReply calldata reply,
        bytes32 taskHash,
        AgentTask storage previousTask,
        ActionKind action
    ) private {
        (uint256 suppliedEvaluatorId, bytes32 settledRoundId) = _decodeTransitionAction(reply.output, action);
        if (suppliedEvaluatorId != evaluatorAgentId) {
            revert EvaluatorAgentMismatch(evaluatorAgentId, suppliedEvaluatorId);
        }
        if (settledRoundId != reply.workflowRunId) {
            revert ContributionRoundMismatch(reply.workflowRunId, settledRoundId);
        }
        if (!_runs[settledRoundId].exists) revert UnknownRun(settledRoundId);

        RoundView storage settledRound = _rounds[settledRoundId];
        if (settledRound.transitioned) revert RoundAlreadyTransitioned(settledRoundId);
        if (settledRound.status != RoundStatus.Settled) revert RoundNotSettled(settledRoundId);
        if (settledRoundId != currentRoundId) revert RoundNotCurrent(currentRoundId, settledRoundId);
        if (settledRound.transitionTaskHash != taskHash) revert InvalidTransitionTask(settledRoundId, taskHash);
        _authenticateAgent(evaluatorAgentId, reply.replier);

        bytes32 transitionReplyHash = _anchorProofFreeReply(reply, taskHash, previousTask, evaluatorAgentId);
        settledRound.transitioned = true;
        settledRound.transitionReplyHash = transitionReplyHash;

        if (action == ActionKind.OpenNextRound) {
            bytes32 nextRoundId = _openNextRound(settledRoundId, transitionReplyHash);
            settledRound.nextRoundId = nextRoundId;
            emit NextRoundOpened(settledRoundId, nextRoundId, transitionReplyHash);
        } else {
            globalState = GlobalState.Completed;
            emit DemoCompleted(settledRoundId, transitionReplyHash);
        }
    }

    function _authenticateAgent(uint256 agentId, address replier) private view {
        address registryAddress = ITAWGProfileRead(profile).identityRegistry();
        try IIdentityRegistryRead(registryAddress).ownerOf(agentId) returns (address owner) {
            if (owner == address(0)) revert IdentityNotFound(agentId);
        } catch {
            revert IdentityNotFound(agentId);
        }

        (bool isMember,,) = ITAWGProfileRead(profile).getAgent(agentId);
        if (!isMember) revert NotProfileMember(agentId);

        address authenticationWallet = IIdentityRegistryRead(registryAddress).getAgentWallet(agentId);
        if (authenticationWallet == address(0)) revert AuthenticationWalletUnset(agentId);
        if (replier != authenticationWallet) {
            revert WrongAuthenticationWallet(agentId, authenticationWallet, replier);
        }
    }

    function _readAction(bytes calldata output) private pure returns (ActionKind action) {
        if (output.length < 32) revert MalformedAction();
        uint256 actionValue;
        assembly ("memory-safe") {
            actionValue := calldataload(output.offset)
        }
        if (actionValue > uint256(ActionKind.CompleteWorkflow)) revert UnsupportedAction(actionValue);
        action = ActionKind(actionValue);
    }

    function _decodeContributionAction(bytes calldata output)
        private
        pure
        returns (ContributionActionData memory data)
    {
        // Six ABI head words followed by a canonical bytes tail.
        if (output.length < 224) revert MalformedAction();
        uint256 referenceOffset;
        uint256 referenceLength;
        assembly ("memory-safe") {
            referenceOffset := calldataload(add(output.offset, 128))
            referenceLength := calldataload(add(output.offset, 192))
        }
        if (referenceOffset != 192 || referenceLength > type(uint256).max - 31) revert MalformedAction();
        uint256 paddedReferenceLength = (referenceLength + 31) & ~uint256(31);
        if (paddedReferenceLength > type(uint256).max - 224) revert MalformedAction();
        if (output.length != 224 + paddedReferenceLength) revert MalformedAction();

        ActionKind decodedAction;
        (decodedAction, data.contributorAgentId, data.roundId, data.contributionId, data.daReference, data.daDigest) =
            abi.decode(output, (ActionKind, uint256, bytes32, bytes32, bytes, bytes32));
        bytes memory canonicalOutput = abi.encode(
            decodedAction, data.contributorAgentId, data.roundId, data.contributionId, data.daReference, data.daDigest
        );
        if (keccak256(output) != keccak256(canonicalOutput)) revert MalformedAction();
    }

    function _decodeScoreAction(bytes calldata output)
        private
        pure
        returns (uint256 suppliedEvaluatorId, bytes32 roundId, bytes32 contributionId, uint256 score)
    {
        if (output.length != 160) revert MalformedAction();
        ActionKind action;
        (action, suppliedEvaluatorId, roundId, contributionId, score) =
            abi.decode(output, (ActionKind, uint256, bytes32, bytes32, uint256));
        if (action != ActionKind.ScoreContribution) revert MalformedAction();
    }

    function _decodeSettlementAction(bytes calldata output)
        private
        pure
        returns (uint256 suppliedEvaluatorId, bytes32 roundId, bytes32 expectedScoreRoot)
    {
        if (output.length != 128) revert MalformedAction();
        ActionKind action;
        (action, suppliedEvaluatorId, roundId, expectedScoreRoot) =
            abi.decode(output, (ActionKind, uint256, bytes32, bytes32));
        if (action != ActionKind.SettleRound) revert MalformedAction();
    }

    function _decodeTransitionAction(bytes calldata output, ActionKind expectedAction)
        private
        pure
        returns (uint256 suppliedEvaluatorId, bytes32 settledRoundId)
    {
        if (output.length != 96) revert MalformedAction();
        ActionKind action;
        (action, suppliedEvaluatorId, settledRoundId) = abi.decode(output, (ActionKind, uint256, bytes32));
        if (action != expectedAction) revert MalformedAction();
    }

    function _storeDerivedTask(
        RoundView storage round,
        bytes32 roundId,
        Stage stage,
        bytes memory input,
        bytes32 previousReplyHash,
        uint256 expiresAt
    ) private returns (bytes32 taskHash) {
        bytes32[] memory previousReplies = new bytes32[](1);
        previousReplies[0] = previousReplyHash;
        uint256 taskSeq = ++round.latestTaskSeq;
        AgentTask memory task = AgentTask({
            stage: uint8(stage),
            taskSeq: taskSeq,
            inputHash: keccak256(input),
            input: input,
            timestamp: block.timestamp,
            expiresAt: expiresAt,
            prevReplyHashes: previousReplies,
            workflowRunId: roundId
        });
        taskHash = _storeTask(task, true);
    }

    function _openNextRound(bytes32 previousRoundId, bytes32 transitionReplyHash)
        private
        returns (bytes32 nextRoundId)
    {
        uint256 sequence = ++_runSequence;
        nextRoundId = keccak256(abi.encode(address(this), block.chainid, sequence, previousRoundId));
        _runs[nextRoundId] =
            RunRecord({exists: true, status: RunStatus.Pending, finalTaskHash: bytes32(0), completedAt: 0});

        bytes memory input = abi.encode(previousRoundId, transitionReplyHash);
        bytes32[] memory previousReplies = new bytes32[](0);
        AgentTask memory collectTask = AgentTask({
            stage: uint8(Stage.Collect),
            taskSeq: 0,
            inputHash: keccak256(input),
            input: input,
            timestamp: block.timestamp,
            expiresAt: type(uint256).max,
            prevReplyHashes: previousReplies,
            workflowRunId: nextRoundId
        });
        bytes32 collectTaskHash = _storeTask(collectTask, true);
        _collectTaskHashes[nextRoundId] = collectTaskHash;
        _rounds[nextRoundId] = RoundView({
            exists: true,
            status: RoundStatus.Open,
            previousRoundId: previousRoundId,
            collectTaskHash: collectTaskHash,
            latestSettleTaskHash: bytes32(0),
            transitionTaskHash: bytes32(0),
            scoreRoot: bytes32(0),
            contributionCount: 0,
            scoredCount: 0,
            totalScore: 0,
            settledAt: 0,
            settlementReplyHash: bytes32(0),
            latestTaskSeq: 0,
            transitioned: false,
            transitionReplyHash: bytes32(0),
            nextRoundId: bytes32(0)
        });
        currentRoundId = nextRoundId;
    }

    function _anchorProofFreeReply(
        AgentReply calldata reply,
        bytes32 taskHash,
        AgentTask storage previousTask,
        uint256 contributorAgentId
    ) private returns (bytes32 replyHash) {
        replyHash = _hashReply(reply);
        if (_replyExists[replyHash]) revert DuplicateReply(replyHash);

        _replies[replyHash] = reply;
        _replyExists[replyHash] = true;
        _replyVerifier[replyHash] = passThroughVerifier;
        emit AgentReplyAnchored(reply.workflowRunId, replyHash, reply.replier);

        _verifierCallActive = true;
        (bool valid, bytes32 verificationDigest) = IAgentVerifier(passThroughVerifier).verify(
            taskHash, bytes32(contributorAgentId), previousTask.inputHash, reply.outputHash, ""
        );
        _verifierCallActive = false;

        if (!valid) revert VerifierRejected();
        if (verificationDigest == bytes32(0)) revert InvalidVerificationDigest();
        _replyVerificationDigest[replyHash] = verificationDigest;
        _replyProven[replyHash] = true;
    }

    function onAgentProve(bytes32[] calldata replyHashes, bytes calldata proof)
        external
        override
        notDuringVerifierCall
    {
        if (replyHashes.length == 0) revert InvalidProofBatch();
        for (uint256 i; i < replyHashes.length; ++i) {
            bytes32 replyHash = replyHashes[i];
            if (!_replyExists[replyHash]) revert UnknownReply(replyHash);
            if (_replyProven[replyHash]) revert ReplyAlreadyProven(replyHash);
        }
        _ignoreProof(proof);
        revert ProofSubmissionUnsupported();
    }

    function _storeTask(AgentTask memory task, bool proven) internal returns (bytes32 taskHash) {
        taskHash = _hashTask(task);
        if (_taskExists[taskHash]) revert DuplicateTask(taskHash);
        _tasks[taskHash] = task;
        _taskExists[taskHash] = true;
        _taskProven[taskHash] = proven;
        emit NewAgentTask(task.workflowRunId, task.stage, taskHash);
    }

    function _hashTask(AgentTask memory task) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                task.stage,
                task.taskSeq,
                task.inputHash,
                task.timestamp,
                task.expiresAt,
                keccak256(abi.encodePacked(task.prevReplyHashes)),
                task.workflowRunId
            )
        );
    }

    function _hashReply(AgentReply calldata reply) internal pure returns (bytes32) {
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

    function _ignoreProof(bytes calldata) private pure {}
}
