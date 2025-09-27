// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IFlashLoanRecipient {
    function receiveFlashLoan(
        address[] calldata tokens,
        uint256[] calldata amounts,
        uint256[] calldata feeAmounts,
        bytes calldata userData
    ) external;
}

contract MockBalancerVault {
    error NotRepaid();

    uint256 public flashFee;
    address[] private overrideTokens;
    uint256[] private overrideAmounts;

    function setFlashFee(uint256 newFee) external {
        flashFee = newFee;
    }

    function setOverrideResponse(address[] calldata tokens, uint256[] calldata amounts) external {
        require(tokens.length == amounts.length, "MockBalancerVault: bad override lengths");
        overrideTokens = tokens;
        overrideAmounts = amounts;
    }

    function flashLoan(
        address recipient,
        address[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external {
        require(tokens.length == 1 && amounts.length == 1, "MockBalancerVault: only single token supported");

        address[] memory callbackTokens = overrideTokens.length == 0 ? tokens : overrideTokens;
        uint256[] memory callbackAmounts = overrideAmounts.length == 0 ? amounts : overrideAmounts;

        delete overrideTokens;
        delete overrideAmounts;

        IERC20 loanToken = IERC20(callbackTokens[0]);
        uint256 loanAmount = callbackAmounts[0];
        uint256 balanceBefore = loanToken.balanceOf(address(this));
        loanToken.transfer(recipient, loanAmount);

        uint256[] memory feeAmounts = new uint256[](callbackTokens.length);
        for (uint256 i = 0; i < callbackTokens.length; i++) {
            feeAmounts[i] = flashFee;
        }

        IFlashLoanRecipient(recipient).receiveFlashLoan(callbackTokens, callbackAmounts, feeAmounts, userData);

        uint256 expectedBalance = balanceBefore + flashFee;
        if (loanToken.balanceOf(address(this)) < expectedBalance) {
            revert NotRepaid();
        }
    }
}
