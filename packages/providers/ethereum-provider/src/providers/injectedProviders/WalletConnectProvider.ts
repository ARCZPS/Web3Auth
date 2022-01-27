import { providerFromEngine } from "@toruslabs/base-controllers";
import { JRPCEngine } from "@toruslabs/openlogin-jrpc";
import type { IConnector } from "@walletconnect/types";
import { CHAIN_NAMESPACES, CustomChainConfig, isHexStrict, WalletInitializationError, WalletLoginError } from "@web3auth/base";
import { BaseProvider, BaseProviderConfig, BaseProviderState } from "@web3auth/base-provider";
import { ethErrors } from "eth-rpc-errors";

import { createEthMiddleware } from "../../rpc/ethRpcMiddlewares";
import { createJsonRpcClient } from "../../rpc/jrpcClient";
import { getProviderHandlers } from "./walletConnectUtils";

export interface WalletConnectProviderConfig extends BaseProviderConfig {
  chainConfig: Omit<CustomChainConfig, "chainNamespace">;
}

export interface WalletConnectProviderState extends BaseProviderState {
  accounts: string[];
}

export class WalletConnectProvider extends BaseProvider<BaseProviderConfig, WalletConnectProviderState, IConnector> {
  private connector: IConnector | null = null;

  constructor({ config, state, connector }: { config: WalletConnectProviderConfig; state?: BaseProviderState; connector?: IConnector }) {
    super({
      config: { chainConfig: { ...config.chainConfig, chainNamespace: CHAIN_NAMESPACES.EIP155 } },
      state: { ...(state || {}), chainId: "loading", accounts: [] },
    });
    this.connector = connector || null;
  }

  public static getProviderInstance = async (params: {
    connector: IConnector;
    chainConfig: Omit<CustomChainConfig, "chainNamespace">;
  }): Promise<WalletConnectProvider> => {
    const providerFactory = new WalletConnectProvider({ config: { chainConfig: params.chainConfig } });
    await providerFactory.setupProvider(params.connector);
    return providerFactory;
  };

  public async enable(): Promise<string[]> {
    if (!this.connector)
      throw ethErrors.provider.custom({ message: "Connector is not initialized, pass wallet connect connector in constructor", code: 4902 });
    await this.setupProvider(this.connector);
    return this._providerEngineProxy.request({ method: "eth_accounts" });
  }

  public async setupProvider(connector: IConnector): Promise<void> {
    this.onConnectorStateUpdate(connector);
    await this.setupEngine(connector);
  }

  public async switchChain({ chainId }: { chainId: string }): Promise<void> {
    const currentChainConfig = this.getChainConfig(chainId);
    const { ticker, tickerName, rpcTarget } = currentChainConfig;
    this.update({
      chainId: "loading",
    });
    await this.connector.updateChain({
      chainId: Number.parseInt(chainId, 16),
      nativeCurrency: {
        name: tickerName,
        symbol: ticker,
      },
      networkId: Number.parseInt(chainId, 10),
      rpcUrl: rpcTarget,
    });
    this.configure({ chainConfig: currentChainConfig });
    await this.lookupNetwork(this.connector);
  }

  protected async lookupNetwork(connector: IConnector): Promise<string> {
    if (!connector.connected) throw WalletLoginError.notConnectedError("Wallet connect connector is not connected");
    if (!this.provider) throw ethErrors.provider.custom({ message: "Provider is not initialized", code: 4902 });
    const { chainId } = this.config.chainConfig;
    const connectedHexChainId = isHexStrict(connector.chainId.toString()) ? connector.chainId : `0x${connector.chainId.toString(16)}`;
    if (chainId !== connectedHexChainId)
      throw WalletInitializationError.rpcConnectionError(`Invalid network, net_version is: ${connectedHexChainId}, expected: ${chainId}`);

    this.update({ chainId: connectedHexChainId });
    this.provider.emit("connect", { chainId });
    this.provider.emit("chainChanged", this.state.chainId);
    return connectedHexChainId;
  }

  private async setupEngine(connector: IConnector): Promise<void> {
    const providerHandlers = getProviderHandlers({ connector });
    this.update({
      accounts: connector.accounts || [],
    });
    const ethMiddleware = createEthMiddleware(providerHandlers);
    const engine = new JRPCEngine();
    const { networkMiddleware } = createJsonRpcClient(this.config.chainConfig as CustomChainConfig);
    engine.push(ethMiddleware);
    engine.push(networkMiddleware);
    const provider = providerFromEngine(engine);
    this.updateProviderEngineProxy(provider);
    await this.lookupNetwork(connector);
  }

  private async onConnectorStateUpdate(connector: IConnector) {
    connector.on("session_update", async (error: Error | null, payload) => {
      if (!this.provider) throw WalletLoginError.notConnectedError("Wallet connect connector is not connected");
      if (error) {
        this.provider.emit("error", error);
        return;
      }
      const { accounts, chainId: connectedChainId, rpcUrl } = payload;
      // Check if accounts changed and trigger event
      if (accounts?.length && this.state.accounts[0] !== accounts[0]) {
        this.update({
          accounts,
        });
        // await this.setupEngine(connector);
        this.provider.emit("accountsChanged", accounts);
      }
      const connectedHexChainId = isHexStrict(connectedChainId) ? connectedChainId : `0x${connectedChainId.toString(16)}`;
      // Check if chainId changed and trigger event
      if (connectedChainId && this.state.chainId !== connectedHexChainId) {
        // Handle rpcUrl update
        this.configure({
          chainConfig: { ...this.config.chainConfig, chainId: connectedHexChainId, rpcTarget: rpcUrl },
        });
        await this.setupEngine(connector);
      }
    });
  }
}
