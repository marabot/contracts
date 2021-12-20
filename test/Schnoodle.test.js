// test/Schnoodle.test.js

const { accounts, contract, web3 } = require('@openzeppelin/test-environment');
const [ serviceAccount, eleemosynaryAccount ] = accounts;
const { BN, singletons, time } = require('@openzeppelin/test-helpers');

const { testContracts } = require(`../migrations-config.develop.js`);

const { assert } = require('chai');
require('chai').should();
const Chance = require('chance');
const bigInt = require('big-integer');
const truffleAssert = require('truffle-assertions');

const chance = new Chance();
let schnoodle;
let schnoodleFarming;
let initialTokens;

const data = web3.utils.sha3(chance.string());

beforeEach(async function () {
  initialTokens = chance.integer({ min: 1000 });

  await singletons.ERC1820Registry(serviceAccount);
  const Schnoodle = contract.fromArtifact(testContracts.schnoodle);
  const SchnoodleFarming = contract.fromArtifact(testContracts.schnoodleFarming);

  schnoodle = await Schnoodle.new();
  await schnoodle.methods['initialize(uint256,address)'](initialTokens, serviceAccount, { from: serviceAccount });

  schnoodleFarming = await SchnoodleFarming.new();
  await schnoodleFarming.initialize(schnoodle.address);
  await schnoodle.configure(true, serviceAccount, schnoodleFarming.address, { from: serviceAccount });
  await schnoodleFarming.configure();
});

describe('Balance', () => {
  it('should show an initial balance of the initial supply for the service account', async () => {
    assert.equal(await schnoodle.balanceOf(serviceAccount), initialTokens * 10 ** await schnoodle.decimals(), `Account ${serviceAccount} doesn't have a balance equal to the initial supply`);
  });

  it('should show an initial balance of zero for all non-service accounts', async () => {
    for (const account of accounts) {
      if (account != serviceAccount) {
        (await schnoodle.balanceOf(account)).should.be.bignumber.equal(new BN(0), `Account ${account} doesn't have a zero balance`);
      }
    }
  });
});

describe('Burning', () => {
  it('should burn tokens decreasing the account\'s balance and total supply by the same amounts', async () => {
    await _testBurning(BigInt(bigInt.randBetween(1, BigInt(await schnoodle.balanceOf(serviceAccount)))));
  });

  it('should burn all tokens reducing account\'s balance and total supply to zero', async () => {
    await _testBurning(BigInt(await schnoodle.balanceOf(serviceAccount)));
    assert.equal(await schnoodle.balanceOf(serviceAccount), 0, 'Total supply wasn\'t reduced to zero by burning');
  });

  it('should revert on attempt to burn more tokens than are available', async () => {
    // Pre-burn a token to prevent an overflow error on the reflected amount during the test burn
    await schnoodle.burn(1, data, { from: serviceAccount });
    await truffleAssert.reverts(_testBurning(BigInt(await schnoodle.balanceOf(serviceAccount)) + 1n), 'ERC777: burn amount exceeds balance');
  });

  async function _testBurning(amount) {
    const totalSupply = BigInt(await schnoodle.totalSupply());
    const balance = BigInt(await schnoodle.balanceOf(serviceAccount));
    
    await schnoodle.burn(amount, data, { from: serviceAccount });

    const newTotalSupply = BigInt(await schnoodle.totalSupply());
    assert.equal(newTotalSupply, totalSupply - amount, 'Total supply wasn\'t affected correctly by burning');

    const newBalance = BigInt(await schnoodle.balanceOf(serviceAccount));
    assert.equal(newBalance, balance - amount, 'Service account wasn\'t affected correctly by burning');
  }
});

describe('Transfer', () => {
  let amounts;
  let senderCandidates;
  let sender;
  let recipient;
  let feeRate;
  let donationRate;
  let sowRate;

  beforeEach(async function () {
    feeRate = chance.integer({ min: 10, max: 200 });
    donationRate = chance.integer({ min: 10, max: 200 });
    sowRate = chance.integer({ min: 10, max: 200 });

    await schnoodle.changeFeeRate(feeRate, { from: serviceAccount });
    await schnoodle.changeEleemosynaryDetails(eleemosynaryAccount, donationRate, { from: serviceAccount });
    await schnoodle.changeSowRate(sowRate, { from: serviceAccount });
    await _populateAccounts();

    amounts = {};
    for (const account of accounts) {
      amounts[account] = BigInt(await schnoodle.balanceOf(account));
    }

    // Randomly pick different sender and recipient accounts for performing the transfer test
    senderCandidates = accounts.filter(a => a != eleemosynaryAccount);
    sender = chance.pickone(senderCandidates);
    recipient = chance.pickone(senderCandidates.filter(a => a != sender));

    // Class the test transfer as a sell to test the fee distribution algorithm
    await schnoodle.grantRole(await schnoodle.LIQUIDITY(), recipient, { from: serviceAccount });
  });

  it('should transfer some ERC-20 tokens to the recipient and distribute a fee to all accounts', async() => {
    await _testTransfer(amount => BigInt(bigInt.randBetween(1, amount)), (schnoodle, sender, recipient, amount) => _transfer(schnoodle, sender, recipient, amount));
  });

  it('should transfer all ERC-20 tokens to the recipient and distribute a fee to all accounts', async() => {
    await _testTransfer(amount => amount, (schnoodle, sender, recipient, amount) => _transfer(schnoodle, sender, recipient, amount));
  });

  it('should transfer some ERC-20 tokens from the sender to the recipient and distribute a fee to all accounts', async() => {
    await _testTransfer(amount => BigInt(bigInt.randBetween(1, amount)), (schnoodle, sender, recipient, amount) => _transferFrom(schnoodle, sender, recipient, amount));
  });

  it('should transfer all ERC-20 tokens from the sender to the recipient and distribute a fee to all accounts', async() => {
    await _testTransfer(amount => amount, (schnoodle, sender, recipient, amount) => _transferFrom(schnoodle, sender, recipient, amount));
  });

  it('should transfer some ERC-777 tokens to the recipient and distribute a fee to all accounts', async() => {
    await _testTransfer(amount => BigInt(bigInt.randBetween(1, amount)), (schnoodle, sender, recipient, amount) => _send(schnoodle, sender, recipient, amount));
  });

  it('should transfer all ERC-777 tokens to the recipient and distribute a fee to all accounts', async() => {
    await _testTransfer(amount => amount, (schnoodle, sender, recipient, amount) => _send(schnoodle, sender, recipient, amount));
  });

  async function _transfer(schnoodle, sender, recipient, amount) {
    await schnoodle.transfer(recipient, amount, {from: sender});
  }

  async function _transferFrom(schnoodle, sender, recipient, amount) {
    await schnoodle.approve(sender, amount, {from: sender});
    assert.equal(amount, BigInt(await schnoodle.allowance(sender, sender)));
    await schnoodle.transferFrom(sender, recipient, amount, {from: sender});
  }

  async function _send(schnoodle, sender, recipient, amount) {
    await schnoodle.send(recipient, amount, 0, {from: sender});
  }

  async function _testTransfer(amountCallback, transferCallback) {
    // Invoke the callback function to get the desired amount to transfer for this test
    const transferAmount = amountCallback(BigInt(await schnoodle.balanceOf(sender)));

    await transferCallback(schnoodle, sender, recipient, transferAmount);

    let totalBalance = 0n;

    // Check the balances of all accounts to ensure they match the expected algorithm
    for (const account of accounts) {
      const oldAmount = amounts[account];

      // Determine the rate change from the old amount depending on whether the account is the sender (down), recipient (up), eleemosynary account (up) or other (zero)
      const deltaRate = account == sender
        ? -1000
        : (account == recipient
          ? 1000 - feeRate - donationRate - sowRate
          : (account == eleemosynaryAccount
            ? donationRate
            : 0));

      // The old amount is adjusted by a fraction of the transfer amount depending on the account role in the transfer (sender, recipient, eleemosynary account or other)
      const baseBalance = oldAmount + transferAmount * BigInt(deltaRate) / 1000n;

      // The expected balance should include a distribution of the fees, and therefore be higher than the base balance
      const newBalance = BigInt(await schnoodle.balanceOf(account));

      totalBalance += newBalance;

      const accountRole = account == sender ? 'sender' : (account == recipient ? 'recipient' : (account == eleemosynaryAccount ? 'eleemosynary' : ''));
      const accountIdentity = `${account}${accountRole == '' ? '' : (` (${accountRole})`)}`;
      assert.isTrue(newBalance >= baseBalance, `Account ${accountIdentity} balance incorrect after transfer`);
    }

    assert.isTrue(totalBalance - BigInt(await schnoodle.totalSupply()) < 1, 'Total of all balances doesn\'t match total supply');
  }
});

describe('Yield Farming', () => {
  let farmer;
  let depositAmount;
  let vestingBlocks;
  let unbondingBlocks;
  let farmingFund;
  let farmerStartBalance;
  let farmingFundStartBalance;

  beforeEach(async function () {
    await schnoodle.changeSowRate(chance.integer({ min: 10, max: 200 }), { from: serviceAccount });

    await _populateAccounts();
    farmingFund = await schnoodle.getFarmingFund();
    await schnoodle.transfer(farmingFund, BigInt(bigInt.randBetween(1, BigInt(await schnoodle.balanceOf(serviceAccount)))), { from: serviceAccount });
    farmer = chance.pickone(accounts);
    depositAmount = BigInt(bigInt.randBetween(1, BigInt(await schnoodle.balanceOf(farmer))));
    vestingBlocks = chance.integer({ min: 1, max: 20 });
    unbondingBlocks = chance.integer({ min: 1, max: 20 });
    farmerStartBalance = BigInt(await schnoodle.balanceOf(farmer));
    farmingFundStartBalance = BigInt(await schnoodle.balanceOf(farmingFund));
  });

  it('should increase the yield farmer\'s balance by a nonzero reward when a deposit with finite vesting blocks and unbonding blocks is withdrawn', async() => {
    [netReward, grossReward] = await addDepositAndWithdraw(vestingBlocks, unbondingBlocks);

    assert.isTrue(netReward > 0n && grossReward > 0n, 'Farming reward value is not positive');
    assert.equal(BigInt(await schnoodle.balanceOf(farmer)), farmerStartBalance + netReward, 'Yield farmer balance wasn\'t increased by the net reward amount');
    assert.equal(BigInt(await schnoodle.balanceOf(farmingFund)), farmingFundStartBalance - grossReward, 'Farming fund wasn\'t reduced by the gross reward amount');
  });

  it('should increase the reward when the lock on a deposit is increased', async() => {
    await schnoodleFarming.addDeposit(depositAmount, vestingBlocks, unbondingBlocks, { from: farmer });
    const rewardBlock = await web3.eth.getBlockNumber() + vestingBlocks;
    const initialReward = BigInt(await schnoodleFarming.getReward(farmer, 0, rewardBlock));
    await schnoodleFarming.updateDeposit(0, vestingBlocks + 1, unbondingBlocks + 1, { from: farmer });
    const updatedReward = BigInt(await schnoodleFarming.getReward(farmer, 0, rewardBlock));
    assert.isTrue(updatedReward > initialReward, 'Increasing lock on deposit did not increase the reward');
  });

  it('should revert when the lock on a deposit is updated with no increase', async() => {
    await schnoodleFarming.addDeposit(depositAmount, vestingBlocks, unbondingBlocks, { from: farmer });
    await truffleAssert.reverts(schnoodleFarming.updateDeposit(0, vestingBlocks, unbondingBlocks, { from: farmer }), 'SchnoodleFarming: no benefit to update deposit with supplied changes');
  });

  it('should revert on attempt to deposit with zero deposit amount', async() => {
    await truffleAssert.reverts(schnoodleFarming.addDeposit(0, vestingBlocks, unbondingBlocks, { from: farmer }), 'SchnoodleFarming: deposit amount must be greater than zero');
  });

  it('should revert on attempt to deposit with zero vesting blocks', async() => {
    await truffleAssert.reverts(schnoodleFarming.addDeposit(depositAmount, 0, unbondingBlocks, { from: farmer }), 'SchnoodleFarming: vesting blocks must be greater than zero');
  });

  it('should revert on attempt to deposit with zero unbonding blocks', async() => {
    await truffleAssert.reverts(schnoodleFarming.addDeposit(depositAmount, vestingBlocks, 0, { from: farmer }), 'SchnoodleFarming: unbonding blocks must be greater than zero');
  });

  it('should revert on attempt to withdraw during vesting blocks', async() => {
    await schnoodleFarming.addDeposit(depositAmount, vestingBlocks, unbondingBlocks, { from: farmer });
    await truffleAssert.reverts(schnoodleFarming.withdraw(0, depositAmount, { from: farmer }), 'SchnoodleFarming: cannot withdraw during vesting blocks');
  });

  it('should revert on attempt to deposit more tokens than are unlocked', async() => {
    await schnoodleFarming.addDeposit(depositAmount, vestingBlocks, unbondingBlocks, { from: farmer });
    const additionalDeposit = BigInt(bigInt.randBetween(farmerStartBalance - depositAmount + 1n, farmerStartBalance));
    await truffleAssert.reverts(schnoodleFarming.addDeposit(additionalDeposit, vestingBlocks, unbondingBlocks, { from: farmer }), 'SchnoodleFarming: deposit amount exceeds unlocked balance');
  });

  it('should revert on attempt to transfer more tokens than are unlocked', async() => {
    await schnoodleFarming.addDeposit(depositAmount, vestingBlocks, unbondingBlocks, { from: farmer });
    const transferAmount = BigInt(bigInt.randBetween(farmerStartBalance - depositAmount + 1n, farmerStartBalance));
    await truffleAssert.reverts(schnoodle.transfer(serviceAccount, transferAmount, { from: farmer }), 'Schnoodle: transfer amount exceeds unlocked balance');
  });

  it('should revert on attempt to transfer more tokens than are available including locked', async() => {
    await schnoodleFarming.addDeposit(depositAmount, vestingBlocks, unbondingBlocks, { from: farmer });
    await truffleAssert.reverts(schnoodle.transfer(serviceAccount, BigInt(farmerStartBalance + 1n), { from: farmer }), 'ERC777: transfer amount exceeds balance');
  });

  async function addDepositAndWithdraw(vestingBlocks, unbondingBlocks) {
    await schnoodleFarming.addDeposit(depositAmount, vestingBlocks, unbondingBlocks, { from: farmer });

    Array.from({length: vestingBlocks}, async () => await time.advanceBlock());

    const receipt = await schnoodleFarming.withdraw(0, depositAmount, { from: farmer });

    let withdrawnEvent = receipt.logs.find(l => l.event == 'Withdrawn');
    return [BigInt(withdrawnEvent.args.netReward), BigInt(withdrawnEvent.args.grossReward)];
  }
});

async function _populateAccounts() {
  // Populate all accounts with some tokens from the service account
  for (const account of accounts) {
    await schnoodle.transfer(account, BigInt(bigInt.randBetween(1, BigInt(await schnoodle.balanceOf(serviceAccount)) / BigInt(accounts.length))), { from: serviceAccount });
  };
}
