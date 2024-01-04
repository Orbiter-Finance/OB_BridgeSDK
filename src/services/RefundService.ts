import {
  equalsIgnoreCase,
  getActiveSigner,
  getContract,
  throwNewError,
} from "../utils";
import { Signer, ethers } from "ethers-6";
import { Account, Contract, uint256 } from "starknet";
import ChainsService from "./ChainsService";
import TokensService from "./TokensService";
import { IChainInfo, IToken, TAddress, TSymbol, TTokenName } from "../types";
import { STARKNET_ERC20_ABI } from "../constant/abi";
import Web3 from "web3";
import { getGlobalState } from "../globalState";
import loopring from "../crossControl/loopring";

export default class RefundService {
  private chainsService: ChainsService;
  private tokensService: TokensService;
  private static instance: RefundService;

  constructor() {
    this.chainsService = ChainsService.getInstance();
    this.tokensService = TokensService.getInstance();
  }

  public static getInstance(): RefundService {
    if (!this.instance) {
      this.instance = new RefundService();
    }

    return this.instance;
  }

  public async toSend(params: {
    to: string;
    amount: number | string;
    token: TTokenName | TAddress | TSymbol;
    fromChainId: string | number;
    isLoopring?: boolean;
  }): Promise<any> {
    const currentSigner = getActiveSigner<Web3 | Signer | Account>();
    if (!Object.keys(currentSigner).length)
      return throwNewError("can not send transfer without signer.");
    const { to, amount, token, fromChainId, isLoopring } = params;
    if (!to || !amount || !token) return throwNewError("toSend params error.");
    let account: string | Promise<string>;
    const tokenInfo = await this.tokensService.queryToken(fromChainId, token);
    if (!tokenInfo) return throwNewError("Without tokenInfo.");

    const fromChainInfo = await this.chainsService.queryChainInfo(fromChainId);
    if (isLoopring) {
      const account = await getActiveSigner<Web3>().eth.getAccounts();
      if (!account) return throwNewError("loopring refund`s account is error.");
      const options = {
        to,
        amount,
        token,
        account: account[0],
        fromChainId,
        tokenInfo,
        fromChainInfo,
      };
      return await this.sendToLoopring(options);
    }
    if ("getAddress" in currentSigner) {
      account = await currentSigner.getAddress();
      return await this.sendToEvm({
        to,
        amount,
        token,
        account,
        fromChainId,
        tokenInfo,
        fromChainInfo,
      });
    } else if ("address" in currentSigner) {
      account = currentSigner.address;
      return await this.sendToStarknet({
        to,
        amount,
        token,
        account,
      });
    }
  }

  private async sendToLoopring(options: {
    account: string;
    to: string;
    amount: number | string;
    token: TTokenName | TAddress | TSymbol;
    fromChainId: string | number;
    tokenInfo: IToken;
    fromChainInfo: IChainInfo;
  }) {
    const { account, to, amount, token, fromChainInfo } = options;
    const loopringSigner: Web3 = getGlobalState().loopringSigner;
    if (!Object.keys(loopringSigner).length) {
      return throwNewError(
        "should update loopringSigner by updateConfig function."
      );
    }
    try {
      return await loopring.sendTransfer(
        loopringSigner,
        account,
        String(fromChainInfo.chainId),
        to,
        token,
        ethers.parseUnits(String(amount)),
        ""
      );
    } catch (error: any) {
      const errorEnum = {
        "account is not activated":
          "This Loopring account is not yet activated, please activate it before transferring.",
        "User account is frozen":
          "Your Loopring account is frozen, please check your Loopring account status on Loopring website. Get more details here: https://docs.loopring.io/en/basics/key_mgmt.html?h=frozen",
        default: error.message,
      };
      return throwNewError(
        errorEnum[error.message as keyof typeof errorEnum] ||
          errorEnum.default ||
          "Something was wrong by loopring transfer. please check it all",
        error
      );
    }
  }

  private async sendToStarknet(options: {
    account: string;
    to: string;
    amount: number | string;
    token: TTokenName | TAddress | TSymbol;
  }) {
    const currentSigner = getActiveSigner<Account>();
    const { account, to, amount, token } = options;
    const erc20Contract = new Contract(
      STARKNET_ERC20_ABI,
      token,
      currentSigner
    );
    if (!account) return throwNewError("starknet account error");
    try {
      const transferERC20TxCall = erc20Contract.populate("transfer", [
        to,
        {
          type: "struct",
          ...uint256.bnToUint256(ethers.parseUnits(String(amount))),
        },
      ]);
      return await currentSigner.execute(transferERC20TxCall);
    } catch (e) {
      console.log(e);
      return throwNewError("starknet refund error", e);
    }
  }

  private async sendToEvm(options: {
    account: string;
    to: string;
    amount: number | string;
    token: TTokenName | TAddress | TSymbol;
    fromChainId: string | number;
    tokenInfo: IToken;
    fromChainInfo: IChainInfo;
  }) {
    const currentSigner = getActiveSigner<Signer>();
    const {
      account,
      to,
      amount,
      token,
      fromChainId,
      fromChainInfo,
      tokenInfo,
    } = options;
    let gasLimit: bigint;

    const value = ethers.parseUnits(String(amount), tokenInfo.decimals);

    if (
      equalsIgnoreCase(fromChainInfo.nativeCurrency.address, tokenInfo.address)
    ) {
      gasLimit = await getActiveSigner<Signer>().estimateGas({
        from: account,
        to,
        value,
      });
      if (String(fromChainId) === "2" && gasLimit < 21000n) {
        gasLimit = 21000n;
      }
      return await currentSigner.sendTransaction({
        from: account,
        to,
        value,
        gasLimit,
      });
    } else {
      const transferContract = getContract({
        contractAddress: token,
        localChainID: fromChainId,
        signer: currentSigner,
      });
      if (!transferContract) {
        return throwNewError(
          "Failed to obtain contract information, please try again."
        );
      }

      gasLimit = await transferContract.transfer.estimateGas(to, value);
      if (String(fromChainId) === "42161" && gasLimit < 21000n) {
        gasLimit = 21000n;
      }

      return await transferContract.transfer(to, value, {
        gasLimit,
      });
    }
  }
}
