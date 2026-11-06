import { api } from './api.ts';

export function passkeysSupported(): boolean {
  return !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);
}

export function b64uToBuf(s: string): ArrayBuffer {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export function bufToB64u(buf: ArrayBuffer): string {
  let bin = '';
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface Options {
  challenge: string;
  rpId: string;
  timeout: number;
  userVerification: UserVerificationRequirement;
  allowCredentials: { type: 'public-key'; id: string }[];
}

/** Friendly text for what navigator.credentials.get() or the server may throw. */
export function passkeyMessage(e: unknown): string {
  if (e instanceof DOMException && e.name === 'NotAllowedError') return 'Cancelled or timed out. Please try again.';
  return e instanceof Error ? e.message : String(e);
}

async function assert(kind: 'signin' | 'second'): Promise<void> {
  const base = kind === 'signin' ? '/login/passkey/signin' : '/login/passkey';
  const o = await api.post<Options>(`${base}/options`);
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: b64uToBuf(o.challenge),
      rpId: o.rpId,
      timeout: o.timeout,
      userVerification: o.userVerification,
      allowCredentials: o.allowCredentials.map((c) => ({ type: c.type, id: b64uToBuf(c.id) })),
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('No passkey selected.');
  const r = cred.response as AuthenticatorAssertionResponse;
  await api.post(`${base}/verify`, {
    id: bufToB64u(cred.rawId),
    response: {
      clientDataJSON: bufToB64u(r.clientDataJSON),
      authenticatorData: bufToB64u(r.authenticatorData),
      signature: bufToB64u(r.signature),
      userHandle: r.userHandle ? bufToB64u(r.userHandle) : '',
    },
  });
}

/** Sign in without a password (the device offers its passkeys). */
export const passkeySignIn = () => assert('signin');
/** Second step after the password. */
export const passkeySecondFactor = () => assert('second');

interface CreationOptions {
  challenge: string;
  rp: PublicKeyCredentialRpEntity;
  timeout: number;
  attestation: AttestationConveyancePreference;
  authenticatorSelection: AuthenticatorSelectionCriteria;
  pubKeyCredParams: PublicKeyCredentialParameters[];
  user: { id: string; name: string; displayName: string };
  excludeCredentials: { type: 'public-key'; id: string }[];
}

/** Adds a passkey to the signed-in account. The password is asked again by the server (like every second-factor change). */
export async function registerPasskey(name: string, password: string): Promise<{ recovery_codes: string[] | null }> {
  const o = await api.post<CreationOptions>('/api/account/passkeys/options', { password });
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: b64uToBuf(o.challenge),
      rp: o.rp,
      timeout: o.timeout,
      attestation: o.attestation,
      authenticatorSelection: o.authenticatorSelection,
      pubKeyCredParams: o.pubKeyCredParams,
      user: { id: b64uToBuf(o.user.id), name: o.user.name, displayName: o.user.displayName },
      excludeCredentials: o.excludeCredentials.map((c) => ({ type: c.type, id: b64uToBuf(c.id) })),
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('No passkey created.');
  const r = cred.response as AuthenticatorAttestationResponse;
  return api.post<{ recovery_codes: string[] | null }>('/api/account/passkeys', {
    name,
    response: { clientDataJSON: bufToB64u(r.clientDataJSON), attestationObject: bufToB64u(r.attestationObject) },
  });
}

/** Friendly text for a failed registration (the browser's own errors are cryptic). */
export function registerMessage(e: unknown): string {
  if (e instanceof DOMException && e.name === 'InvalidStateError') return 'This device is already registered as a passkey.';
  return passkeyMessage(e);
}
