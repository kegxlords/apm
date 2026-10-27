export function mgmBridgeConfigured() {
  try {
    return new URL(process.env.MGM_BRIDGE_URL || '').protocol === 'https:';
  } catch { return false; }
}

export async function callMgmBridge(action, payload = {}) {
  const url = process.env.MGM_BRIDGE_URL;
  if (!url) {
    const error = new Error('MGM bridge is not configured. Set MGM_BRIDGE_URL on the app server.');
    error.definite = true;
    throw error;
  }
  let bridgeUrl;
  try { bridgeUrl = new URL(url); } catch { bridgeUrl = null; }
  if (!bridgeUrl || bridgeUrl.protocol !== 'https:') {
    const error = new Error('MGM bridge URL must use HTTPS.');
    error.definite = true;
    throw error;
  }

  const body = JSON.stringify({ action, payload });

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
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
  let result;
  try { result = JSON.parse(responseText); }
  catch {
    const contentType = response.headers.get('content-type') || 'unknown content type';
    const redirectNote = response.redirected ? ', redirected' : '';
    const error = new Error(`MGM bridge returned non-JSON (HTTP ${response.status}, ${contentType}${redirectNote}). Check MGM_BRIDGE_URL and the PHP/web-server error log.`);
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
