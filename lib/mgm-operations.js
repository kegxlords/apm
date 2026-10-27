import supabaseAdmin from './supabase.js';
import { callMgmBridge, ngnAmount } from './mgm-bridge.js';

export async function submitMemberWithdrawalToGateway(withdrawalId) {
  const { data: withdrawal, error: loadError } = await supabaseAdmin.from('withdrawals')
    .select('*').eq('id', withdrawalId).single();
  if (loadError) throw loadError;
  if (!withdrawal || withdrawal.gateway_provider !== 'mgm_pay') throw new Error('Gateway withdrawal not found');
  if (withdrawal.status !== 'pending') throw new Error('Withdrawal is no longer pending');
  if (!['AWAITING_REVIEW', 'READY_TO_SEND'].includes(String(withdrawal.gateway_status || ''))) {
    throw new Error(`Withdrawal cannot be sent in its current gateway state (${withdrawal.gateway_status || 'unknown'}).`);
  }

  const { data: claimed, error: claimError } = await supabaseAdmin.from('withdrawals')
    .update({ gateway_status: 'SUBMITTING', gateway_status_detail: null, updated_at: new Date().toISOString() })
    .eq('id', withdrawalId).eq('status', 'pending')
    .in('gateway_status', ['AWAITING_REVIEW', 'READY_TO_SEND'])
    .select('id').maybeSingle();
  if (claimError) throw claimError;
  if (!claimed) throw new Error('Withdrawal is already being submitted or has already been sent.');

  try {
    const result = await callMgmBridge('create_withdrawal', {
      order_id: withdrawal.gateway_order_id,
      amount: ngnAmount(withdrawal.net_amount ?? withdrawal.amount),
      payee: {
        name: withdrawal.account_name,
        account: String(withdrawal.account_number),
        account_type: 'BANK',
        bank_code: String(withdrawal.bank_code)
      }
    });
    const providerData = result.data || {};
    const { error: saveError } = await supabaseAdmin.from('withdrawals').update({
      gateway_settlement_id: providerData.settlement_id || null,
      gateway_status: providerData.status || 'SUBMITTED',
      gateway_status_code: Number.isInteger(Number(providerData.status_code)) ? Number(providerData.status_code) : null,
      gateway_status_detail: providerData.status_detail || null,
      gateway_payload: providerData,
      updated_at: new Date().toISOString()
    }).eq('id', withdrawalId).eq('status', 'pending').eq('gateway_status', 'SUBMITTING');
    if (saveError) throw saveError;
    return { submitted: true, status: providerData.status || 'SUBMITTED', settlement_id: providerData.settlement_id || null };
  } catch (error) {
    if (error.definite) {
      const detail = String(error.message || 'MGM Pay rejected the payout request').slice(0, 500);
      const { data: refundResult, error: refundError } = await supabaseAdmin.rpc('apply_mgm_withdrawal_callback', {
        p_order_id: withdrawal.gateway_order_id,
        p_settlement_id: null,
        p_amount: Number(withdrawal.net_amount ?? withdrawal.amount),
        p_currency: 'NGN',
        p_status: 'SUBMISSION_FAILED',
        p_status_code: 4,
        p_status_detail: detail,
        p_payload: { source: 'bridge_rejection', detail }
      });
      if (refundError) throw refundError;
      error.refunded = refundResult?.ok === true && refundResult?.status === 'rejected';
      if (!error.refunded && refundResult?.status === 'approved') error.ambiguous = true;
    } else {
      await supabaseAdmin.from('withdrawals').update({
        gateway_status: 'SUBMISSION_UNKNOWN',
        gateway_status_detail: String(error.message || 'Submission outcome is unknown').slice(0, 500),
        updated_at: new Date().toISOString()
      }).eq('id', withdrawalId).eq('status', 'pending');
      error.ambiguous = true;
    }
    throw error;
  }
}
