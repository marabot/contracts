// ReSharper disable InconsistentNaming
import React, { Component } from 'react';
import { general, farming as resources } from '../resources';
import SchnoodleV1 from '../contracts/SchnoodleV1.json';
import Schnoodle from '../contracts/SchnoodleV9.json';
import SchnoodleFarmingV1 from '../contracts/SchnoodleFarmingV1.json';
import SchnoodleFarming from '../contracts/SchnoodleFarmingV2.json';
import { initializeHelpers, handleError, getWeb3, scaleDownUnits, scaleUpUnits, calculateApy, blocksPerDuration, blocksDurationText, getPendingBlocks } from '../helpers';

// Third-party libraries
import { debounce, range } from 'lodash';
import { Modal } from 'react-responsive-modal';
import 'react-responsive-modal/styles.css';
import Plot from 'react-plotly.js';
import { Puff } from 'react-loader-spinner';
const bigInt = require('big-integer');
// ReSharper restore InconsistentNaming

export default class Farming extends Component {
  static displayName = Farming.name;
  static vestiplotsCancellationToken;
  
  constructor(props) {
    super(props);

    this.state = {
      success: false,
      farmingFundBalance: 0,
      blockNumber: 0,
      operativeFeeRate: 0,
      donationRate: 0,
      sowRate: 0,
      sellQuota: { 'blockMetric': 0, 'amount': 0 },
      balance: 0,
      depositAmount: 0,
      vestingBlocksFactor: 0,
      factoredVestingBlocks: 0,
      factoredVestingBlocksMax: 0,
      unbondingBlocksFactor: 0,
      factoredUnbondingBlocks: 0,
      factoredUnbondingBlocksMax: 0,
      vestimatedReward: 0,
      vestimatedApy: 0,
      vestiplotReward: [],
      vestiplotApy: [],
      vestiplotProgress: 0,
      optimumVestingBlocks: 0,
      optimumUnbondingBlocks: 0,
      lockedBalance: 0,
      unbondingBalance: 0,
      availableAmount: 0,
      farmingSummary: [],
      unbondingSummary: [],
      withdrawAmounts: [],
      openHelpModal: false,
      helpTitle: '',
      helpInfo: '',
      helpDetails: ''
    };

    this.handleError = handleError.bind(this);
    this.addDeposit = this.addDeposit.bind(this);
    this.updateDepositAmount = this.updateDepositAmount.bind(this);
    this.maxDepositAmount = this.maxDepositAmount.bind(this);
    this.updateVestingBlocks = this.updateVestingBlocks.bind(this);
    this.maxVestingBlocks = this.maxVestingBlocks.bind(this);
    this.updateUnbondingBlocks = this.updateUnbondingBlocks.bind(this);
    this.maxUnbondingBlocks = this.maxUnbondingBlocks.bind(this);
    this.maximiseApy = this.maximiseApy.bind(this);
    this.closeHelpModal = this.closeHelpModal.bind(this);

    this.updateVestimates = debounce(this.updateVestimates, 500);
    this.updateVestiplots = debounce(this.updateVestiplots, 2000);
  }

  async componentDidMount() {
    try {
      const web3 = await getWeb3();
      const schnoodleDeployedNetwork = SchnoodleV1.networks[await web3.eth.net.getId()];
      const schnoodle = new web3.eth.Contract(Schnoodle.abi, schnoodleDeployedNetwork && schnoodleDeployedNetwork.address);
      const schnoodleFarmingDeployedNetwork = SchnoodleFarmingV1.networks[await web3.eth.net.getId()];
      const schnoodleFarming = new web3.eth.Contract(SchnoodleFarming.abi, schnoodleFarmingDeployedNetwork && schnoodleFarmingDeployedNetwork.address);
      await initializeHelpers(await schnoodle.methods.decimals().call());

      window.ethereum.on('networkChanged', () => window.location.reload(true));

      this.setState({ web3, schnoodle, schnoodleFarming, selectedAddress: web3.currentProvider.selectedAddress }, async () => {
        await this.getInfo();
        const getInfoIntervalId = setInterval(async () => await this.getInfo(), 10000);
        this.setState({ getInfoIntervalId });
      });
    } catch (err) {
      this.handleError(err);
    }
  }

  componentWillUnmount() {
    clearInterval(this.state.getInfoIntervalId);
    this.updateVestimates.cancel();
    this.updateVestiplots.cancel();
  }

  async getInfo() {
    const { web3, schnoodle, schnoodleFarming, selectedAddress } = this.state;

    const blockNumber = await web3.eth.getBlockNumber();

    this.setState({ blockNumber }, async () => {
      const operativeFeeRate = await schnoodle.methods.getOperativeFeeRate().call();
      const { 1: donationRate } = await schnoodle.methods.getEleemosynaryDetails().call();
      const sowRate = await schnoodle.methods.getSowRate().call();
      const sellQuota = await schnoodle.methods.getSellQuota().call();
      const farmingFundBalance = bigInt(await schnoodle.methods.balanceOf(await schnoodle.methods.getFarmingFund().call()).call());

      const balance = bigInt(await schnoodle.methods.balanceOf(selectedAddress).call());
      const lockedBalance = bigInt(await schnoodleFarming.methods.lockedBalanceOf(selectedAddress).call());
      const unbondingBalance = bigInt(await schnoodleFarming.methods.unbondingBalanceOf(selectedAddress).call());
      const availableAmount = balance.subtract(lockedBalance);
      const vestingBlocksFactor = await schnoodleFarming.methods.getVestingBlocksFactor().call() / 1000;
      const unbondingBlocksFactor = await schnoodleFarming.methods.getUnbondingBlocksFactor().call() / 1000;
      const factoredVestingBlocksMax = Math.floor(blocksPerDuration({ years: 1 }) * vestingBlocksFactor);
      const factoredUnbondingBlocksMax = Math.floor(await schnoodleFarming.methods.getMaxUnbondingBlocks().call() * unbondingBlocksFactor);

      // Fetch the farming summary while also calculating the APY for each deposit
      const farmingSummary = await Promise.all([].concat(await schnoodleFarming.methods.getFarmingSummary(selectedAddress).call()).sort((a, b) => a.deposit.blockNumber > b.deposit.blockNumber ? 1 : -1).map(async (depositReward) => {
        const deposit = depositReward.deposit;
        const rewardBlock = Math.max(parseInt(deposit.blockNumber) + parseInt(deposit.vestingBlocks), blockNumber);
        const vestimatedApy = await calculateApy(deposit.amount, await schnoodleFarming.methods.getReward(selectedAddress, deposit.id, rewardBlock).call(), rewardBlock - deposit.blockNumber);
        const created = new Date((await web3.eth.getBlock(deposit.blockNumber)).timestamp * 1000);
        return { deposit: deposit, created: created, reward: bigInt(depositReward.reward), vestimatedApy: vestimatedApy };
      }));

      const unbondingSummary = [].concat(await schnoodleFarming.methods.getUnbondingSummary(selectedAddress).call()).sort((a, b) => a.expiryBlock > b.expiryBlock ? 1 : -1);

      const withdrawAmounts = [];
      for (let i = 0; i < farmingSummary.length; i++) {
        const withdrawAmount = this.state.withdrawAmounts[i];
        withdrawAmounts[i] = this.state.withdrawAmounts[i] === undefined ? scaleDownUnits(farmingSummary[i].deposit.amount) : withdrawAmount;
      }

      this.setState({
        farmingFundBalance,
        operativeFeeRate,
        donationRate,
        sowRate,
        sellQuota,
        balance,
        vestingBlocksFactor,
        factoredVestingBlocksMax,
        unbondingBlocksFactor,
        factoredUnbondingBlocksMax,
        lockedBalance,
        unbondingBalance,
        availableAmount,
        farmingSummary,
        unbondingSummary,
        withdrawAmounts
      });
    });
  }

  //#region Handling

  async handleReceipt(receipt) {
    this.setState({ success: receipt.status, message: receipt.transactionHash });
    await this.getInfo();
  }

  //#endregion

  //#region Deposit functions

  async addDeposit() {
    try {
      const { schnoodleFarming, selectedAddress, depositAmount, availableAmount } = this.state;

      const depositAmountValue = this.preventDust(depositAmount, availableAmount);
      const receipt = await schnoodleFarming.methods.addDeposit(depositAmountValue.toString(), this.vestingBlocks(), this.unbondingBlocks()).send({ from: selectedAddress });
      await this.handleReceipt(receipt);
    } catch (err) {
      await this.handleError(err);
    }
  }

  async withdraw(i) {
    try {
      const { schnoodleFarming, selectedAddress, withdrawAmounts, farmingSummary } = this.state;

      const depositInfo = farmingSummary[i];
      const amountToWithdraw = this.preventDust(withdrawAmounts[i], depositInfo.deposit.amount);
      const receipt = await schnoodleFarming.methods.withdraw(depositInfo.deposit.id, amountToWithdraw.toString()).send({ from: selectedAddress });
      await this.handleReceipt(receipt);
    } catch (err) {
      await this.handleError(err);
    }
  }

  preventDust(userAmount, maxAmount) {
    return userAmount === scaleDownUnits(maxAmount) ? maxAmount : scaleUpUnits(userAmount);
  }

  //#endregion

  //#region Withdraw amount functions

  updateWithdrawAmount(index, e) {
    const value = Number(e.target.value);
    if (!Number.isInteger(value)) return;
    const { withdrawAmounts } = this.state;
    withdrawAmounts[index] = Math.min(value, scaleDownUnits(this.state.farmingSummary[index].deposit.amount));
    this.setState({ withdrawAmounts });
  }

  async maxWithdraw(index) {
    const { withdrawAmounts } = this.state;
    withdrawAmounts[index] = scaleDownUnits(this.state.farmingSummary[index].deposit.amount);
    this.setState({ withdrawAmounts });
  }

  //#endregion

  //#region Deposit amount functions

  async updateDepositAmount(e) {
    const value = Number(e.target.value);
    if (!Number.isInteger(value)) return;
    this.setDepositAmount(value);
  }

  async maxDepositAmount() {
    this.setDepositAmount(scaleDownUnits(this.state.availableAmount));
  }

  async setDepositAmount(amount) {
    this.setState({ depositAmount: Math.min(Math.floor(amount), scaleDownUnits(this.state.availableAmount)) }, async () => {
      await this.updateVestimates();
      await this.updateVestiplots();
    });
  }

  //#endregion

  //#region Vesting blocks functions

  vestingBlocks() {
    const { factoredVestingBlocks, vestingBlocksFactor } = this.state;
    return factoredVestingBlocks / vestingBlocksFactor;
  }

  async updateVestingBlocks(e) {
    const value = Number(e.target.value);
    if (!Number.isInteger(value)) return;
    this.setState({ factoredVestingBlocks: Math.min(value, this.state.factoredVestingBlocksMax) }, async () => await this.updateVestimates());
  }

  async addVestingBlocks(blocks) {
    const { factoredVestingBlocks, factoredVestingBlocksMax } = this.state;
    this.setState({ factoredVestingBlocks: Math.min(factoredVestingBlocks + blocks, factoredVestingBlocksMax) }, async () => await this.updateVestimates());
  }

  async maxVestingBlocks() {
    this.setState({ factoredVestingBlocks: this.state.factoredVestingBlocksMax }, async () => await this.updateVestimates());
  }

  //#endregion

  //#region Unbonding blocks functions

  unbondingBlocks() {
    const { factoredUnbondingBlocks, unbondingBlocksFactor } = this.state;
    return factoredUnbondingBlocks / unbondingBlocksFactor;
  }

  async updateUnbondingBlocks(e) {
    const value = Number(e.target.value);
    if (!Number.isInteger(value)) return;
    this.setState({ factoredUnbondingBlocks: Math.min(value, this.state.factoredUnbondingBlocksMax) }, async () => await this.updateVestimates());
  }

  async addUnbondingBlocks(blocks) {
    const { factoredUnbondingBlocks, factoredUnbondingBlocksMax } = this.state;
    this.setState({ factoredUnbondingBlocks: Math.min(factoredUnbondingBlocks + blocks, factoredUnbondingBlocksMax) }, async () => await this.updateVestimates());
  }

  async maxUnbondingBlocks() {
    this.setState({ factoredUnbondingBlocks: this.state.factoredUnbondingBlocksMax }, async () => await this.updateVestimates());
  }

  //#endregion

  //#region Vestimates / Vestiplots

  async updateVestimates() {
    const [vestimatedReward, vestimatedApy] = await this.getVestimates(this.state.depositAmount, this.vestingBlocks(), this.unbondingBlocks());
    this.setState({ vestimatedReward, vestimatedApy });
  }

  async updateVestiplots() {
    const { depositAmount, factoredVestingBlocksMax, factoredUnbondingBlocksMax, vestingBlocksFactor, unbondingBlocksFactor } = this.state;

    const token = this.vestiplotsCancellationToken = Symbol();
    const vestingBlocksList = range(10, factoredVestingBlocksMax, Math.ceil(factoredVestingBlocksMax / 10));
    const unbondingBlocksList = range(10, factoredUnbondingBlocksMax, Math.ceil(factoredUnbondingBlocksMax / 10));
    const rewardX = [];
    const rewardY = [];
    const rewardZ = [];
    const apyX = [];
    const apyY = [];
    const apyZ = [];

    let optimumVestingBlocks = 0;
    let optimumUnbondingBlocks = 0;
    this.setState({ optimumVestingBlocks, optimumUnbondingBlocks });

    if (depositAmount > 0) {
      const steps = vestingBlocksList.length * unbondingBlocksList.length;
      let maxVestimatedApy = 0;
      let vestiplotProgress = 0;

      for (const vestingBlocksItem of vestingBlocksList) {
        for (const unbondingBlocksItem of unbondingBlocksList) {
          if (token !== this.vestiplotsCancellationToken) return;

          const [vestimatedReward, vestimatedApy] = await this.getVestimates(depositAmount, vestingBlocksItem / vestingBlocksFactor, unbondingBlocksItem / unbondingBlocksFactor);

          rewardX.push(vestingBlocksItem);
          rewardY.push(unbondingBlocksItem);
          rewardZ.push(vestimatedReward);
          apyX.push(vestingBlocksItem);
          apyY.push(unbondingBlocksItem);
          apyZ.push(vestimatedApy);

          if (vestimatedApy > maxVestimatedApy) {
            maxVestimatedApy = vestimatedApy;
            optimumVestingBlocks = vestingBlocksItem;
            optimumUnbondingBlocks = unbondingBlocksItem;
          }

          this.setState({ vestiplotProgress: Math.floor(100 * ++vestiplotProgress / steps) });
        }
      }
    }

    const vestiplotReward = [
      {
        type: 'mesh3d',
        opacity: 0.5,
        color: 'rgb(200,100,200)',
        x: rewardX,
        y: rewardY,
        z: rewardZ
      }
    ];

    const vestiplotApy = [
      {
        type: 'mesh3d',
        opacity: 0.5,
        color: 'rgb(033,255,100)',
        x: apyX,
        y: apyY,
        z: apyZ
      }
    ];

    this.setState({ vestiplotReward, vestiplotApy, optimumVestingBlocks, optimumUnbondingBlocks });
  }

  async maximiseApy() {
    this.setState({ factoredVestingBlocks: this.state.optimumVestingBlocks, factoredUnbondingBlocks: this.state.optimumUnbondingBlocks }, async () => await this.updateVestimates());
  }

  async getVestimates(amount, vestingBlocks, unbondingBlocks) {
    const { schnoodleFarming, blockNumber } = this.state;

    if (amount === 0 || vestingBlocks === 0 || unbondingBlocks === 0) {
      return [0, 0];
    }

    const vestimatedReward = scaleDownUnits(await schnoodleFarming.methods.getReward(scaleUpUnits(amount).toString(), vestingBlocks, unbondingBlocks, blockNumber + vestingBlocks).call());
    const vestimatedApy = await calculateApy(amount, vestimatedReward, vestingBlocks);

    return [vestimatedReward, vestimatedApy];
  }

  //#endregion

  //#region Help functions

  openHelpModal(content) {
    this.setState({ helpTitle: content.TITLE, helpInfo: content.INFO, helpDetails: content.DETAILS, openHelpModal: true });
  }

  closeHelpModal() {
    this.setState({ openHelpModal: false });
  }

  //#endregion

  //#region Rendering

  renderFarmingSummaryTable(farmingSummary) {
    const space = ' ';
    const blockNumberTitleParts = resources.FARMING_SUMMARY.BLOCK_NUMBER.TITLE.split(space);
    const depositAmountTitleParts = resources.FARMING_SUMMARY.DEPOSIT_AMOUNT.TITLE.split(space);
    const pendingBlocksTitleParts = resources.FARMING_SUMMARY.PENDING_BLOCKS.TITLE.split(space);
    const unbondingBlocksTitleParts = resources.FARMING_SUMMARY.UNBONDING_BLOCKS.TITLE.split(space);
    const vestimatedApyTitleParts = resources.FARMING_SUMMARY.VESTIMATED_APY.TITLE.split(space);
    const currentRewardTitleParts = resources.FARMING_SUMMARY.CURRENT_REWARD.TITLE.split(space);

    return (
      <div role="table" aria-label={resources.FARMING_SUMMARY.TITLE} className="tw-border-secondary tw-border-4 tw-rounded-2xl tw-text-accent-content">
        <div role="rowgroup" className="columnheader-group">
          <div role="row">
            <span role="columnheader" className="narrower">
              {blockNumberTitleParts[0]}<br />{blockNumberTitleParts[1]}
              <img src="../../assets/img/svg/circle-help-purple.svg" alt="Help button" onClick={() => this.openHelpModal(resources.FARMING_SUMMARY.BLOCK_NUMBER)} className="tw-h-4 tw-w-4 tw-inline-block tw-ml-2 tw-cursor-pointer minustop" />
            </span>
            <span role="columnheader" className="narrower">
              {resources.FARMING_SUMMARY.CREATED.TITLE}
              <img src="../../assets/img/svg/circle-help-purple.svg" alt="Help button" onClick={() => this.openHelpModal(resources.FARMING_SUMMARY.CREATED)} className="tw-h-4 tw-w-4 tw-inline-block tw-ml-2 tw-cursor-pointer minustop" />
            </span>
            <span role="columnheader">
              {depositAmountTitleParts[0]}<br />{depositAmountTitleParts[1]}
              <img src="../../assets/img/svg/circle-help-purple.svg" alt="Help button" onClick={() => this.openHelpModal(resources.FARMING_SUMMARY.DEPOSIT_AMOUNT)} className="tw-h-4 tw-w-4 tw-inline-block tw-ml-2 tw-cursor-pointer minustop" />
            </span>
            <span role="columnheader" className="narrower">
              {pendingBlocksTitleParts[0]}<br />{pendingBlocksTitleParts[1]}
              <img src="../../assets/img/svg/circle-help-purple.svg" alt="Help button" onClick={() => this.openHelpModal(resources.FARMING_SUMMARY.PENDING_BLOCKS)} className="tw-h-4 tw-w-4 tw-inline-block tw-ml-2 tw-cursor-pointer minustop" />
            </span>
            <span role="columnheader" className="narrower">
              {unbondingBlocksTitleParts[0]}<br />{unbondingBlocksTitleParts[1]}
              <img src="../../assets/img/svg/circle-help-purple.svg" alt="Help button" onClick={() => this.openHelpModal(resources.FARMING_SUMMARY.UNBONDING_BLOCKS)} className="tw-h-4 tw-w-4 tw-inline-block tw-ml-2 tw-cursor-pointer minustop" />
            </span>
            <span role="columnheader" className="narrower">
              {vestimatedApyTitleParts[0]}<br />{vestimatedApyTitleParts[1]}
              <img src="../../assets/img/svg/circle-help-purple.svg" alt="Help button" onClick={() => this.openHelpModal(resources.FARMING_SUMMARY.VESTIMATED_APY)} className="tw-h-4 tw-w-4 tw-inline-block tw-ml-2 tw-cursor-pointer minustop" />
            </span>
            <span role="columnheader" className="narrow">
              {resources.FARMING_SUMMARY.MULTIPLIER.TITLE}
              <img src="../../assets/img/svg/circle-help-purple.svg" alt="Help button" onClick={() => this.openHelpModal(resources.FARMING_SUMMARY.MULTIPLIER)} className="tw-h-4 tw-w-4 tw-inline-block tw-ml-2 tw-cursor-pointer minustop" />
            </span>
            <span role="columnheader">
              {currentRewardTitleParts[0]}<br />{currentRewardTitleParts[1]}
              <img src="../../assets/img/svg/circle-help-purple.svg" alt="Help button" onClick={() => this.openHelpModal(resources.FARMING_SUMMARY.CURRENT_REWARD)} className="tw-h-4 tw-w-4 tw-inline-block tw-ml-2 tw-cursor-pointer minustop" />
            </span>
            <span role="columnheader" className="wider">
              {resources.FARMING_SUMMARY.WITHDRAW.TITLE}
              <img src="../../assets/img/svg/circle-help-purple.svg" alt="Help button" onClick={() => this.openHelpModal(resources.FARMING_SUMMARY.WITHDRAW)} className="tw-h-4 tw-w-4 tw-inline-block tw-ml-2 tw-cursor-pointer minustop" />
            </span>
          </div>
        </div>
        <div role="rowgroup" className="tw-text-secondary">
          {farmingSummary.map((depositInfo, i) => {
            const amount = scaleDownUnits(depositInfo.deposit.amount);
            const pendingBlocks = getPendingBlocks(Math.floor(depositInfo.deposit.vestingBlocks * this.state.vestingBlocksFactor), depositInfo.deposit.blockNumber, this.state.blockNumber);
            const unbondingBlocks = Math.floor(depositInfo.deposit.unbondingBlocks * this.state.unbondingBlocksFactor);

            return (
              <div role="row" key={depositInfo.deposit.blockNumber}>
                <span role="cell" data-header={resources.FARMING_SUMMARY.BLOCK_NUMBER.TITLE + ":"} className="tw-border-l-0 narrower">{depositInfo.deposit.blockNumber}</span>
                <span role="cell" data-header={resources.FARMING_SUMMARY.CREATED.TITLE + ":"} className="narrower" title={depositInfo.created.toLocaleTimeString()}>{depositInfo.created.toLocaleDateString()}</span>
                <span role="cell" data-header={resources.FARMING_SUMMARY.DEPOSIT_AMOUNT.TITLE + ":"}>{amount.toLocaleString()}</span>
                <span role="cell" data-header={resources.FARMING_SUMMARY.PENDING_BLOCKS.TITLE + ":"} claclassNamess="narrower" title={blocksDurationText(pendingBlocks)}>{pendingBlocks}</span>
                <span role="cell" data-header={resources.FARMING_SUMMARY.UNBONDING_BLOCKS.TITLE + ":"} className="narrower" title={blocksDurationText(unbondingBlocks)}>{unbondingBlocks}</span>
                <span role="cell" data-header={resources.FARMING_SUMMARY.VESTIMATED_APY.TITLE + ":"} className="narrower" >{depositInfo.vestimatedApy}%</span>
                <span role="cell" data-header={resources.FARMING_SUMMARY.MULTIPLIER.TITLE + ":"} className="narrow" >{depositInfo.deposit.multiplier / 1000}</span>
                <span role="cell" data-header={resources.FARMING_SUMMARY.CURRENT_REWARD.TITLE + ":"}>{scaleDownUnits(depositInfo.reward).toLocaleString()}</span>
                <span role="cell" className="wider">
                  <form>
                    <fieldset disabled={pendingBlocks > 0}>
                      <div className="tw-relative">
                        <div className="tw-flex">
                          <input type="number" min="1" max={amount} value={this.state.withdrawAmounts[i] || ''} onChange={this.updateWithdrawAmount.bind(this, i)} className="withdrawinput" />
                          <button type="button" onClick={this.maxWithdraw.bind(this, i)} className="maxwithdraw">Max</button>
                          <button type="button" className="withdrawbtn" disabled={this.state.withdrawAmounts[i] < 1 || this.state.withdrawAmounts[i] > amount} onClick={this.withdraw.bind(this, i)}><span>Withdraw</span></button>
                        </div>
                      </div>
                    </fieldset>
                  </form>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  renderUnbondingSummaryTable(unbondingSummary) {
    return (
      <div role="table" aria-label={resources.UNBONDING_SUMMARY.TITLE} className="border-secondary border-4 rounded-2xl text-accent-content">
        <div role="rowgroup" className="columnheader-group">
          <div role="row">
            <span role="columnheader" className="">
              {resources.UNBONDING_SUMMARY.AMOUNT.TITLE}
              <img src="../../assets/img/svg/circle-help-purple.svg" alt="Help button" onClick={() => this.openHelpModal(resources.UNBONDING_SUMMARY.AMOUNT)} className="tw-h-4 tw-w-4 tw-inline-block tw-ml-2 tw-cursor-pointer minustop" />
            </span>
            <span role="columnheader" className="">
              {resources.UNBONDING_SUMMARY.PENDING_BLOCKS.TITLE}
              <img src="../../assets/img/svg/circle-help-purple.svg" alt="Help button" onClick={() => this.openHelpModal(resources.UNBONDING_SUMMARY.PENDING_BLOCKS)} className="tw-h-4 tw-w-4 tw-inline-block tw-ml-2 tw-cursor-pointer minustop" />
            </span>
            <span role="columnheader">
              {resources.UNBONDING_SUMMARY.TIME_REMAINING.TITLE}
              <img src="../../assets/img/svg/circle-help-purple.svg" alt="Help button" onClick={() => this.openHelpModal(resources.UNBONDING_SUMMARY.TIME_REMAINING)} className="tw-h-4 tw-w-4 tw-inline-block tw-ml-2 tw-cursor-pointer minustop" />
            </span>
          </div>
        </div>
        <div role="rowgroup" className="tw-text-secondary">
          {unbondingSummary.map((unbond) => {
            const amount = scaleDownUnits(unbond.amount);
            const pendingBlocks = parseInt(unbond.expiryBlock) - this.state.blockNumber;
            return pendingBlocks > 0 && (
              <div role="row" key={unbond.expiryBlock}>
                <span role="cell" data-header="Amount:">{amount.toLocaleString()}</span>
                <span role="cell" data-header="Pending Blocks:">{pendingBlocks}</span>
                <span role="cell" data-header="Time Remaining:">{blocksDurationText(pendingBlocks)}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  render() {
    const balance = scaleDownUnits(this.state.balance);
    const lockedBalance = scaleDownUnits(this.state.lockedBalance);
    const unbondingBalance = scaleDownUnits(this.state.unbondingBalance);
    const availableAmount = scaleDownUnits(this.state.availableAmount);

    const token = 'SNOOD';
    const subtitle1 = 'Advanced yield farming.';
    const subtitle2 = 'But on the moon.';

    if (!this.state.web3) {
      return (
        <div className="tw-overflow-hidden tw-antialiased tw-font-roboto tw-mx-4">
          <div className="h-noheader md:tw-flex">
            <div className="tw-flex tw-items-center tw-justify-center tw-w-full">
              <div className="tw-px-4">
                <img className="tw-object-cover tw-w-1/2 tw-my-10" src="../../assets/img/svg/logo-schnoodle.svg" alt="Schnoodle logo" />
                <div className="maintitles tw-uppercase">{resources.MOON_FARMING}</div>
                <div className="tw-w-16 tw-h-1 tw-my-3 tw-bg-secondary md:tw-my-6" />
                <p className="tw-text-4xl tw-font-light tw-leading-normal tw-text-accent md:tw-text-5xl loading">{general.LOADING}<span>.</span><span>.</span><span>.</span></p>
                <div className="tw-px-4 tw-mt-4 fakebutton">&nbsp;</div>
              </div>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="farming tw-w-100">
        <div className="tw-m-auto tw-px-4 tw-max-w-screen-2xl">
          <div className="h-noheader tw-overflow-hidden tw-bg-neutral-focus tw-mx-2 md:tw-m-auto tw-font-roboto">
            <div className="tw-text-center tw-px-1 md:tw-px-4">
              <div className="tw-text-base-200 tw-w-full">
                <h1 className="tw-mt-10 tw-mb-2 maintitles tw-leading-tight tw-text-center md:tw-text-left tw-uppercase">{resources.MOON_FARMING}</h1>
                <p className="tw-my-2 tw-text-2xl md:tw-text-3xl tw-leading-tight titlefont tw-w-2/3 md:tw-w-full tw-m-auto md:tw-mx-0 textfade tw-from-green-400 tw-to-purple-500">
                  <span className="tw-block md:tw-hidden tw-text-center">{subtitle1}<br />{subtitle2}</span>
                  <span className="tw-hidden md:tw-block tw-text-left">{subtitle1} {subtitle2}</span>
                </p>
                <div className="tw-stats stats topstats">
                  <div className="tw-stat">
                    <div className="tw-stat-title">
                      {resources.BLOCK_NUMBER.TITLE}
                      <img src="../../assets/img/svg/circle-help-purple.svg" alt="Help button" onClick={() => this.openHelpModal(resources.BLOCK_NUMBER)} className="tw-h-4 tw-w-4 tw-inline-block tw-ml-2 tw-cursor-pointer minustop" />
                    </div>
                    <div className="tw-stat-value greenfade">{this.state.blockNumber}</div>
                    <div className="tw-stat-desc">&nbsp;</div>
                  </div>
                  <div className="tw-stat">
                    <div className="tw-stat-title">
                      {resources.SELL_QUOTA.TITLE}
                      <img src="../../assets/img/svg/circle-help-purple.svg" alt="Help button" onClick={() => this.openHelpModal(resources.SELL_QUOTA)} className="tw-h-4 tw-w-4 tw-inline-block tw-ml-2 tw-cursor-pointer minustop" />
                    </div>
                    <div className="tw-stat-value greenfade">{scaleDownUnits(this.state.sellQuota.amount).toLocaleString()}</div>
                    <div className="tw-stat-desc">{token} since {new Date(this.state.sellQuota.blockMetric * 1000).toLocaleString()}</div>
                  </div>
                  <div className="tw-stat">
                    <div className="tw-stat-title">
                      {resources.FARMING_FUND_BALANCE.TITLE}
                      <img src="../../assets/img/svg/circle-help-purple.svg" alt="Help button" onClick={() => this.openHelpModal(resources.FARMING_FUND_BALANCE)} className="tw-h-4 tw-w-4 tw-inline-block tw-ml-2 tw-cursor-pointer minustop" />
                    </div>
                    <div className="tw-stat-value greenfade">{scaleDownUnits(this.state.farmingFundBalance).toLocaleString()}</div>
                    <div className="tw-stat-desc">{token}</div>
                  </div>
                </div>

                <div className="tw-stats stats topstats">
                  <div className="tw-stat">
                    <div className="tw-stat-title">
                      {resources.OPERATIVE_FEE_RATE.TITLE}
                      <img src="../../assets/img/svg/circle-help-purple.svg" alt="Help button" onClick={() => this.openHelpModal(resources.OPERATIVE_FEE_RATE)} className="tw-h-4 tw-w-4 tw-inline-block tw-ml-2 tw-cursor-pointer minustop" />
                    </div>
                    <div className="tw-stat-value greenfade">{this.state.operativeFeeRate / 10}</div>
                    <div className="tw-stat-desc">%</div>
                  </div>
                  <div className="tw-stat">
                    <div className="tw-stat-title">
                      {resources.ELEEMOSYNARY_DONATION_RATE.TITLE}
                      <img src="../../assets/img/svg/circle-help-purple.svg" alt="Help button" onClick={() => this.openHelpModal(resources.ELEEMOSYNARY_DONATION_RATE)} className="tw-h-4 tw-w-4 tw-inline-block tw-ml-2 tw-cursor-pointer minustop" />
                    </div>
                    <div className="tw-stat-value greenfade">{this.state.donationRate / 10}</div>
                    <div className="tw-stat-desc">%</div>
                  </div>
                  <div className="tw-stat">
                    <div className="tw-stat-title">
                      {resources.FARMING_FUND_SOW_RATE.TITLE}
                      <img src="../../assets/img/svg/circle-help-purple.svg" alt="Help button" onClick={() => this.openHelpModal(resources.FARMING_FUND_SOW_RATE)} className="tw-h-4 tw-w-4 tw-inline-block tw-ml-2 tw-cursor-pointer minustop" />
                    </div>
                    <div className="tw-stat-value greenfade">{this.state.sowRate / 10}</div>
                    <div className="tw-stat-desc">%</div>
                  </div>
                </div>

                <div className="tw-card tw-shadow-sm tw-border-purple-500 tw-border-4 tw-rounded-2xl tw-text-accent-content tw-mt-5 tw-mb-5 tw-container-lg">
                  <div className="tw-card-body tw-my-6 md:tw-my-10 tw-rounded-4xl">
                    <h2 className="tw-card-title headingfont tw-text-purple-500"><span className="purplefade">Your {token} Tokens</span></h2>
                    <div className="tw-shadow-sm bottomstats tw-stats stats">
                      <div className="tw-stat tw-border-t-0">
                        <div className="tw-stat-title">
                          {resources.TOTAL_BALANCE.TITLE}
                          <img src="../../assets/img/svg/circle-help-purple.svg" alt="Help button" onClick={() => this.openHelpModal(resources.TOTAL_BALANCE)} className="tw-h-4 tw-w-4 tw-inline-block tw-ml-2 tw-cursor-pointer minustop" />
                        </div>
                        <div className="tw-stat-value purplefade">{balance.toLocaleString()}</div>
                        <div className="tw-stat-desc">{token}</div>
                      </div>
                      <div className="tw-stat">
                        <div className="tw-stat-title">
                          {resources.LOCKED_BALANCE.TITLE}
                          <img src="../../assets/img/svg/circle-help-purple.svg" alt="Help button" onClick={() => this.openHelpModal(resources.LOCKED_BALANCE)} className="tw-h-4 tw-w-4 tw-inline-block tw-ml-2 tw-cursor-pointer minustop" />
                        </div>
                        <div className="tw-stat-value purplefade">{lockedBalance.toLocaleString()}</div>
                        <div className="tw-stat-desc">{token}{unbondingBalance > 0 && (<span className="opacity-60 text-xs"><br />{unbondingBalance.toLocaleString()} unbonding</span>)}</div>
                      </div>
                      <div className="tw-stat">
                        <div className="tw-stat-title">
                          {resources.AVAILABLE_AMOUNT.TITLE}
                          <img src="../../assets/img/svg/circle-help-purple.svg" alt="Help button" onClick={() => this.openHelpModal(resources.AVAILABLE_AMOUNT)} className="tw-h-4 tw-w-4 tw-inline-block tw-ml-2 tw-cursor-pointer minustop" />
                        </div>
                        <div className="tw-stat-value purplefade">{availableAmount.toLocaleString()}</div>
                        <div className="tw-stat-desc">{token}</div>
                      </div>
                    </div>

                    <div className="tw-divider tw-mt-10">
                      <h3 className="sectiontitle tw-text-2xl md:tw-text-3xl tw-leading-tight">{resources.ADD_DEPOSIT}</h3>
                    </div>

                    <div className="tw-card-actions tw-text-center tw-mx-auto tw-w-full">
                      <form className="tw-justify-center fullhalfwidth tw-mx-auto tw-mt-5">
                        <fieldset disabled={availableAmount === 0}>
                          <div className="tw-form-control">
                            <div>
                              <label className="tw-label">
                                <span className="tw-label-text">
                                  {resources.DEPOSIT_AMOUNT.TITLE}
                                  <img src="../../assets/img/svg/circle-help-purple.svg" alt="Help button" onClick={() => this.openHelpModal(resources.DEPOSIT_AMOUNT)} className="tw-h-4 tw-w-4 tw-inline-block tw-ml-2 tw-cursor-pointer minustop" />
                                </span>
                              </label>
                              <div className="tw-relative tw-flex">
                                <input type="number" min="1" max={availableAmount} placeholder={`Max: ${availableAmount}`} value={this.state.depositAmount || ''} onChange={this.updateDepositAmount} className="depositinput" />
                                <button type="button" className="dwmbutton hidesmmd" onClick={() => this.setDepositAmount(availableAmount / 4)}>25%</button>
                                <button type="button" className="dwmbutton hidesmmd" onClick={() => this.setDepositAmount(availableAmount / 2)}>50%</button>
                                <button type="button" className="dwmbutton hidesmmd" onClick={() => this.setDepositAmount(availableAmount * 3 / 4)}>75%</button>
                                <button type="button" className="dwmbutton hidelg" onClick={() => this.setDepositAmount(availableAmount / 4)}>&frac14;</button>
                                <button type="button" className="dwmbutton hidelg" onClick={() => this.setDepositAmount(availableAmount / 2)}>&frac12;</button>
                                <button type="button" className="dwmbutton hidelg" onClick={() => this.setDepositAmount(availableAmount * 3 / 4)}>&frac34;</button>
                                <button type="button" className="maxbuttons" onClick={this.maxDepositAmount}>Max</button>
                              </div>
                            </div>
                          </div>
                          <div className="tw-mb-3 tw-form-control nobutton">
                            <label className="tw-label">
                              <span className="tw-label-text">
                                {resources.VESTING_BLOCKS.TITLE}
                                <img src="../../assets/img/svg/circle-help-purple.svg" alt="Help button" onClick={() => this.openHelpModal(resources.VESTING_BLOCKS)} className="tw-h-4 tw-w-4 tw-inline-block tw-ml-2 tw-cursor-pointer minustop" />
                              </span>
                            </label>
                            <div className="tw-mb-3 tw-flex">
                              <input type="number" min="1" max={this.state.factoredVestingBlocksMax} placeholder={`Max: ${this.state.factoredVestingBlocksMax}`} value={this.state.factoredVestingBlocks || ''} onChange={this.updateVestingBlocks} className="depositinput w-full" />
                              <button type="button" className="dwmbutton hidesmmd" onClick={() => this.addVestingBlocks(blocksPerDuration({ days: 1 }))}>Day</button>
                              <button type="button" className="dwmbutton hidesmmd" onClick={() => this.addVestingBlocks(blocksPerDuration({ weeks: 1 }))}>Week</button>
                              <button type="button" className="dwmbutton hidesmmd" onClick={() => this.addVestingBlocks(blocksPerDuration({ months: 1 }))}>Month</button>
                              <button type="button" className="dwmbutton hidelg" onClick={() => this.addVestingBlocks(blocksPerDuration({ days: 1 }))} title="Day">D</button>
                              <button type="button" className="dwmbutton hidelg" onClick={() => this.addVestingBlocks(blocksPerDuration({ weeks: 1 }))} title="Week">W</button>
                              <button type="button" className="dwmbutton hidelg" onClick={() => this.addVestingBlocks(blocksPerDuration({ months: 1 }))} title="Month">M</button>
                              <button type="button" className="maxbuttons" onClick={this.maxVestingBlocks}>Max</button>
                            </div>
                            <p className="approxLabel">{blocksDurationText(this.state.factoredVestingBlocks)}</p>
                          </div>
                          <div className="tw-mb-3 tw-form-control nobutton">
                            <label className="tw-label">
                              <span className="tw-label-text">
                                {resources.UNBONDING_BLOCKS.TITLE}
                                <img src="../../assets/img/svg/circle-help-purple.svg" alt="Help button" onClick={() => this.openHelpModal(resources.UNBONDING_BLOCKS)} className="tw-h-4 tw-w-4 tw-inline-block tw-ml-2 tw-cursor-pointer tw-minustop" />
                              </span>
                            </label>
                            <div className="tw-mb-3 tw-flex">
                              <input type="number" min="1" max={this.state.factoredUnbondingBlocksMax} placeholder={`Max: ${this.state.factoredUnbondingBlocksMax}`} value={this.state.factoredUnbondingBlocks || ''} onChange={this.updateUnbondingBlocks} className="depositinput" />
                              <button type="button" className="dwmbutton hidesmmd" onClick={() => this.addUnbondingBlocks(blocksPerDuration({ minutes: 1 }))}>Minute</button>
                              <button type="button" className="dwmbutton hidesmmd" onClick={() => this.addUnbondingBlocks(blocksPerDuration({ hours: 1 }))}>Hour</button>
                              <button type="button" className="dwmbutton hidesmmd" onClick={() => this.addUnbondingBlocks(blocksPerDuration({ days: 1 }))}>Day</button>
                              <button type="button" className="dwmbutton hidelg" onClick={() => this.addUnbondingBlocks(blocksPerDuration({ minutes: 1 }))} title="Minute">M</button>
                              <button type="button" className="dwmbutton hidelg" onClick={() => this.addUnbondingBlocks(blocksPerDuration({ hours: 1 }))} title="Hour">H</button>
                              <button type="button" className="dwmbutton hidelg" onClick={() => this.addUnbondingBlocks(blocksPerDuration({ days: 1 }))} title="Day">D</button>
                              <button type="button" className="maxbuttons" onClick={this.maxUnbondingBlocks}>Max</button>
                            </div>
                            <p className="approxLabel">{blocksDurationText(this.state.factoredUnbondingBlocks)}</p>
                          </div>
                          <div className="tw-mb-3 tw-form-control">
                            <button type="button" className="keybtn maxbuttons maximise" disabled={this.state.optimumVestingBlocks === 0 || this.state.optimumVestingBlocks === 0} onClick={this.maximiseApy}>Maximise APY</button>
                          </div>
                          <div className="tw-shadow-sm bottomstats tw-stats stats">
                            <div className="tw-stat tw-border-t-1 md:tw-border-t-0 md:tw-border-base-200">
                              <div className="tw-stat-title">
                                {resources.VESTIMATED_REWARD.TITLE}
                                <img src="../../assets/img/svg/circle-help-purple.svg" alt="Help button" onClick={() => this.openHelpModal(resources.VESTIMATED_REWARD)} className="tw-h-4 tw-w-4 tw-inline-block tw-ml-2 tw-cursor-pointer minustop" />
                              </div>
                              <div className="tw-stat-value tw-text-accent">{this.state.vestimatedReward.toLocaleString()}</div>
                              <div className="tw-stat-desc">{token}</div>
                            </div>
                            <div className="tw-stat tw-border-t-1 md:tw-border-t-0 md:tw-border-base-200">
                              <div className="tw-stat-title">
                                {resources.VESTIMATED_APY.TITLE}
                                <img src="../../assets/img/svg/circle-help-purple.svg" alt="Help button" onClick={() => this.openHelpModal(resources.VESTIMATED_APY)} className="tw-h-4 tw-w-4 tw-inline-block tw-ml-2 tw-cursor-pointer minustop" />
                              </div>
                              <div className="tw-stat-value tw-text-accent">{this.state.vestimatedApy}</div>
                              <div className="tw-stat-desc">%</div>
                            </div>
                          </div>
                          <div className="tw-mb-3 tw-form-control">
                            <button type="button" className="keybtn maxbuttons" disabled={this.state.depositAmount < 1 || this.vestingBlocks() < 1 || this.unbondingBlocks() < 1 || this.state.depositAmount > availableAmount} onClick={this.addDeposit}>Deposit</button>
                          </div>
                        </fieldset>
                      </form>
                    </div>
                    <div className="tw-grid tw-mt-4">

                      {this.state.vestiplotProgress > 0 && this.state.vestiplotProgress < 100 &&
                        <div className="tw-overlay tw-z-20">
                          <div className="overlayloader tw-flex tw-flex-col tw-items-center tw-justify-center ">
                            <div>
                              <Puff color="#00BFFF" />
                            </div>
                            <div>
                              <p className="approxLabel tw-mt-4">{this.state.vestiplotProgress}%</p>
                            </div>
                          </div>
                        </div>
                      }
                      
                      <div className="plotcontainer tw-z-10">
                        <div className="tw-flex tw-flex-col xl:tw-flex-row">

                          {this.state.vestiplotReward.length > 0 &&
                            <Plot
                              data={this.state.vestiplotReward}
                              layout={{
                                scene: {
                                  xaxis: { title: resources.VESTING_BLOCKS.TITLE },
                                  yaxis: { title: resources.UNBONDING_BLOCKS.TITLE },
                                  zaxis: { title: resources.VESTIMATED_REWARD.TITLE },
                                },
                                margin: { l: 0, r: 0, b: 0, t: 0, pad: 0 },
                                paper_bgcolor: 'rgba(0,0,0,0)',
                                plot_bgcolor: 'rgba(0,0,0,0)'
                              }}
                            />
                          }

                          {this.state.vestiplotApy.length > 0 &&
                            <Plot
                              data={this.state.vestiplotApy}
                              layout={{
                                scene: {
                                  xaxis: { title: resources.VESTING_BLOCKS.TITLE },
                                  yaxis: { title: resources.UNBONDING_BLOCKS.TITLE },
                                  zaxis: { title: resources.VESTIMATED_APY.TITLE },
                                },
                                margin: { l: 0, r: 0, b: 0, t: 0, pad: 0 },
                                paper_bgcolor: 'rgba(0,0,0,0)',
                                plot_bgcolor: 'rgba(0,0,0,0)'
                              }}
                            />
                          }
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {this.state.farmingSummary.length > 0 &&
                  <div className="summarytable">
                    <h3 className="tw-mb-5 headingfont sectiontitle tw-mt-10">{resources.FARMING_SUMMARY.TITLE}</h3>
                    <div className="tw-overflow-x-auto tw-text-secondary tw-my-5">
                      {this.renderFarmingSummaryTable(this.state.farmingSummary)}
                    </div>
                  </div>
                }

                {this.state.unbondingSummary.length > 0 && this.state.unbondingSummary.some(u => parseInt(u.expiryBlock) - this.state.blockNumber > 0) &&
                  <div className="summarytable">
                    <h3 className="tw-mb-5 tw-headingfont tw-sectiontitle tw-mt-10">{resources.UNBONDING_SUMMARY.TITLE}</h3>
                    <div className="tw-overflow-x-auto tw-text-secondary tw-my-5">
                      {this.renderUnbondingSummaryTable(this.state.unbondingSummary)}
                    </div>
                  </div>
                }

                <div className="my-5">
                  <p style={{ color: this.state.success ? 'green' : 'red' }}>{this.state.message}</p>
                </div>
              </div>
            </div>
          </div>
      
          <div>
            <Modal open={this.state.openHelpModal} onClose={this.closeHelpModal} center classNames={{ overlay: 'customOverlay', modal: 'customModal' }}>
              <h1>{this.state.helpTitle}</h1>
              <p>{this.state.helpInfo}</p>
              <br />
              <p>{this.state.helpDetails}</p>
            </Modal>
          </div>
        </div>
      </div>
    );
  }

  //#endregion
}
