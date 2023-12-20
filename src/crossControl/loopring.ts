import Web3 from "web3";
import config from "../constant/config";
import { CHAIN_ID_MAINNET } from "../constant/common";
import Axios from "../request";
import { AccountInfo } from "../types";
import { sleep } from "../utils";
const loopring = require("@loopring-web/loopring-sdk");

const getNetworkId = (fromChainID: string) => {
  return fromChainID === CHAIN_ID_MAINNET.loopring
    ? loopring.ChainId.MAINNET
    : loopring.ChainId.GOERLI;
};

export default {
  getUserAPI: function (fromChainID: string) {
    return new loopring.UserAPI({ chainId: getNetworkId(fromChainID) });
  },

  getExchangeAPI: function (fromChainID: string) {
    return new loopring.ExchangeAPI({ chainId: getNetworkId(fromChainID) });
  },
  getLpTokenInfoOnce: async function (
    fromChainID: string,
    tokenAddress: string
  ) {
    const url = `${
      fromChainID === CHAIN_ID_MAINNET.loopring
        ? config.loopring.Mainnet
        : config.loopring.Rinkeby
    }/api/v3/exchange/tokens`;
    try {
      const response = await Axios.get(url);
      if (response.status === 200 && response?.data) {
        return response.data.find((item: any) => item.address == tokenAddress);
      } else {
        throw new Error(
          "Loopring transfer is failed by getLpTokenInfo function."
        );
      }
    } catch (error: any) {
      throw new Error(
        `Loopring transfer is error by getLpTokenInfo function. = ${error.message}`
      );
    }
  },

  getLpTokenInfo: async function (
    fromChainID: string,
    tokenAddress: string,
    count = 10
  ) {
    const theLpTokenInfo = await this.getLpTokenInfoOnce(
      fromChainID,
      tokenAddress
    );
    console.log(theLpTokenInfo, "theLpTokenInfo");
    if (theLpTokenInfo) {
      return theLpTokenInfo;
    } else {
      await sleep(100);
      count--;
      if (count > 0) {
        await this.getLpTokenInfo(fromChainID, tokenAddress, count);
      } else {
        return 0;
      }
    }
  },

  accountInfo: async function (
    address: string,
    fromChainID: string
  ): Promise<{ accountInfo: AccountInfo; code: number } | any> {
    try {
      const exchangeApi = this.getExchangeAPI(fromChainID);
      const response: { accountInfo: AccountInfo; code: number } | any =
        await exchangeApi.getAccount({ owner: address });
      if (response.accInfo && response.raw_data) {
        const info = {
          accountInfo: response.accInfo,
          code: 0,
        };
        return info;
      } else {
        const info = {
          code: response?.code,
          errorMessage:
            response?.code == 101002 ? "noAccount" : response?.message,
        };
        return info;
      }
    } catch (error: any) {
      throw new Error(`get lp accountInfo error:${error.message}`);
    }
  },

  sendTransfer: async function (
    signer: Web3,
    address: string,
    fromChainID: string,
    toAddress: string,
    tokenAddress: string,
    amount: BigInt,
    memo: string
  ) {
    const web3 = signer;
    const networkId = getNetworkId(fromChainID);
    const exchangeApi = this.getExchangeAPI(fromChainID);
    const userApi = this.getUserAPI(fromChainID);
    const accountResult = await this.accountInfo(address, fromChainID);

    if (!accountResult) {
      throw Error("loopring get account error");
    }
    let accInfo;
    if (accountResult.code) {
      throw Error("Get loopring account error");
    } else {
      accInfo = accountResult?.accountInfo;
    }

    const accountId = accInfo?.accountId;
    const info = await userApi?.getCounterFactualInfo({ accountId });
    const isCounterFactual = !!info?.counterFactualInfo?.walletOwner;

    if (
      accInfo.nonce == 0 &&
      accInfo.keyNonce == 0 &&
      accInfo.publicKey.x == "" &&
      accInfo.publicKey.y == "" &&
      accInfo.keySeed == ""
    ) {
      throw Error("account is not activated");
    }
    if (accInfo.frozen) {
      throw Error("User account is frozen");
    }
    const { exchangeInfo } = await exchangeApi.getExchangeInfo();

    const options = {
      web3,
      address: accInfo.owner,
      keySeed:
        accInfo.keySeed && accInfo.keySeed !== ""
          ? accInfo.keySeed
          : loopring.GlobalAPI.KEY_MESSAGE.replace(
              "${exchangeAddress}",
              exchangeInfo.exchangeAddress
            ).replace("${nonce}", (accInfo.nonce - 1).toString()),
      walletType: "Unknown",
      chainId: networkId,
    };
    if (isCounterFactual) {
      Object.assign(options, { accountId });
    }

    const eddsaKey = await loopring.generateKeyPair(options);

    const GetUserApiKeyRequest = {
      accountId,
    };
    const { apiKey } = await userApi.getUserApiKey(
      GetUserApiKeyRequest,
      eddsaKey.sk
    );
    if (!apiKey) {
      throw Error("Get Loopring ApiKey Error");
    }

    const lpTokenInfo = await this.getLpTokenInfo(fromChainID, tokenAddress);
    const GetNextStorageIdRequest = {
      accountId,
      sellTokenId: lpTokenInfo.tokenId,
    };
    const storageId = await userApi.getNextStorageId(
      GetNextStorageIdRequest,
      apiKey
    );

    const OriginTransferRequestV3 = {
      exchange: exchangeInfo.exchangeAddress,
      payerAddr: address,
      payerId: accountId,
      payeeAddr: toAddress,
      payeeId: 0,
      storageId: storageId.offchainId,
      token: {
        tokenId: lpTokenInfo.tokenId,
        volume: amount + "",
      },
      maxFee: {
        tokenId: 0,
        volume: "94000000000000000",
      },
      validUntil: Math.round(Date.now() / 1000) + 30 * 86400,
      memo,
    };
    return isCounterFactual
      ? await userApi.submitInternalTransfer(
          {
            request: OriginTransferRequestV3,
            web3,
            chainId: networkId,
            walletType: "Unknown",
            eddsaKey: eddsaKey.sk,
            apiKey,
          },
          { accountId, counterFactualInfo: info.counterFactualInfo }
        )
      : await userApi.submitInternalTransfer({
          request: OriginTransferRequestV3,
          web3,
          chainId: networkId,
          walletType: "Unknown",
          eddsaKey: eddsaKey.sk,
          apiKey,
        });
  },
};
