import type { InjectedAccount } from '@polkadot/extension-inject/types';
import { WalletConnectModal } from '@walletconnect/modal';
import type Client from '@walletconnect/sign-client';
import { SignClient } from '@walletconnect/sign-client';
import type { SessionTypes } from '@walletconnect/types';

import { WalletConnectSigner } from './signer.js';
import type {
  BaseWallet,
  UnsubCallback,
  WalletConnectConfiguration,
  WalletConnectModalOptions,
  WalletMetadata,
  WcAccount,
} from './types.js';

/**
 * Chain ID for Polymesh mainnet.
 */
export const POLYMESH_CHAIN_ID = 'polkadot:6fbd74e5e1d0a61d52ccfe9d4adaed16';

/**
 * Wallet Connect version.
 */
export const WC_VERSION = '2.0';

/**
 * Converts Wallet Connect account to a public key.
 * @param wcAccount - Wallet Connect account.
 * @returns public key.
 */
const wcAccountToKey = (wcAccount: WcAccount) => ({ address: wcAccount.split(':')[2] });

/**
 * Represents a Wallet Connect wallet.
 */
export class WalletConnect implements BaseWallet {
  appName: string;
  config: WalletConnectConfiguration;
  metadata: WalletMetadata;
  client: Client | undefined;
  session: SessionTypes.Struct | undefined;
  signer: WalletConnectSigner | undefined;

  /**
   * Creates an instance of WalletConnectWallet.
   * @param config - Configuration for Wallet Connect.
   * @param appName - Name of the application.
   */
  public constructor(config: WalletConnectConfiguration, appName: string) {
    if (!config.chainIds || config.chainIds.length === 0) config.chainIds = [POLYMESH_CHAIN_ID];
    this.config = config;
    this.appName = appName;
    this.metadata = {
      id: 'walletconnect',
      title: config.metadata?.name || 'WalletConnect',
      description: config.metadata?.description || '',
      urls: { main: config.metadata?.url || '' },
      iconUrl: config.metadata?.icons[0] || '',
      version: WC_VERSION,
    };
  }

  /**
   * Resets the wallet.
   */
  private reset(): void {
    this.client = undefined;
    this.session = undefined;
    this.signer = undefined;
  }

  /**
   * Connects to WalletConnect.
   * @returns Promise.
   */
  public async connect() {
    this.reset();

    this.client = await SignClient.init(this.config);

    this.client.on('session_delete', () => {
      this.session = undefined;
      this.signer = undefined;
      if (this.config.onSessionDelete) {
        this.config.onSessionDelete();
      }
    });

    const lastKeyIndex = this.client.session.getAll().length - 1;
    const lastSession = this.client.session.getAll()[lastKeyIndex];

    if (lastSession && lastSession.expiry * 1000 > Date.now()) {
      return new Promise<void>(resolve => {
        this.session = lastSession;
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        this.signer = new WalletConnectSigner(this.client!, lastSession);
        resolve();
      });
    }

    const optionalNamespaces =
      this.config.optionalChainIds && this.config.optionalChainIds.length
        ? {
            polkadot: {
              chains: this.config.optionalChainIds,
              methods: ['polkadot_signTransaction', 'polkadot_signMessage'],
              events: ['chainChanged', 'accountsChanged'],
            },
          }
        : undefined;

    const namespaces = {
      requiredNamespaces: {
        polkadot: {
          chains: this.config.chainIds,
          methods: ['polkadot_signTransaction', 'polkadot_signMessage'],
          events: ['chainChanged', 'accountsChanged'],
        },
      },
      optionalNamespaces,
    };

    const { uri, approval } = await this.client.connect(namespaces);

    let walletConnectModal: WalletConnectModal | undefined;

    return new Promise<void>((resolve, reject) => {
      if (uri) {
        if (this.config.handleConnectUri) {
          this.config.handleConnectUri(uri);
        } else {
          const defaultModalOptions: WalletConnectModalOptions = {
            enableExplorer: true,
            explorerExcludedWalletIds: 'ALL',
            explorerRecommendedWalletIds: [
              '43fd1a0aeb90df53ade012cca36692a46d265f0b99b7561e645af42d752edb92', // Nova Wallet
              '9ce87712b99b3eb57396cc8621db8900ac983c712236f48fb70ad28760be3f6a', // SubWallet
            ],
          };
          const mergedModalOptions = { ...defaultModalOptions, ...this.config.modalOptions };
          walletConnectModal = new WalletConnectModal({
            projectId: this.config.projectId,
            chains: [...(this.config.chainIds ?? []), ...(this.config.optionalChainIds ?? [])],
            ...mergedModalOptions,
          });
          walletConnectModal.openModal({ uri });
        }
      }

      approval()
        .then(session => {
          this.session = session;
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          this.signer = new WalletConnectSigner(this.client!, session);

          resolve();
        })
        .catch(error => {
          reject(error);
        })
        .finally(() => {
          walletConnectModal && walletConnectModal.closeModal();
        });
    });
  }

  /**
   * Gets accounts from the current session.
   * @returns Array of accounts.
   */
  public async getAccounts(): Promise<InjectedAccount[]> {
    let accounts: InjectedAccount[] = [];

    if (this.session) {
      const wcAccounts = Object.values(this.session.namespaces)
        .map(namespace => namespace.accounts)
        .flat();

      accounts = wcAccounts.map(wcAccount => wcAccountToKey(wcAccount as WcAccount));
    }
    return accounts;
  }

  /**
   * Subscribes to account changes.
   * @param cb - Callback function.
   * @returns Unsubscribe function.
   */
  public subscribeAccounts(cb: (accounts: InjectedAccount[]) => void): UnsubCallback {
    const handler = async () => {
      cb(await this.getAccounts());
    };

    handler();

    this.client?.on('session_delete', handler);
    this.client?.on('session_expire', handler);
    this.client?.on('session_update', handler);

    return () => {
      this.client?.off('session_update', handler);
      this.client?.off('session_expire', handler);
      this.client?.off('session_update', handler);
    };
  }

  /**
   * Disconnects from Wallet Connect.
   */
  public async disconnect() {
    if (this.session?.topic) {
      this.client?.disconnect({
        topic: this.session?.topic,
        reason: {
          code: -1,
          message: 'Disconnected by client!',
        },
      });
    }

    this.reset();
  }

  /**
   * Checks if connected to Wallet Connect.
   * @returns Boolean indicating connection status.
   */
  public isConnected() {
    return !!(this.client && this.signer && this.session);
  }
}
