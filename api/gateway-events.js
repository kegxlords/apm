import { createHmac, timingSafeEqual } from 'node:crypto';
import supabaseAdmin from '../lib/supabase.js';
import { payReferralCommission } from '../lib/rewards.js';

const hmac = (message, secret) => createHmac('sha256', secret).update(message, 'utf8').digest('hex');
const equalHex = (left, right) => {
  const a = Buffer.from(String(left || ''), 'hex');
  const b = Buffer.from(String(right || ''), 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
};
const value = (v) => v === null || v === undefined ? '' : String(v);

function callbackMessage(timestamp, nonce, hook, data) {
  return [
    timestamp, nonce, hook, data.order_id, data.payment_id, data.settlement_id,
    data.amount, data.currency, data.country, data.status_code, data.status,
    data.status_detail
  ].map(value).join('\n');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');
  const secret = process.env.MGM_BRIDGE_SECRET;
  if (!secret) return res.status(503).send('Gateway callback is not configured');

  try {
    const timestamp = String(req.headers['x-apm-timestamp'] || '');
    const nonce = String(req.headers['x-apm-nonce'] || '');
    const signature = String(req.headers['x-apm-signature'] || '');
    const timestampMs = Number(timestamp);
    if (!/^\d{13}$/.test(timestamp) || !/^[A-Za-z0-9]{6,16}$/.test(nonce)
      || !Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 300000) {
      return res.status(401).send('Invalid bridge timestamp or nonce');
    }

    const hook = String(req.body?.hook || '');
    const data = req.body?.data;
    if (!['deposit', 'withdrawal'].includes(hook) || !data || typeof data !== 'object') {
      return res.status(400).send('Invalid gateway callback');
    }
    const expected = hmac(callbackMessage(timestamp, nonce, hook, data), secret);
    if (!equalHex(expected, signature)) return res.status(401).send('Invalid bridge signature');

    const orderId = String(data.order_id || '').trim();
    const amount = Number(data.amount);
    const statusCode = Number(data.status_code);
    if (!orderId || !Number.isFinite(amount) || amount <= 0 || !Number.isInteger(statusCode)) {
      return res.status(400).send('Missing callback order fields');
    }
    if (hook === 'withdrawal' && data.country && data.country !== 'NG') {
      return res.status(400).send('Unexpected payout country');
    }

    if (hook === 'deposit') {
      const { data: result, error } = await supabaseAdmin.rpc('apply_mgm_deposit_callback', {
        p_order_id: orderId,
        p_payment_id: data.payment_id ? String(data.payment_id) : null,
        p_amount: amount,
        p_currency: String(data.currency || ''),
        p_status: data.status ? String(data.status) : null,
        p_status_code: statusCode,
        p_status_detail: data.status_detail ? String(data.status_detail) : null,
        p_payload: data
      });
      if (error) throw error;
      if (!result?.ok) return res.status(409).send(result?.error || 'Deposit callback could not be applied');

      // Safe on repeated callbacks: each level uses a unique deposit/level key
      // and an atomic DB RPC for the commission record and wallet credit.
      if (statusCode === 100) {
        const { data: deposit, error: depositError } = await supabaseAdmin.from('deposits')
          .select('id,user_id,amount,status').eq('id', result.deposit_id).single();
        if (depositError) throw depositError;
        if (deposit.status === 'completed') await payReferralCommission(deposit);
      }
    } else {
      const { data: result, error } = await supabaseAdmin.rpc('apply_mgm_withdrawal_callback', {
        p_order_id: orderId,
        p_settlement_id: data.settlement_id ? String(data.settlement_id) : null,
        p_amount: amount,
        p_currency: String(data.currency || ''),
        p_status: data.status ? String(data.status) : null,
        p_status_code: statusCode,
        p_status_detail: data.status_detail ? String(data.status_detail) : null,
        p_payload: data
      });
      if (error) throw error;
      if (!result?.ok) return res.status(409).send(result?.error || 'Withdrawal callback could not be applied');
    }

    return res.status(200).send('SUCCESS');
  } catch (error) {
    console.error('[MGM-CALLBACK] Processing failed:', error);
    return res.status(500).send('Callback processing failed');
  }
}
