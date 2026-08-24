// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {IAgentVerifier} from "@agent-ercs/verify/ERC8274/IAgentVerifier.sol";

/// @notice ERC-8274-shaped bookkeeping for replies whose acceptance is fully
///         decided by Workflow rules and intentionally requires no external proof.
/// @dev The proof bytes are deliberately not inspected. A successful result is
///      not evidence of evaluation quality or a cryptographic proof.
contract PassThroughVerifier is IAgentVerifier {
    function verify(bytes32 taskId, bytes32 agentId, bytes32 inputHash, bytes32 outputHash, bytes calldata proof)
        external
        returns (bool valid, bytes32 verificationDigest)
    {
        _ignoreProof(proof);
        valid = true;
        verificationDigest = keccak256(abi.encode(taskId, agentId, inputHash, outputHash, valid, address(this)));
        emit VerificationCompleted(taskId, agentId, inputHash, outputHash, valid, verificationDigest);
    }

    function _ignoreProof(bytes calldata) private pure {}
}
