import { ChainId } from '@0x/contract-addresses';
import { BigNumber } from '@0x/utils';
import {
    formatSequence,
    getTokenAddressesForSwap,
    NewPath,
    parseToPoolsDict,
    PoolDictionary,
    RouteProposer,
    SwapTypes,
    SorConfig,
    TokenPriceService,
    SOR,
} from '@balancer-labs/sor';
import { JsonRpcProvider } from '@ethersproject/providers';

import { DEFAULT_WARNING_LOGGER } from '../../../constants';
import { LogFunction } from '../../../types';
import { BALANCER_V2_SUBGRAPH_URL_BY_CHAIN, ONE_SECOND_MS } from '../constants';
import { BalancerSwapInfo, BalancerSwaps } from '../types';

import { CacheValue, EMPTY_BALANCER_SWAPS, SwapInfoCache } from './pair_swaps_cache';
import { SubgraphPoolDataService } from './sgPoolDataService';

const ONE_DAY_MS = 24 * 60 * 60 * ONE_SECOND_MS;

type BalancerChains = ChainId.Mainnet | ChainId.Polygon | ChainId.Arbitrum | ChainId.Goerli;

const SOR_CONFIG: Record<BalancerChains, SorConfig> = {
    [ChainId.Mainnet]: {
        chainId: ChainId.Mainnet,
        vault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
        weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        wETHwstETH: {
            id: '0x32296969ef14eb0c6d29669c550d4a0449130230000200000000000000000080',
            address: '0x32296969ef14eb0c6d29669c550d4a0449130230',
        },
    },
    [ChainId.Polygon]: {
        chainId: ChainId.Polygon,
        vault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
        weth: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    },
    [ChainId.Arbitrum]: {
        chainId: ChainId.Arbitrum,
        vault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
        weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    },
    [ChainId.Goerli]: {
        chainId: ChainId.Goerli,
        vault: '0x65748E8287Ce4B9E6D83EE853431958851550311',
        weth: '0x9A1000D492d40bfccbc03f413A48F5B6516Ec0Fd',
    },
};

class MockTokenPriceService implements TokenPriceService {
    public async getNativeAssetPriceInToken(): Promise<string> {
        return '';
    }
}

export class BalancerV2SwapInfoCache extends SwapInfoCache {
    private static readonly _MAX_POOLS_PER_PATH = 4;
    private static readonly _MAX_CANDIDATE_PATHS_PER_PAIR = 2;
    private readonly _routeProposer: RouteProposer;
    private readonly _poolDataService: SubgraphPoolDataService;

    constructor(
        chainId: ChainId,
        subgraphUrl: string | null = BALANCER_V2_SUBGRAPH_URL_BY_CHAIN[chainId],
        private readonly _warningLogger: LogFunction = DEFAULT_WARNING_LOGGER,
        cache: { [key: string]: CacheValue } = {},
    ) {
        super(cache);
        const provider = new JsonRpcProvider('');
        this._poolDataService = new SubgraphPoolDataService({
            chainId,
            subgraphUrl,
        });
        const sor = new SOR(
            provider,
            SOR_CONFIG[chainId as BalancerChains],
            this._poolDataService,
            new MockTokenPriceService(),
        );

        // The RouteProposer finds paths between a token pair using direct/multihop/linearPool routes
        this._routeProposer = sor.routeProposer;
        // Uses Subgraph to retrieve up to date pool data required for routeProposer

        void this._loadTopPoolsAsync();
        // Reload the top pools every 12 hours
        setInterval(async () => void this._loadTopPoolsAsync(), ONE_DAY_MS / 2);
    }

    protected async _loadTopPoolsAsync(): Promise<void> {
        const fromToSwapInfo: {
            [from: string]: { [to: string]: BalancerSwaps };
        } = {};

        // Retrieve pool data from Subgraph
        const pools = await this._poolDataService.getPools();
        // timestamp is used for Element pools
        const timestamp = Math.floor(Date.now() / ONE_SECOND_MS);
        const poolsDict = parseToPoolsDict(pools, timestamp);

        for (const pool of pools) {
            const { tokensList } = pool;
            await null; // This loop can be CPU heavy so yield to event loop.
            for (const from of tokensList) {
                for (const to of tokensList.filter((t) => t.toLowerCase() !== from.toLowerCase())) {
                    fromToSwapInfo[from] = fromToSwapInfo[from] || {};
                    // If a record for pair already exists skip as all paths alreay found
                    if (fromToSwapInfo[from][to]) {
                        continue;
                    } else {
                        try {
                            const expiresAt = Date.now() + this._cacheTimeMs;
                            // Retrieve swap steps and assets for a token pair
                            // This only needs to be called once per pair as all paths will be created from single call
                            const pairSwapInfo = this._getPoolPairSwapInfo(poolsDict, from, to);
                            fromToSwapInfo[from][to] = pairSwapInfo;
                            this._cacheSwapInfoForPair(from, to, fromToSwapInfo[from][to], expiresAt);
                        } catch (err) {
                            this._warningLogger(err, `Failed to load Balancer V2 top pools`);
                            // soldier on
                        }
                    }
                }
            }
        }
    }

    /**
     * Will retrieve fresh pair and path data from Subgraph and return and array of swap info for pair..
     * @param takerToken Address of takerToken.
     * @param makerToken Address of makerToken.
     * @returns Swap data for pair consisting of assets and swap steps for ExactIn and ExactOut swap types.
     */
    protected async _fetchSwapInfoForPairAsync(takerToken: string, makerToken: string): Promise<BalancerSwaps> {
        try {
            // retrieve up to date pools from SG
            const pools = await this._poolDataService.getPools();

            // timestamp is used for Element pools
            const timestamp = Math.floor(Date.now() / ONE_SECOND_MS);
            const poolDictionary = parseToPoolsDict(pools, timestamp);
            return this._getPoolPairSwapInfo(poolDictionary, takerToken, makerToken);
        } catch (e) {
            return EMPTY_BALANCER_SWAPS;
        }
    }

    /**
     * Uses pool data from provided dictionary to find top swap paths for token pair.
     * @param pools Dictionary of pool data.
     * @param takerToken Address of taker token.
     * @param makerToken Address of maker token.
     * @returns Swap data for pair consisting of assets and swap steps for ExactIn and ExactOut swap types.
     */
    private _getPoolPairSwapInfo(pools: PoolDictionary, takerToken: string, makerToken: string): BalancerSwaps {
        /*
        Uses Balancer SDK to construct available paths for pair.
        Paths can be direct, i.e. both tokens are in same pool or multihop.
        Will also create paths for the new Balancer Linear pools.
        These are returned in order of available liquidity which is useful for filtering.
        */
        const paths = this._routeProposer.getCandidatePathsFromDict(
            takerToken,
            makerToken,
            SwapTypes.SwapExactIn,
            pools,
            BalancerV2SwapInfoCache._MAX_POOLS_PER_PATH,
        );

        if (paths.length === 0) {
            return EMPTY_BALANCER_SWAPS;
        }

        // Convert paths data to swap information suitable for queryBatchSwap. Only use top 2 liquid paths
        return formatSwaps(paths.slice(0, BalancerV2SwapInfoCache._MAX_CANDIDATE_PATHS_PER_PAIR));
    }
}

/**
 * Given an array of Balancer paths, returns swap information that can be passed to queryBatchSwap.
 * @param paths Array of Balancer paths.
 * @returns Formatted swap data consisting of assets and swap steps for ExactIn and ExactOut swap types.
 */
function formatSwaps(paths: NewPath[]): BalancerSwaps {
    const formattedSwapsExactIn: BalancerSwapInfo[] = [];
    const formattedSwapsExactOut: BalancerSwapInfo[] = [];
    let assets: string[];
    paths.forEach((path) => {
        // Add a swap amount for each swap so we can use formatSequence. (This will be overwritten with actual amount during query)
        path.swaps.forEach((s) => (s.swapAmount = '0'));
        const tokenAddresses = getTokenAddressesForSwap(path.swaps);
        // Formats for both ExactIn and ExactOut swap types
        const swapsExactIn = formatSequence(SwapTypes.SwapExactIn, path.swaps, tokenAddresses);
        const swapsExactOut = formatSequence(SwapTypes.SwapExactOut, path.swaps, tokenAddresses);
        assets = tokenAddresses;
        formattedSwapsExactIn.push({
            assets,
            swapSteps: swapsExactIn.map((s) => ({
                ...s,
                amount: new BigNumber(s.amount),
            })),
        });
        formattedSwapsExactOut.push({
            assets,
            swapSteps: swapsExactOut.map((s) => ({
                ...s,
                amount: new BigNumber(s.amount),
            })),
        });
    });
    const formattedSwaps: BalancerSwaps = {
        swapInfoExactIn: formattedSwapsExactIn,
        swapInfoExactOut: formattedSwapsExactOut,
    };
    return formattedSwaps;
}
