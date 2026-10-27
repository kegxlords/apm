import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const constantTimeEqual = (left, right) => {
  const a = Buffer.from(String(left || ''), 'hex');
  const b = Buffer.from(String(right || ''), 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
};

export function mgmBridgeConfigured() {
  try {
    return new URL(process.env.MGM_BRIDGE_URL || '').protocol === 'https:'
      && String(process.env.MGM_BRIDGE_SECRET || '').trim().length >= 32;
  } catch { return false; }
}

export async function callMgmBridge(action, payload = {}) {
  const url = process.env.MGM_BRIDGE_URL;
  const secret = String(process.env.MGM_BRIDGE_SECRET || '').trim();
  if (!url || !secret) {
    const error = new Error('MGM bridge is not configured. Set MGM_BRIDGE_URL and MGM_BRIDGE_SECRET on the app server.');
    error.definite = true;
    throw error;
  }
  let bridgeUrl;
  try { bridgeUrl = new URL(url); } catch { bridgeUrl = null; }
  if (!bridgeUrl || bridgeUrl.protocol !== 'https:' || secret.length < 32) {
    const error = new Error('MGM bridge URL must use HTTPS and MGM_BRIDGE_SECRET must be at least 32 characters.');
    error.definite = true;
    throw error;
  }

  const body = JSON.stringify({ action, payload });
  const timestamp = String(Date.now());
  const nonce = randomBytes(4).toString('hex').toUpperCase();
  const requestSignature = createHmac('sha256', secret)
    .update(`${timestamp}\n${nonce}\n${sha256(body)}`, 'utf8')
    .digest('hex');

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-APM-Timestamp': timestamp,
        'X-APM-Nonce': nonce,
        'X-APM-Signature': requestSignature
      },
      body,
      signal: AbortSignal.timeout(25000)
    });
  } catch (cause) {
    const error = new Error(`Could not reach MGM bridge: ${cause.message}`);
    error.ambiguous = true;
    throw error;
  }

  const responseText = await response.text();
  const responseTimestamp = response.headers.get('x-apm-timestamp') || '';
  const responseSignature = response.headers.get('x-apm-response-signature') || '';
  const expected = createHmac('sha256', secret)
    .update(`${responseTimestamp}\n${sha256(responseText)}`, 'utf8')
    .digest('hex');
  if (!constantTimeEqual(expected, responseSignature)) {
    const error = new Error('MGM bridge response signature is invalid.');
    error.ambiguous = true;
    throw error;
  }

  let result;
  try { result = JSON.parse(responseText); }
  catch {
    const error = new Error('MGM bridge returned an invalid response.');
    error.ambiguous = true;
    throw error;
  }
  if (!response.ok || !result.ok) {
    const error = new Error(result.error || `MGM bridge request failed (HTTP ${response.status})`);
    error.definite = result.definite === true;
    error.ambiguous = !error.definite;
    error.provider = result.provider || null;
    throw error;
  }
  return result;
}

export const ngnAmount = (amount) => Number(amount).toFixed(2);

export const MGM_NG_BANKS = Object.freeze({
  'Opay': '20009',
  'ASO Savings and Loans': '20012',
  'Access Bank': '20013',
  'Ecobank Nigeria': '20026',
  'Fidelity Bank': '20036',
  'First Bank of Nigeria': '20039',
  'First City Monument Bank': '20040',
  'Globus Bank': '20043',
  'Guaranty Trust Bank': '20045',
  'Heritage Bank': '20047',
  'Jaiz Bank': '20051',
  'Keystone Bank': '20053',
  'Kuda Bank': '20055',
  'One Finance': '20063',
  'PalmPay': '20065',
  'Parkway - ReadyCash': '20066',
  'Polaris Bank': '20068',
  'Providus Bank': '20069',
  'Stanbic IBTC Bank': '20073',
  'Standard Chartered Bank': '20074',
  'Sterling Bank': '20075',
  'TAJ Bank': '20076',
  'Titan Bank': '20079',
  'Union Bank of Nigeria': '20080',
  'United Bank For Africa': '20081',
  'Unity Bank': '20082',
  'VFD Microfinance Bank': '20083',
  'Zenith Bank': '20086',
  'Moniepoint Microfinance Bank': '20087'
});

export const validNgnBankCode = (code) => Object.values(MGM_NG_BANKS).includes(String(code));
