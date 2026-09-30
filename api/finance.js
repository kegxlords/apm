import supabaseAdmin from '../lib/supabase.js';
import { verifyUser, getProfile } from '../lib/auth.js';
import { getSetting } from '../lib/rewards.js';

const todayUTC = () => new Date().toISOString().slice(0, 10);

export default async function handler(req, res) {
  const action = req.query.action;
  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    switch (action) {
      case 'createDeposit': return await createDeposit(req, user, res);
      case 'getWithdrawalEligibility': return await getWithdrawalEligibility(user, res);
      case 'requestWithdrawal': return await requestWithdrawal(req, user, res);
      case 'upgradeTier': return await upgradeTier(req, user, res);
      case 'investWealth': return await investWealth(req, user, res);
      case 'claimWealthReturn': return await claimWealthReturn(req, user, res);
      default: return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    console.error('[APM-FINANCE] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ==========================================
// MANUAL DEPOSIT REQUEST
// ==========================================
async function createDeposit(req, user, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const profile = await getProfile(user.id);
  if (profile?.is_frozen) return res.status(403).json({ error: 'Account frozen' });

  const { amount, sender_name, payment_method, proof_ref } = req.body || {};
  const num = Number(amount);
  const min = Number(await getSetting('min_deposit', '1000'));
  if (!num || num < min) return res.status(400).json({ error: `Minimum deposit is ₦${min.toLocaleString()}` });
  if (!sender_name) return res.status(400).json({ error: 'Sender name is required' });

  const { data, error } = await supabaseAdmin.from('deposits').insert({
    user_id: user.id,
    amount: num,
    sender_name: String(sender_name).slice(0, 60),
    payment_method: payment_method || 'bank_transfer',
    proof_ref: proof_ref || null,
    status: 'pending'
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ ok: true, deposit: data });
}

// ==========================================
// WITHDRAWAL ELIGIBILITY (shared helper)
// ==========================================
async function checkWithdrawalEligibility(user) {
  const profile = await getProfile(user.id);
  if (!profile) return { can_withdraw_now: false, reason_blocked: 'Profile not found' };

  const min = Number(await getSetting('min_withdrawal', '1000'));
  const fee = Number(await getSetting('withdrawal_fee_percentage', '0'));

  if (profile.is_frozen) return { can_withdraw_now: false, reason_blocked: 'Account frozen. Contact support.', min, fee };
  if (profile.tier === 'A0') return { can_withdraw_now: false, reason_blocked: 'Upgrade to A1 or higher to withdraw.', min, fee };

  const { count } = await supabaseAdmin.from('withdrawals')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .gte('created_at', `${todayUTC()}T00:00:00.000Z`);

  if (count > 0) return { can_withdraw_now: false, reason_blocked: 'You already requested a withdrawal today. Limit is 1 per day.', min, fee };

  return { can_withdraw_now: true, tier: profile.tier, min, fee };
}

async function getWithdrawalEligibility(user, res) {
  return res.json(await checkWithdrawalEligibility(user));
}

// ==========================================
// WITHDRAWAL REQUEST (balance deducted now)
// ==========================================
async function requestWithdrawal(req, user, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const elig = await checkWithdrawalEligibility(user);
  if (!elig.can_withdraw_now) return res.status(400).json({ error: elig.reason_blocked });

  const { amount, bank_name, account_number, account_name } = req.body || {};
  const num = Number(amount);
  if (!num || num < elig.min) return res.status(400).json({ error: `Minimum withdrawal is ₦${elig.min.toLocaleString()}` });
  if (!bank_name || !account_number || !account_name) return res.status(400).json({ error: 'Bank details are required' });
  if (!/^\d{10}$/.test(account_number)) return res.status(400).json({ error: 'Account number must be 10 digits' });

  const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', user.id).single();
  if (Number(wallet?.balance || 0) < num) return res.status(400).json({ error: 'Insufficient balance' });

  // 1. Create withdrawal record
  const { data: wd, error: wdErr } = await supabaseAdmin.from('withdrawals').insert({
    user_id: user.id, amount: num, bank_name, account_number, account_name, status: 'pending'
  }).select().single();
  if (wdErr) return res.status(500).json({ error: wdErr.message });

  // 2. Deduct balance
  await supabaseAdmin.from('wallets').update({
    balance: Number(wallet.balance) - num,
    updated_at: new Date().toISOString()
  }).eq('user_id', user.id);

  // 3. Pending transaction
  await supabaseAdmin.from('transactions').insert({
    user_id: user.id, type: 'withdrawal', amount: num, status: 'pending',
    reference: `wd_${wd.id}`, description: `Withdrawal to ${account_name} (${bank_name})`
  });

  return res.status(201).json({ ok: true, withdrawal: wd });
}

// ==========================================
// TIER UPGRADE (A1-A7)
// ==========================================
async function upgradeTier(req, user, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const profile = await getProfile(user.id);
  if (profile?.is_frozen) return res.status(403).json({ error: 'Account frozen' });

  const { tier } = req.body || {};
  const ORDER = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'];
  const { data: tierRow } = await supabaseAdmin.from('apm_tiers').select('*').eq('tier', tier).eq('is_active', true).single();
  if (!tierRow) return res.status(404).json({ error: 'Tier not available' });
  if (ORDER.indexOf(tier) <= ORDER.indexOf(profile.tier)) return res.status(400).json({ error: 'You are already at or above this tier' });

  const cost = Number(tierRow.upgrade_cost);
  const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', user.id).single();
  if (Number(wallet?.balance || 0) < cost) return res.status(400).json({ error: `Insufficient balance. ${tier} costs ₦${cost.toLocaleString()}` });

  await supabaseAdmin.from('wallets').update({ balance: Number(wallet.balance) - cost, updated_at: new Date().toISOString() }).eq('user_id', user.id);
  await supabaseAdmin.from('profiles').update({ tier }).eq('id', user.id);
  await supabaseAdmin.from('transactions').insert({
    user_id: user.id, type: 'membership_upgrade', amount: cost, status: 'approved',
    reference: `UPGRADE_${user.id.slice(0, 8)}_${Date.now()}`, description: `Upgraded to ${tier}`
  });

  return res.json({ ok: true, tier });
}

// ==========================================
// WEALTH INVEST
// ==========================================
async function investWealth(req, user, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const profile = await getProfile(user.id);
  if (profile?.is_frozen) return res.status(403).json({ error: 'Account frozen' });

  const { package_id } = req.body || {};
  const { data: pkg } = await supabaseAdmin.from('wealth_packages').select('*').eq('id', package_id).eq('is_active', true).single();
  if (!pkg) return res.status(404).json({ error: 'Package not available' });

  const today = todayUTC();
  if (pkg.start_date && today < pkg.start_date) return res.status(400).json({ error: 'Package not open yet' });
  if (pkg.end_date && today > pkg.end_date) return res.status(400).json({ error: 'Package has closed' });

  const amount = Number(pkg.investment_amount);
  const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', user.id).single();
  if (Number(wallet?.balance || 0) < amount) return res.status(400).json({ error: 'Insufficient balance for this package' });

  const end = new Date(Date.now() + Number(pkg.duration_days) * 86400000).toISOString().slice(0, 10);

  const { data: inv, error } = await supabaseAdmin.from('wealth_investments').insert({
    user_id: user.id, package_id: pkg.id, amount, end_date: end, status: 'active'
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });

  await supabaseAdmin.from('wallets').update({ balance: Number(wallet.balance) - amount, updated_at: new Date().toISOString() }).eq('user_id', user.id);
  await supabaseAdmin.from('transactions').insert({
    user_id: user.id, type: 'wealth_invest', amount, status: 'approved',
    reference: `INVEST_${inv.id}`, description: `Wealth plan: ${pkg.name}`
  });

  return res.status(201).json({ ok: true, investment: inv });
}

// ==========================================
// DAILY WEALTH RETURN CLAIM (click-to-claim)
// ==========================================
async function claimWealthReturn(req, user, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { investment_id } = req.body || {};
  const today = todayUTC();

  const { data: inv } = await supabaseAdmin.from('wealth_investments')
    .select('*, wealth_packages(name, daily_return)')
    .eq('id', investment_id).eq('user_id', user.id).single();
  if (!inv) return res.status(404).json({ error: 'Investment not found' });
  if (inv.status !== 'active') return res.status(400).json({ error: 'This plan is no longer active' });
  if (today > inv.end_date) {
    await supabaseAdmin.from('wealth_investments').update({ status: 'completed' }).eq('id', inv.id);
    return res.status(400).json({ error: 'Plan completed. Final day passed.' });
  }
  if (inv.last_payout_date === today) return res.status(409).json({ error: 'Already collected today. Come back tomorrow!' });

  const amount = Number(inv.wealth_packages?.daily_return || 0);
  if (amount <= 0) return res.status(400).json({ error: 'Invalid plan return' });

  await supabaseAdmin.from('wealth_investments').update({ last_payout_date: today }).eq('id', inv.id);

  const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', user.id).single();
  const newBalance = Number(wallet?.balance || 0) + amount;
  await supabaseAdmin.from('wallets').upsert(
    { user_id: user.id, balance: newBalance, updated_at: new Date().toISOString() },
    { onConflict: 'user_id' }
  );

  await supabaseAdmin.from('transactions').insert({
    user_id: user.id, type: 'wealth_return', amount, status: 'approved',
    reference: `WEALTHRET_${inv.id}_${today}`, description: `Daily return: ${inv.wealth_packages?.name}`
  });

  return res.json({ ok: true, amount, new_balance: newBalance });
}
