// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
}

contract MockPipelineTarget {
    function send(address token, address to, uint256 amount) external {
        require(IERC20(token).transfer(to, amount), "MockPipelineTarget: transfer failed");
    }

    function fail() external pure {
        revert("MockPipelineTarget: failure");
    }
}
