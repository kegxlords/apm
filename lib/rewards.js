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

const REFERRAL_LEVELS = [
  { level: 1, setting: 'referral_commission_percentage', fallback: 10 },
  { level: 2, setting: 'referral_level_2_percentage', fallback: 2 },
  { level: 3, setting: 'referral_level_3_percentage', fallback: 1 }
];

async function getReferralPercentage(setting, fallback) {
  const raw = await getSetting(setting, String(fallback));
  const percentage = Number(raw);
  return Number.isFinite(percentage) && percentage >= 0 ? percentage : fallback;
}

export function calcCommission(amount, percentage) {
  return Math.round(Number(amount) * (percentage / 100) * 100) / 100;
}

/**
 * Pay configurable referral commissions for an approved deposit, up to three
 * ancestors. A unique (deposit_id, commission_level) index makes each level
 * independently idempotent.
 */
export async function payReferralCommission(deposit) {
  const seenReferrers = new Set([deposit.user_id]);
  const payouts = [];
  let currentUserId = deposit.user_id;
  let totalAmount = 0;

  for (const { level, setting, fallback } of REFERRAL_LEVELS) {
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('referred_by')
      .eq('id', currentUserId)
      .single();
    if (profileError && profileError.code !== 'PGRST116') throw profileError;

    const referrerId = profile?.referred_by;
    if (!referrerId || seenReferrers.has(referrerId)) break;
    seenReferrers.add(referrerId);
    currentUserId = referrerId;

    const percentage = await getReferralPercentage(setting, fallback);
    const amount = calcCommission(deposit.amount, percentage);
    if (amount <= 0) continue;

    // Insert before crediting so a retried deposit approval cannot pay twice.
    const { error: commissionError } = await supabaseAdmin.from('referral_commissions').insert({
      referrer_id: referrerId,
      referred_user_id: deposit.user_id,
      deposit_id: deposit.id,
      commission_level: level,
      commission_amount: amount,
      commission_percentage: percentage,
      status: 'paid'
    });

    if (commissionError) {
      if (commissionError.code === '23505') continue;
      throw commissionError;
    }

    const { data: wallet, error: walletError } = await supabaseAdmin
      .from('wallets')
      .select('balance')
      .eq('user_id', referrerId)
      .single();
    if (walletError && walletError.code !== 'PGRST116') throw walletError;

    const newBalance = Number(wallet?.balance || 0) + amount;
    const { error: walletUpdateError } = await supabaseAdmin.from('wallets').upsert(
      { user_id: referrerId, balance: newBalance, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );
    if (walletUpdateError) throw walletUpdateError;

    const { error: transactionError } = await supabaseAdmin.from('transactions').insert({
      user_id: referrerId,
      type: 'referral_commission',
      amount,
      status: 'approved',
      reference: `REFCOMM_${deposit.id}_L${level}`,
      description: `Level ${level} referral commission (${percentage}%) on deposit`
    });
    if (transactionError) throw transactionError;

    payouts.push({ level, amount, referrerId, percentage });
    totalAmount += amount;
  }

  return {
    paid: payouts.length > 0,
    amount: totalAmount,
    referrerId: payouts[0]?.referrerId || null,
    payouts
  };
}
