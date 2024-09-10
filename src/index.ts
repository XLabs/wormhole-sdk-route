import {
  Quote as MayanQuote,
  QuoteParams,
  ReferrerAddresses,
  addresses,
  createSwapFromSolanaInstructions,
  fetchQuote,
  getSwapFromEvmTxPayload,
} from "@mayanfinance/swap-sdk";
import { MessageV0, PublicKey, VersionedTransaction } from "@solana/web3.js";
import {
  Chain,
  ChainAddress,
  ChainContext,
  Network,
  Signer,
  SourceInitiatedTransferReceipt,
  TokenId,
  TransactionId,
  TransferState,
  Wormhole,
  amount,
  canonicalAddress,
  isAttested,
  isCompleted,
  isNative,
  isRedeemed,
  isRefunded,
  isSignAndSendSigner,
  isSignOnlySigner,
  isSourceFinalized,
  isSourceInitiated,
  nativeChainIds,
  routes,
} from "@wormhole-foundation/sdk-connect";
import {
  circle,
} from "@wormhole-foundation/sdk-base";
import {
  EvmChains,
  EvmPlatform,
  EvmUnsignedTransaction,
} from "@wormhole-foundation/sdk-evm";
import {
  SolanaPlatform,
  SolanaUnsignedTransaction,
} from "@wormhole-foundation/sdk-solana";
import {
  NATIVE_CONTRACT_ADDRESS,
  fetchTokensForChain,
  getTransactionStatus,
  supportedChains,
  toMayanChainName,
  txStatusToReceipt,
} from "./utils";

export namespace MayanRoute {
  export type Options = {
    gasDrop: number;
    slippage: number;
    optimizeFor: 'cost' | 'speed';
  };
  export type NormalizedParams = {
    slippageBps: number;
  };
  export interface ValidatedParams
    extends routes.ValidatedTransferParams<Options> {
    normalizedParams: NormalizedParams;
  }
}

type Op = MayanRoute.Options;
type Vp = MayanRoute.ValidatedParams;
type Q = routes.Quote<Op, Vp, MayanQuote>;
type QR = routes.QuoteResult<Op, Vp, MayanQuote>;
type R = routes.Receipt;

type Tp = routes.TransferParams<Op>;
type Vr = routes.ValidationResult<Op>;

export class MayanRoute<N extends Network>
  extends routes.AutomaticRoute<N, Op, Vp, R>
  implements routes.StaticRouteMethods<typeof MayanRoute>
{

  MAX_SLIPPAGE = 1;

  static NATIVE_GAS_DROPOFF_SUPPORTED = false;
  static override IS_AUTOMATIC = true;

  static meta = {
    name: "MayanSwap",
  };

  getDefaultOptions(): Op {
    return {
      gasDrop: 0,
      slippage: 0.03,
      optimizeFor: 'speed'
    };
  }

  static supportedNetworks(): Network[] {
    return ["Mainnet"];
  }

  static supportedChains(_: Network): Chain[] {
    return supportedChains();
  }

  static async supportedSourceTokens(
    fromChain: ChainContext<Network>
  ): Promise<TokenId[]> {
    return fetchTokensForChain(fromChain.chain);
  }

  static isProtocolSupported<N extends Network>(chain: ChainContext<N>): boolean {
    return supportedChains().includes(chain.chain);
  }

  static supportedDestinationTokens<N extends Network>(
    _token: TokenId,
    _fromChain: ChainContext<N>,
    toChain: ChainContext<N>
  ): Promise<TokenId[]> {
    return fetchTokensForChain(toChain.chain);
  }

  async isAvailable(): Promise<boolean> {
    // No way to check relayer availability so assume true
    return true;
  }

  async validate(request: routes.RouteTransferRequest<N>, params: Tp): Promise<Vr> {
    try {
      params.options = params.options ?? this.getDefaultOptions();

      if (params.options.slippage > this.MAX_SLIPPAGE)
        throw new Error("Slippage must be less than 100%");

      return {
        valid: true,
        params: {
          ...params,
          normalizedParams: {
            slippageBps: params.options.slippage * 10000,
          },
        },
      } as Vr;
    } catch (e) {
      return { valid: false, params, error: e as Error };
    }
  }

  protected destTokenAddress(request: routes.RouteTransferRequest<N>): string {
    const { destination } = request;
    return destination && !isNative(destination.id.address)
      ? canonicalAddress(destination.id)
      : NATIVE_CONTRACT_ADDRESS;
  }

  protected sourceTokenAddress(request: routes.RouteTransferRequest<N>): string {
    const { source } = request;
    return !isNative(source.id.address)
      ? canonicalAddress(source.id)
      : NATIVE_CONTRACT_ADDRESS;
  }

  protected async fetchQuote(request: routes.RouteTransferRequest<N>, params: Vp): Promise<MayanQuote | undefined> {
    const { fromChain, toChain } = request;

    const quoteOpts: QuoteParams = {
      amount: Number(params.amount),
      fromToken: this.sourceTokenAddress(request),
      toToken: this.destTokenAddress(request),
      fromChain: toMayanChainName(fromChain.chain),
      toChain: toMayanChainName(toChain.chain),
      ...this.getDefaultOptions(),
      ...params.options,
      slippageBps: params.normalizedParams.slippageBps,
    };

    const quotes = await fetchQuote(quoteOpts);
    if (quotes.length === 0) return undefined;
    if (quotes.length === 1) return quotes[0];

    // Wormhole SDK routes return only a single quote, but Mayan offers multiple quotes (because 
    // Mayan comprises multiple competing protocols). We sort the quotes Mayan gives us and choose
    // the best one here.
    //
    // User can provide optimizeFor option to indicate what they care about. It defaults to "cost"
    // which just optimizes for highest amount out, but it can also be set to "speed" which will
    // choose the fastest route instead.
    quotes.sort((a: MayanQuote, b: MayanQuote) => {
      if (params.options.optimizeFor === 'cost') {
        if (b.expectedAmountOut === a.expectedAmountOut) {
          // If expected amounts out are identical, fall back to speed
          /* @ts-ignore */
          return a.etaSeconds - b.etaSeconds
        } else {
          // Otherwise sort by amount out, descending
          return b.expectedAmountOut - a.expectedAmountOut
        }
      } else if (params.options.optimizeFor === 'speed') {
          /* @ts-ignore */
        if (a.etaSeconds === b.etaSeconds) {
          // If ETAs are identical, fall back to cost
          return b.expectedAmountOut - a.expectedAmountOut
        } else {
          // Otherwise sort by ETA, ascending
          /* @ts-ignore */
          return a.etaSeconds - b.etaSeconds
        }
      } else {
        // Should be unreachable
        return 0;
      }
    });

    return quotes[0];
  }

  async quote(request: routes.RouteTransferRequest<N>, params: Vp): Promise<QR> {
    try {
      const { fromChain, toChain } = request;
      const quote = await this.fetchQuote(request, params);
      if (!quote) {
        return {
          success: false,
          error: new Error('Could not get Mayan quote'),
        }
      }

      // Mayan fees are complicated and they normalize them for us in USD as clientRelayerFeeSuccess
      // We return this value as-is and express it as a USDC value for the sake of formatting
      const relayFee = {
        token: {
          chain: 'Solana' as Chain,
          address:  Wormhole.parseAddress('Solana',
            circle.usdcContract.get(request.fromChain.network, request.fromChain.chain)!
          ),
        },
        amount: amount.parse(quote.clientRelayerFeeSuccess || '0', 6),
      };
      console.log('usdc fee');

      const fullQuote: Q = {
        success: true,
        params,
        sourceToken: {
          token: Wormhole.tokenId(fromChain.chain, this.sourceTokenAddress(request)),
          amount: amount.parse(
            amount.denoise(quote.effectiveAmountIn, quote.fromToken.decimals),
            quote.fromToken.decimals
          ),
        },
        destinationToken: {
          token: Wormhole.tokenId(toChain.chain, this.destTokenAddress(request)),
          amount: amount.parse(
            amount.denoise(quote.expectedAmountOut, quote.toToken.decimals),
            quote.toToken.decimals
          ),
        },
        relayFee,
        destinationNativeGas: amount.parse(
          amount.denoise(quote.gasDrop, quote.toToken.decimals),
          quote.toToken.decimals
        ),
        /* @ts-ignore TODO: https://github.com/mayan-finance/swap-sdk/pull/11 */
        eta: quote.etaSeconds * 1000,
        details: quote,
      };
      return fullQuote;
    } catch (e) {
      return {
        success: false,
        error: e as Error,
      };
    }
  }

  async initiate(request: routes.RouteTransferRequest<N>, signer: Signer<N>, quote: Q, to: ChainAddress) {
    const originAddress = signer.address();
    const destinationAddress = canonicalAddress(to);

    try {
      const rpc = await request.fromChain.getRpc();
      const txs: TransactionId[] = [];
      if (request.fromChain.chain === "Solana") {
        const { instructions, signers, lookupTables } =
          await createSwapFromSolanaInstructions(
            quote.details!,
            originAddress,
            destinationAddress,
            this.referrerAddress(),
            rpc
          );

        const message = MessageV0.compile({
          instructions,
          payerKey: new PublicKey(originAddress),
          recentBlockhash: "",
          addressLookupTableAccounts: lookupTables,
        });
        const txReqs = [
          new SolanaUnsignedTransaction(
            {
              transaction: new VersionedTransaction(message),
              signers: signers,
            },
            request.fromChain.network,
            request.fromChain.chain,
            "Execute Swap"
          ),
        ];

        if (isSignAndSendSigner(signer)) {
          const txids = await signer.signAndSend(txReqs);
          txs.push(
            ...txids.map((txid) => ({
              chain: request.fromChain.chain,
              txid,
            }))
          );
        } else if (isSignOnlySigner(signer)) {
          const signed = await signer.sign(txReqs);
          const txids = await SolanaPlatform.sendWait(
            request.fromChain.chain,
            rpc,
            signed
          );
          txs.push(
            ...txids.map((txid) => ({
              chain: request.fromChain.chain,
              txid,
            }))
          );
        }
      } else {
        const txReqs: EvmUnsignedTransaction<N, EvmChains>[] = [];
        const nativeChainId = nativeChainIds.networkChainToNativeChainId.get(
          request.fromChain.network,
          request.fromChain.chain
        );

        if (!isNative(request.source.id.address)) {
          const tokenContract = EvmPlatform.getTokenImplementation(
            await request.fromChain.getRpc(),
            this.sourceTokenAddress(request)
          );

          const contractAddress = addresses.MAYAN_FORWARDER_CONTRACT;

          const allowance = await tokenContract.allowance(
            originAddress,
            contractAddress
          );

          const amt = amount.units(quote.sourceToken.amount);
          if (allowance < amt) {
            const txReq = await tokenContract.approve.populateTransaction(
              // mayan contract address,
              contractAddress,
              amt
            );
            txReqs.push(
              new EvmUnsignedTransaction(
                {
                  from: signer.address(),
                  chainId: nativeChainId as bigint,
                  ...txReq,
                },
                request.fromChain.network,
                request.fromChain.chain as EvmChains,
                "Approve Allowance"
              )
            );
          }
        }

        const txReq = getSwapFromEvmTxPayload(
          quote.details!,
          originAddress,
          destinationAddress,
          this.referrerAddress(),
          originAddress,
          Number(nativeChainId!),
          undefined,
          undefined // permit?
        );

        txReqs.push(
          new EvmUnsignedTransaction(
            {
              from: signer.address(),
              chainId: nativeChainId,
              ...txReq,
            },
            request.fromChain.network,
            request.fromChain.chain as EvmChains,
            "Execute Swap"
          )
        );

        if (isSignAndSendSigner(signer)) {
          const txids = await signer.signAndSend(txReqs);
          txs.push(
            ...txids.map((txid) => ({
              chain: request.fromChain.chain,
              txid,
            }))
          );
        } else if (isSignOnlySigner(signer)) {
          const signed = await signer.sign(txReqs);
          const txids = await EvmPlatform.sendWait(
            request.fromChain.chain,
            rpc,
            signed
          );
          txs.push(
            ...txids.map((txid) => ({
              chain: request.fromChain.chain,
              txid,
            }))
          );
        }
      }

      return {
        from: request.fromChain.chain,
        to: request.toChain.chain,
        state: TransferState.SourceInitiated,
        originTxs: txs,
      } satisfies SourceInitiatedTransferReceipt;
    } catch (e) {
      console.error(e);
      throw e;
    }
  }

  public override async *track(receipt: R, timeout?: number) {
    if (isCompleted(receipt) || isRedeemed(receipt) || isRefunded(receipt)) return receipt;

    // What should be the default if no timeout is provided?
    let leftover = timeout ? timeout : 60 * 60 * 1000;
    while (leftover > 0) {
      const start = Date.now();

      if (
        // this is awkward but there is not hasSourceInitiated like fn in sdk (todo)
        isSourceInitiated(receipt) ||
        isSourceFinalized(receipt) ||
        isAttested(receipt)
      ) {
        const txstatus = await getTransactionStatus(
          receipt.originTxs[receipt.originTxs.length - 1]!
        );

        if (txstatus) {
          receipt = txStatusToReceipt(txstatus);
          yield { ...receipt, txstatus };

          if (isCompleted(receipt) || isRedeemed(receipt) || isRefunded(receipt)) return receipt;
        }
      } else {
        throw new Error("Transfer must have been initiated");
      }

      // sleep for 1 second so we dont spam the endpoint
      await new Promise((resolve) => setTimeout(resolve, 1000));
      leftover -= Date.now() - start;
    }

    return receipt;
  }

  override transferUrl(txid: string): string {
    return `https://explorer.mayan.finance/swap/${txid}`;
  }

  referrerAddress(): ReferrerAddresses | undefined {
    return undefined;
  }
}
