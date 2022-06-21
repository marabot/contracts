// contracts/imports/SchnoodleTimelock.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/utils/TokenTimelock.sol";
import "@schnoodle/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@schnoodle/contracts-upgradeable/token/ERC20/utils/TokenTimelockUpgradeable.sol";

contract SchnoodleTimelock is TokenTimelockUpgradeable {
    function initialize(IERC20Upgradeable token, address beneficiary, uint256 releaseTime) public initializer {
        __TokenTimelock_init(token, beneficiary, releaseTime);
    }
}
