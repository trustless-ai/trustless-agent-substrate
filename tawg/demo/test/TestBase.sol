// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface Vm {
    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata reason) external;
    function expectEmit(bool checkTopic1, bool checkTopic2, bool checkTopic3, bool checkData, address emitter)
        external;
    function warp(uint256 timestamp) external;
}

abstract contract TestBase {
    Vm internal constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    error AssertionFailed();

    function assertTrue(bool condition) internal pure {
        if (!condition) revert AssertionFailed();
    }

    function assertFalse(bool condition) internal pure {
        if (condition) revert AssertionFailed();
    }

    function assertEq(uint256 left, uint256 right) internal pure {
        if (left != right) revert AssertionFailed();
    }

    function assertEq(address left, address right) internal pure {
        if (left != right) revert AssertionFailed();
    }

    function assertEq(bytes32 left, bytes32 right) internal pure {
        if (left != right) revert AssertionFailed();
    }
}
