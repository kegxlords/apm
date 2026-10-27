import supabaseAdmin from '../lib/supabase.js';
import { payReferralCommission } from '../lib/rewards.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  try {
    const hook = String(req.body?.hook || '');
    const data = req.body?.data;
    if (!['deposit', 'withdrawal'].includes(hook) || !data || typeof data !== 'object') {
      return res.status(400).send('Invalid gateway callback');
    }

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
