// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/**
 * @title FlashFloopExecutor
 * @notice Generic Balancer V2 flash-loan recipient that executes an ordered list of target calls,
 *         enforces profit threshold, repays, and sweeps leftover to the caller-specified recipient.
 *         Designed for Pendle flooping (mint PY, sell PT, optionally sell YT), but generic enough
 *         to execute any calls.
 */
interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address src, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
}

interface IBalancerVault {
    function flashLoan(
        address recipient,
        address[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
}

contract FlashFloopExecutor {
    error NotOwner();
    error BadLengths();
    error InsufficientProfit(uint256 have, uint256 need);
    error ExternalCallFailed(uint256 index, bytes reason);

    address public immutable vault;
    address public owner;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address _vault) {
        vault = _vault;
        owner = msg.sender;
    }

    function setOwner(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    receive() external payable {}

    struct Plan {
        address[] targets;
        bytes[] calldatas;
        address loanToken;
        uint256 loanAmount;
        uint256 minProfit;      // in loanToken units
        address profitRecipient;// where leftovers are sent
    }

    function execute(Plan calldata p) external onlyOwner {
        if (p.targets.length != p.calldatas.length) revert BadLengths();
        address[] memory tokens = new address[](1);
        tokens[0] = p.loanToken;
        uint256[] memory amts = new uint256[](1);
        amts[0] = p.loanAmount;
        IBalancerVault(vault).flashLoan(
            address(this),
            tokens,
            amts,
            abi.encode(p.targets, p.calldatas, p.loanToken, p.loanAmount, p.minProfit, p.profitRecipient)
        );
    }

    // Balancer V2 callback (IERC20[] in Balancer interface, but ABI is addresses)
    function receiveFlashLoan(
        address[] calldata tokens,
        uint256[] calldata amounts,
        uint256[] calldata feeAmounts,
        bytes calldata userData
    ) external {
        require(msg.sender == vault, "only vault");
        (address[] memory targets, bytes[] memory datas, address loanToken, uint256 loanAmount, uint256 minProfit, address to)
            = abi.decode(userData, (address[], bytes[], address, uint256, uint256, address));

        // Run pipeline
        for (uint256 i = 0; i < targets.length; i++) {
            (bool ok, bytes memory ret) = targets[i].call(datas[i]);
            if (!ok) revert ExternalCallFailed(i, ret);
        }

        uint256 fee = feeAmounts.length > 0 ? feeAmounts[0] : 0;
        uint256 bal = IERC20(loanToken).balanceOf(address(this));
        // Need to keep enough to repay principal+fee; leftover must be >= minProfit.
        if (bal < loanAmount + fee + minProfit) {
            revert InsufficientProfit(bal, loanAmount + fee + minProfit);
        }

        // Repay
        IERC20(loanToken).transfer(vault, loanAmount + fee);

        // Sweep leftovers (loan token)
        uint256 leftover = IERC20(loanToken).balanceOf(address(this));
        if (leftover > 0 && to != address(0)) {
            IERC20(loanToken).transfer(to, leftover);
        }

        // Note: any other tokens (e.g., YT) should be swept by a separate call
        //       or included as last targets in the pipeline to transfer to `to`.
    }
}
