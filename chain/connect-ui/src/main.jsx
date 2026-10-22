// Most miedzy zwykla strona gry a DogeOS Connect Kit (React): okno logowania (X / e-mail / portfel),
// stan polaczenia, podpis wiadomosci i dostawca EIP-1193 do transakcji. Strona korzysta z window.WolWallet.
import { Buffer } from 'buffer';
import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { WalletConnectProvider, ChainTypeEnum, useAccount, useWalletConnect } from '@dogeos/dogeos-sdk';
import '@dogeos/dogeos-sdk/style.css';

if (!globalThis.Buffer) globalThis.Buffer = Buffer;
if (!globalThis.process) globalThis.process = { env: {} };

const dogeOSChikyuTestnet = {
  id: 6281971,
  name: 'DogeOS Chikyū Testnet',
  nativeCurrency: { name: 'DOGE', symbol: 'DOGE', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.dogeos.com/'] } },
  blockExplorers: { default: { name: 'DogeOS L2Scan', url: 'https://dogeos-testnet.l2scan.co' } },
  testnet: true
};

let markReady; const readyPromise = new Promise((r) => { markReady = r; });
const listeners = new Set();
let snapshot = { isConnected: false, isConnecting: false, address: null, chainId: null, chainType: null, error: '' };
let api = { openModal: () => {}, closeModal: () => {}, disconnect: async () => {}, signMessage: null, provider: null, switchChain: null };

function publish(next) {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((fn) => { try { fn(snapshot); } catch (e) { console.error(e); } });
}

function Bridge() {
  const wc = useWalletConnect();
  const acc = useAccount();
  useEffect(() => {
    markReady();
    api = { openModal: wc.openModal, closeModal: wc.closeModal, disconnect: wc.disconnect, signMessage: acc.signMessage, provider: acc.currentProvider, switchChain: acc.switchChain };
    publish({
      isConnected: !!wc.isConnected && !!acc.address,
      isConnecting: !!wc.isConnecting,
      address: acc.address || null,
      chainId: acc.chainId || null,
      chainType: acc.chainType || null,
      error: wc.error || ''
    });
  });
  return null;
}

let mounted = false;
function init(cfg) {
  if (mounted) return;
  mounted = true;
  const host = document.createElement('div');
  host.id = 'wol-wallet-root';
  document.body.appendChild(host);
  const config = {
    clientId: cfg.clientId,
    defaultConnectChain: ChainTypeEnum.EVM,
    chains: { evm: [dogeOSChikyuTestnet] },
    theme: { defaultTheme: 'dark' },
    metadata: { name: 'War of Lords', description: 'War of Lords on DogeOS testnet', url: location.origin, icons: [] }
  };
  createRoot(host).render(
    <WalletConnectProvider config={config}>
      <Bridge />
    </WalletConnectProvider>
  );
}

const toHex = (sig) => (typeof sig === 'string' ? sig : '0x' + Array.from(sig).map((b) => b.toString(16).padStart(2, '0')).join(''));

window.WolWallet = {
  init,
  open: async () => { await readyPromise; api.openModal(); },
  close: () => api.closeModal(),
  disconnect: () => api.disconnect(),
  state: () => snapshot,
  subscribe(fn) { listeners.add(fn); fn(snapshot); return () => listeners.delete(fn); },
  provider: () => api.provider,
  async signMessage(message) {
    if (!api.signMessage) throw new Error('Wallet is not ready to sign yet.');
    return toHex(await api.signMessage({ message }));
  },
  async switchToDogeOS() {
    if (!api.switchChain) throw new Error('Wallet is not ready yet.');
    return api.switchChain({ chainType: ChainTypeEnum.EVM, chainInfo: dogeOSChikyuTestnet });
  }
};
window.dispatchEvent(new Event('wolwallet:loaded'));
