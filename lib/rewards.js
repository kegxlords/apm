import supabaseAdmin from './supabase.js';

// Read a site setting with fallback
export async function getSetting(key, fallback = null) {
  const { data } = await supabaseAdmin
    .from('site_settings')
    .select('value')
    .eq('key', key)
    .single();
  return data?.value ?? fallback;
}

// Admin-configurable referral percentage
export async function getReferralPercentage() {
  const raw = await getSetting('referral_commission_percentage', '10');
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 10;
}

export function calcCommission(amount, percentage) {
  return Math.round(Number(amount) * (percentage / 100) * 100) / 100;
}

/**
 * Pay referral commission for an approved deposit.
 * Idempotent: the unique deposit_id constraint on referral_commissions
 * acts as the lock — insert FIRST, credit ONLY if insert succeeds.
 */
export async function payReferralCommission(deposit) {
  const { data: prof } = await supabaseAdmin
    .from('profiles')
    .select('referred_by')
    .eq('id', deposit.user_id)
    .single();

  const referrerId = prof?.referred_by;
  if (!referrerId || referrerId === deposit.user_id) {
    return { paid: false, amount: 0, referrerId: null };
  }

  const percentage = await getReferralPercentage();
  const amount = calcCommission(deposit.amount, percentage);
  if (amount <= 0) return { paid: false, amount: 0, referrerId };

  // 1. Insert commission first (duplicate-safe guard)
  const { error: commError } = await supabaseAdmin.from('referral_commissions').insert({
    referrer_id: referrerId,
    referred_user_id: deposit.user_id,
    deposit_id: deposit.id,
    commission_amount: amount,
    commission_percentage: percentage,
    status: 'paid'
  });

  if (commError) {
    if (commError.code === '23505') {
      return { paid: false, amount: 0, referrerId, duplicate: true };
    }
    throw commError;
  }

  // 2. Credit referrer wallet
  const { data: wallet } = await supabaseAdmin
    .from('wallets')
    .select('balance')
    .eq('user_id', referrerId)
    .single();

  const newBalance = Number(wallet?.balance || 0) + amount;
  await supabaseAdmin.from('wallets').upsert(
    { user_id: referrerId, balance: newBalance, updated_at: new Date().toISOString() },
    { onConflict: 'user_id' }
  );

  // 3. Transaction record for referrer
  await supabaseAdmin.from('transactions').insert({
    user_id: referrerId,
    type: 'referral_commission',
    amount,
    status: 'approved',
    reference: `REFCOMM_${deposit.id}`,
    description: `Referral commission (${percentage}%) on deposit`
  });

  return { paid: true, amount, referrerId, percentage };
}
