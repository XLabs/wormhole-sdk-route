import {
  ChainName as MayanChainName,
  Token as MayanToken,
  SolanaTransactionSigner,
  fetchTokenList,
} from "@mayanfinance/swap-sdk";
import { Transaction, VersionedTransaction } from "@solana/web3.js";
import {
  AttestationReceipt,
  Chain,
  CompletedTransferReceipt,
  FailedTransferReceipt,
  RedeemedTransferReceipt,
  RefundedTransferReceipt,
  Signer,
  SourceFinalizedTransferReceipt,
  SourceInitiatedTransferReceipt,
  TokenId,
  TransactionId,
  TransferState,
  deserialize,
  encoding,
  isSignOnlySigner,
  nativeTokenId,
  routes,
  toChain,
  toNative,
} from "@wormhole-foundation/sdk-connect";
import { isEvmNativeSigner } from "@wormhole-foundation/sdk-evm";
import { SolanaUnsignedTransaction } from "@wormhole-foundation/sdk-solana";
import axios from "axios";
import { ethers } from "ethers";
import tokenCache from "./tokens.json";

export const NATIVE_CONTRACT_ADDRESS =
  "0x0000000000000000000000000000000000000000";

// Deadline in minutes recommended by api
// hardcoded for now, but can be fetched from
// https://sia.mayan.finance/v3/init
const defaultDeadlines: {
  [key in Chain]?: number;
} = {
  Bsc: 16,
  Avalanche: 16,
  Polygon: 18,
  Ethereum: 76,
  Solana: 10,
  Arbitrum: 96,
  Aptos: 50,
};

// return the default deadline for a given chain in seconds
// or return 1 hour if not found
export function getDefaultDeadline(chain: Chain): number {
  if (chain in defaultDeadlines) return defaultDeadlines[chain]! * 60;
  return 60 * 60;
}

const chainNameMap = {
  Solana: "solana",
  Ethereum: "ethereum",
  Bsc: "bsc",
  Polygon: "polygon",
  Avalanche: "avalanche",
  Arbitrum: "arbitrum",
  Aptos: "aptos",
  Base: "base",
  Optimism: "optimism",
} as Record<Chain, MayanChainName>;

export function toMayanChainName(chain: Chain): MayanChainName {
  if (!chainNameMap[chain]) throw new Error(`Chain ${chain} not supported`);
  return chainNameMap[chain] as MayanChainName;
}

export function fromMayanChainName(mayanChain: MayanChainName): Chain {
  for (const [wormholeChain, mayanName] of Object.entries(chainNameMap)) {
    if (mayanName === mayanChain) {
      return wormholeChain as Chain;
    }
  }
  throw new Error(`Unknown Mayan chain ${mayanChain}`);
}


export function toWormholeChainName(chainIdStr: string): Chain {
  return toChain(Number(chainIdStr));
}

export function supportedChains(): Chain[] {
  return Object.keys(chainNameMap) as Chain[];
}

let tokenListCache = {} as Record<Chain, TokenId[]>;

export async function fetchTokensForChain(chain: Chain): Promise<TokenId[]> {
  if (chain in tokenListCache) {
    return tokenListCache[chain] as TokenId[];
  }

  let mayanTokens: MayanToken[];
  let chainName = toMayanChainName(chain);
  try {
    mayanTokens = await fetchTokenList(chainName);
  } catch (e) {
    mayanTokens = (tokenCache as Record<MayanChainName, MayanToken[]>)[
      chainName
    ];
  }

  const whTokens: TokenId[] = mayanTokens.map((mt: MayanToken): TokenId => {
    if (mt.contract === NATIVE_CONTRACT_ADDRESS) {
      return nativeTokenId(chain);
    } else {
      return {
        chain,
        address: toNative(chain, mt.contract),
      } as TokenId;
    }
  });

  tokenListCache[chain] = whTokens;
  return whTokens;
}

// https://solana-labs.github.io/solana-web3.js/classes/Transaction.html
function isTransaction(tx: any): tx is Transaction {
  return typeof (<Transaction>tx).verifySignatures === "function";
}

export function mayanSolanaSigner(signer: Signer): SolanaTransactionSigner {
  if (!isSignOnlySigner(signer))
    throw new Error("Signer must be a SignOnlySigner");

  return async <T extends Transaction | VersionedTransaction>(
    tx: T
  ): Promise<T> => {
    const ust: SolanaUnsignedTransaction<"Mainnet"> = {
      transaction: { transaction: tx },
      description: "Mayan.InitiateSwap",
      network: "Mainnet",
      chain: "Solana",
      parallelizable: false,
    };
    const signed = (await signer.sign([ust])) as Buffer[];
    if (isTransaction(tx)) return Transaction.from(signed[0]!) as T;
    else return VersionedTransaction.deserialize(signed[0]!) as T;
  };
}

export function mayanEvmSigner(signer: Signer): ethers.Signer {
  if (isEvmNativeSigner(signer))
    return signer.unwrap() as unknown as ethers.Signer;

  throw new Error("Signer must be an EvmNativeSigner");
}

export function mayanEvmProvider(signer: ethers.Signer) {
  return {
    getBlock: async function (): Promise<{ timestamp: number }> {
      let block = await signer.provider!.getBlock("latest");
      if (block === null)
        throw new Error("Failed to get latest Ethereum block");
      return block;
    },
  };
}

export enum MayanClientStatus {
  INPROGRESS = "INPROGRESS",
  COMPLETED = "COMPLETED",
  REFUNDED = "REFUNDED",
}

export enum MayanTransactionStatus {
  SETTLED_ON_SOLANA = "SETTLED_ON_SOLANA",
  CLAIMED_ON_SOLANA = "CLAIMED_ON_SOLANA",
  REDEEMED_ON_EVM = "REDEEMED_ON_EVM",
  REFUNDED_ON_EVM = "REFUNDED_ON_EVM",
  REFUNDED_ON_SOLANA = "REFUNDED_ON_SOLANA",
}

export function toWormholeTransferState(
  mts: MayanTransactionStatus
): TransferState {
  switch (mts) {
    case MayanTransactionStatus.SETTLED_ON_SOLANA:
    case MayanTransactionStatus.CLAIMED_ON_SOLANA:
    case MayanTransactionStatus.REDEEMED_ON_EVM:
      return TransferState.DestinationInitiated;
    case MayanTransactionStatus.REFUNDED_ON_EVM:
    case MayanTransactionStatus.REFUNDED_ON_SOLANA:
      return TransferState.Refunded;
    default:
      return TransferState.SourceInitiated;
  }
}

const possibleVaaTypes = [
  // Bridge to swap chain (solana)
  "transfer",
  // Info about the swap
  "swap",
  // Successful, bridge to destination chain
  "redeem",
  // Unsuccessful auction, refund back to source chain (evm)
  "refund",
];

export enum MayanTransactionGoal {
  // send from evm to solana
  Send = "SEND",
  // bridge to destination chain
  Bridge = "BRIDGE",
  // perform the swap
  Swap = "SWAP",
  // register for auction
  Register = "REGISTER",
  // settle on destination
  Settle = "SETTLE",
}

export interface TransactionStatus {
  id: string;
  trader: string;

  sourceChain: string;
  sourceTxHash: string;
  sourceTxBlockNo: number;
  status: MayanTransactionStatus;

  transferSequence: string;
  swapSequence: string;
  redeemSequence: string;
  refundSequence: string;
  fulfillSequence: string;

  deadline: string;

  swapChain: string;
  refundChain: string;

  destChain: string;
  destAddress: string;

  fromTokenAddress: string;
  fromTokenChain: string;
  fromTokenSymbol: string;
  fromAmount: string;
  fromAmount64: any;

  toTokenAddress: string;
  toTokenChain: string;
  toTokenSymbol: string;

  stateAddr: string;
  stateNonce: string;

  toAmount: any;

  transferSignedVaa: string;
  swapSignedVaa: string;
  redeemSignedVaa: string;
  refundSignedVaa: string;
  fulfillSignedVaa: string;

  savedAt: string;
  initiatedAt: string;
  completedAt: string;
  insufficientFees: boolean;
  retries: number;

  swapRelayerFee: string;
  redeemRelayerFee: string;
  refundRelayerFee: string;
  bridgeFee: string;

  statusUpdatedAt: string;

  redeemTxHash: string;
  refundTxHash: string;
  fulfillTxHash: string;

  unwrapRedeem: boolean;
  unwrapRefund: boolean;

  auctionAddress: string;
  driverAddress: string;
  mayanAddress: string;
  referrerAddress: string;
  auctionStateAddr: any;

  auctionStateNonce: any;

  gasDrop: string;
  gasDrop64: any;

  payloadId: number;
  orderHash: string;

  minAmountOut: any;
  minAmountOut64: any;

  service: string;

  refundAmount: string;

  posAddress: string;

  unlockRecipient: any;

  fromTokenLogoUri: string;
  toTokenLogoUri: string;

  fromTokenScannerUrl: string;
  toTokenScannerUrl: string;

  txs: Tx[];

  clientStatus: MayanClientStatus;
}

export interface Tx {
  txHash: string;
  goals: MayanTransactionGoal[];
  scannerUrl: string;
}

export function txStatusToReceipt(txStatus: TransactionStatus): routes.Receipt {
  const state = toWormholeTransferState(txStatus.status);
  const srcChain = toWormholeChainName(txStatus.sourceChain as MayanChainName);
  const dstChain = toWormholeChainName(txStatus.destChain as MayanChainName);

  const originTxs = txStatus.txs
    .filter((tx) => {
      return (
        // Send from Evm to Solana
        tx.goals.includes(MayanTransactionGoal.Send) ||
        // Register for auction on Solana
        tx.goals.includes(MayanTransactionGoal.Register)
      );
    })
    .map((tx) => {
      return {
        chain: srcChain,
        txid: tx.txHash,
      };
    });

  const destinationTxs = txStatus.txs
    .filter((tx) => {
      return tx.goals.includes(MayanTransactionGoal.Settle);
    })
    .map((tx) => {
      return {
        chain: dstChain,
        txid: tx.txHash,
      };
    });

  let refundTxs = [];
  if (txStatus.refundTxHash) {
    refundTxs.push({
      chain: fromMayanChainName(txStatus.refundChain as MayanChainName),
      txid: txStatus.refundTxHash
    });
  }

  const attestations: {
    [key: string]: Required<AttestationReceipt<"WormholeCore">>;
  } = {};
  for (const vaaType of possibleVaaTypes) {
    const key = `${vaaType}SignedVaa`;
    if (key in txStatus && txStatus[key as keyof TransactionStatus] !== null) {
      const vaa = deserialize(
        "Uint8Array",
        encoding.hex.decode(txStatus[key as keyof TransactionStatus])
      );

      attestations[vaaType] = {
        id: {
          emitter: vaa.emitterAddress,
          sequence: vaa.sequence,
          chain: vaa.emitterChain,
        },
        attestation: vaa,
      };
    }
  }

  const attestation =
    "redeem" in attestations && attestations["redeem"]
      ? attestations["redeem"]
      : attestations["transfer"];

  if (txStatus.clientStatus === MayanClientStatus.COMPLETED) {
    return {
      from: srcChain,
      to: dstChain,
      originTxs,
      destinationTxs,
      state: TransferState.DestinationFinalized,
      attestation: attestation || ({} as AttestationReceipt<"WormholeCore">),
    } satisfies CompletedTransferReceipt<
      AttestationReceipt<"WormholeCore">
    >;

  } else if (txStatus.clientStatus === MayanClientStatus.REFUNDED) {
    return {
      from: srcChain,
      to: dstChain,
      originTxs,
      refundTxs,
      state: TransferState.Refunded,
      attestation: attestations["refund"]!,
    } satisfies RefundedTransferReceipt<AttestationReceipt<"WormholeCore">>;

  } else if (txStatus.clientStatus === MayanClientStatus.INPROGRESS) {
    switch (state) {
      case TransferState.SourceInitiated:
        // Initital transfer vaa from source chain
        if ("transfer" in attestations && attestations["transfer"]) {
          return {
            from: srcChain,
            to: dstChain,
            originTxs,
            state: TransferState.SourceFinalized,
            attestation: attestations["transfer"],
          } satisfies SourceFinalizedTransferReceipt<
            AttestationReceipt<"WormholeCore">
          >;
        }
        break;

      case TransferState.DestinationInitiated:
        if (!attestation) break;

        return {
          from: srcChain,
          to: dstChain,
          originTxs,
          destinationTxs,
          state: TransferState.DestinationInitiated,
          attestation,
        } satisfies RedeemedTransferReceipt<AttestationReceipt<"WormholeCore">>;

      case TransferState.Failed:
        return {
          from: srcChain,
          to: dstChain,
          originTxs,
          destinationTxs,
          state,
          error: "Failed to complete transfer",
        } satisfies FailedTransferReceipt<AttestationReceipt<"WormholeCore">>;
    }

    // This default case occurs if the above breaks trigger
    return {
      from: srcChain,
      to: dstChain,
      originTxs,
      state: TransferState.SourceInitiated,
    } satisfies SourceInitiatedTransferReceipt;

  } else {
    throw new Error(`Unknown Mayan clientStatus ${txStatus.clientStatus}`);
  }
}

export async function getTransactionStatus(
  tx: TransactionId
): Promise<TransactionStatus | null> {
  const url = `https://explorer-api.mayan.finance/v3/swap/trx/${tx.txid}`;
  try {
    const response = await axios.get<TransactionStatus>(url);
    if (response.data.id) return response.data;
  } catch (error) {
    if (!error) return null;
    if (typeof error === "object") {
      // A 404 error means the VAA is not yet available
      // since its not available yet, we return null signaling it can be tried again
      if (axios.isAxiosError(error) && error.response?.status === 404)
        return null;
      if ("status" in error && error.status === 404) return null;
    }
    throw error;
  }
  return null;
}
