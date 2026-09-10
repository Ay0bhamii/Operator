import { init } from "@nimiq/mini-app-sdk";
import HubApi from "@nimiq/hub-api";
import { requestNonce, verifyLogin } from "./api";

let miniProvider: any | null = null;
const HUB_URL = import.meta.env.VITE_HUB_URL || "https://hub.nimiq.com";

export function isNimiqPay(): boolean {
  return typeof window !== "undefined" && (window as any).nimiqPay != null;
}

/**
 * Connect to a Nimiq wallet in either environment:
 * - Inside Nimiq Pay: use the injected Mini App provider + listAccounts().
 * - Normal browser: use Nimiq Hub and request a wallet signature.
 *
 * No private key/seed phrase is ever exposed to the app.
 */
export async function connectNimiq(): Promise<string | null> {
  const { message } = await requestNonce();
  let signed: any;
  if (isNimiqPay()) {
    miniProvider ??= await init();
    signed = await miniProvider.sign(message);
    const accounts = await miniProvider.listAccounts();
    if (!Array.isArray(accounts) || !accounts[0]) throw new Error("No Nimiq account returned");
    signed.signer = accounts[0];
  } else {
    const hub = new HubApi(HUB_URL);
    signed = await hub.signMessage({ appName: "OPERATOR", message });
  }
  const toHex = (value: string | Uint8Array) => {
    if (typeof value !== "string") return Array.from(value).map(byte => byte.toString(16).padStart(2, "0")).join("");
    const normalized = value.replace(/^0x/, "").replace(/\s/g, "");
    if (/^[0-9a-f]+$/i.test(normalized) && normalized.length % 2 === 0) return normalized;
    const binary = atob(value);
    return Array.from(binary, character => character.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  };
  const signer = typeof signed?.signer === "string" ? signed.signer.trim() : "";
  if (!signer || !signed?.publicKey && !signed?.signerPublicKey || !signed?.signature) throw new Error("Wallet did not return a complete signed login");
  return (await verifyLogin({ message, signer, signerPublicKey: toHex(signed.signerPublicKey || signed.publicKey), signature: toHex(signed.signature) })).address;
}

