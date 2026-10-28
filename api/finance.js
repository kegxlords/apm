import supabaseAdmin from '../lib/supabase.js';
import { verifyUser, getProfile } from '../lib/auth.js';
import { getSetting } from '../lib/rewards.js';
import { ensureTierActive, getTierConfig, tierExpiryFromNow } from '../lib/tiers.js';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { callMgmBridge, mgmBridgeConfigured, ngnAmount, validNgnBankCode } from '../lib/mgm-bridge.js';
import { submitMemberWithdrawalToGateway } from '../lib/mgm-operations.js';

const todayUTC = () => new Date().toISOString().slice(0, 10);

export default async function handler(req, res) {
  const action = req.query.action;
  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    switch (action) {
      case 'getDepositDetails': return await getDepositDetails(req, res);
      case 'createDeposit': return await createDeposit(req, user, res);
      case 'redeemGiftCode': return await redeemGiftCode(req, user, res);
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

async function getDepositDetails(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const keys = ['deposit_bank_name', 'deposit_account_number', 'deposit_account_name', 'min_deposit', 'deposit_mode'];
  const { data, error } = await supabaseAdmin.from('site_settings').select('key, value').in('key', keys);
  if (error) throw error;

  const settings = Object.fromEntries((data || []).map((row) => [row.key, row.value]));
  const bankName = String(settings.deposit_bank_name || '').trim();
  const accountNumber = String(settings.deposit_account_number || '').trim();
  const accountName = String(settings.deposit_account_name || '').trim();
  const configuredMinimum = Number(settings.min_deposit);
  return res.json({
    ok: true,
    bank_name: bankName,
    account_number: accountNumber,
    account_name: accountName,
    min_deposit: Number.isFinite(configuredMinimum) && configuredMinimum > 0 ? configuredMinimum : 6000,
    configured: Boolean(bankName && accountNumber && accountName),
    deposit_mode: String(settings.deposit_mode || 'manual').toLowerCase() === 'gateway' ? 'gateway' : 'manual'
  });
}

// ==========================================
// MANUAL DEPOSIT REQUEST
// ==========================================
async function createDeposit(req, user, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const profile = await getProfile(user.id);
  if (profile?.is_frozen) return res.status(403).json({ error: 'Account frozen' });

  const { amount, sender_name, payment_method, proof_ref } = req.body || {};
  const num = Math.round(Number(amount) * 100) / 100;
  const min = Number(await getSetting('min_deposit', '6000'));
  if (!Number.isFinite(num) || num <= 0 || num < min) return res.status(400).json({ error: `Minimum deposit is ₦${min.toLocaleString()}` });
  const depositMode = String(await getSetting('deposit_mode', 'manual')).toLowerCase();

  if (depositMode === 'gateway') {
    if (!mgmBridgeConfigured()) return res.status(503).json({ error: 'Online deposits are not configured yet. Please contact support.' });
    const orderId = `apm_dep_${Date.now()}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const { data: deposit, error: insertError } = await supabaseAdmin.from('deposits').insert({
      user_id: user.id,
      amount: Math.round(num * 100) / 100,
      sender_name: 'MGM Pay',
      payment_method: 'mgm_pay',
      proof_ref: null,
      status: 'pending',
      gateway_provider: 'mgm_pay',
      gateway_order_id: orderId,
      gateway_status: 'SUBMITTING'
    }).select().single();
    if (insertError) throw insertError;

    try {
      const result = await callMgmBridge('create_deposit', { order_id: orderId, amount: ngnAmount(Math.round(num * 100) / 100) });
      const providerData = result.data || {};
      let redirectUrl;
      try { redirectUrl = new URL(providerData.redirect_url); }
      catch { throw new Error('MGM Pay did not return a valid cashier URL'); }
      if (redirectUrl.protocol !== 'https:') throw new Error('MGM Pay cashier URL must use HTTPS');
      const { error: updateError } = await supabaseAdmin.from('deposits').update({
        gateway_payment_id: providerData.payment_id || null,
        gateway_redirect_url: redirectUrl.toString(),
        gateway_status: providerData.status || 'APPLY',
        gateway_status_code: Number.isInteger(Number(providerData.status_code)) ? Number(providerData.status_code) : null,
        gateway_status_detail: providerData.status_detail || null,
        gateway_payload: providerData,
        updated_at: new Date().toISOString()
      }).eq('id', deposit.id).eq('status', 'pending').eq('gateway_status', 'SUBMITTING');
      if (updateError) throw updateError;
      return res.status(201).json({ ok: true, deposit: { id: deposit.id, order_id: orderId }, redirect_url: redirectUrl.toString() });
    } catch (error) {
      await supabaseAdmin.from('deposits').update({
        gateway_status: error.definite ? 'CREATE_FAILED' : 'SUBMISSION_UNKNOWN',
        gateway_status_detail: String(error.message || 'Gateway order result unknown').slice(0, 500),
        updated_at: new Date().toISOString(),
        ...(error.definite ? { status: 'rejected' } : {})
      }).eq('id', deposit.id).eq('status', 'pending');
      if (error.definite) return res.status(502).json({ error: `Gateway declined the deposit request: ${error.message}` });
      return res.status(202).json({ ok: true, pending_confirmation: true, order_id: orderId,
        message: 'The gateway response is not confirmed yet. Do not submit another payment for this order; contact support if no cashier page appears.' });
    }
  }

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

async function redeemGiftCode(req, user, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const profile = await getProfile(user.id);
  if (profile?.is_frozen) return res.status(403).json({ error: 'Account frozen. Contact support.' });

  const normalized = String(req.body?.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^3M[0-9A-F]{16}$/.test(normalized)) {
    return res.status(400).json({ error: 'Enter a valid 3M gift code.' });
  }
  const codeHash = createHash('sha256').update(normalized, 'utf8').digest('hex');
  const { data: giftCode, error: lookupError } = await supabaseAdmin.from('gift_codes')
    .select('min_amount, max_amount, status').eq('code_hash', codeHash).maybeSingle();
  if (lookupError) throw lookupError;
  if (!giftCode || giftCode.status !== 'available') {
    return res.status(400).json({ error: 'This gift code is invalid or unavailable.' });
  }
  const minAmount = Number(giftCode.min_amount), maxAmount = Number(giftCode.max_amount);
  if (!Number.isSafeInteger(minAmount) || !Number.isSafeInteger(maxAmount) || minAmount < 1 || maxAmount < minAmount) {
    return res.status(503).json({ error: 'This gift code has an invalid amount range. Contact support.' });
  }
  const randomAmount = randomInt(minAmount, maxAmount + 1);
  const { data, error } = await supabaseAdmin.rpc('redeem_gift_code', {
    p_code_hash: codeHash,
    p_user_id: user.id,
    p_amount: randomAmount
  });
  if (error) throw error;
  if (!data?.ok) return res.status(400).json({ error: data?.error || 'This gift code is invalid or has already been redeemed.' });
  return res.json({ ok: true, amount: Number(data.amount), balance: Number(data.balance) });
}

// ==========================================
// WITHDRAWAL ELIGIBILITY (shared helper)
// ==========================================
async function checkWithdrawalEligibility(user) {
  let profile = await ensureTierActive(await getProfile(user.id));
  if (!profile) return { can_withdraw_now: false, reason_blocked: 'Profile not found' };

  const min = Number(await getSetting('min_withdrawal', '1000'));
  const fee = Number(await getSetting('withdrawal_fee_percentage', '0'));
  const payoutMode = String(await getSetting('withdrawal_mode', 'manual')).toLowerCase() === 'gateway' ? 'gateway' : 'manual';
  const reviewRequired = String(await getSetting('gateway_withdrawal_review', 'true')).toLowerCase() !== 'false';

  if (profile.is_frozen) return { can_withdraw_now: false, reason_blocked: 'Account frozen. Contact support.', min, fee, payout_mode: payoutMode, review_required: reviewRequired };
  // Weekend restriction removed to allow withdrawals everyday
  const { count: purchasedMachines, error: machineError } = await supabaseAdmin.from('wealth_investments')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id);
  if (machineError) throw machineError;
  if (!purchasedMachines) return { can_withdraw_now: false, reason_blocked: 'You need to purchase at least one Mining Machine before withdrawing.', min, fee, payout_mode: payoutMode, review_required: reviewRequired };

  const { count } = await supabaseAdmin.from('withdrawals')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .gte('created_at', `${todayUTC()}T00:00:00.000Z`);

  if (count > 0) return { can_withdraw_now: false, reason_blocked: 'You already requested a withdrawal today. Limit is 1 per day.', min, fee, payout_mode: payoutMode, review_required: reviewRequired };

  return { can_withdraw_now: true, tier: profile.tier, min, fee, payout_mode: payoutMode, review_required: reviewRequired };
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

  const { amount, bank_name, bank_code, account_number, account_name } = req.body || {};
  const num = Math.round(Number(amount) * 100) / 100;
  if (!Number.isFinite(num) || num <= 0 || num < elig.min) return res.status(400).json({ error: `Minimum withdrawal is ₦${elig.min.toLocaleString()}` });
  if (!bank_name || !account_number || !account_name) return res.status(400).json({ error: 'Bank details are required' });
  if (!/^\d{10}$/.test(account_number)) return res.status(400).json({ error: 'Account number must be 10 digits' });

  const withdrawalMode = String(await getSetting('withdrawal_mode', 'manual')).toLowerCase();
  if (withdrawalMode === 'gateway') {
    if (!mgmBridgeConfigured()) return res.status(503).json({ error: 'Online withdrawals are not configured yet. Please contact support.' });
    if (!validNgnBankCode(bank_code)) return res.status(400).json({ error: 'Select a bank supported by MGM Pay.' });
    if (!Number.isFinite(Number(elig.fee)) || Number(elig.fee) < 0 || Number(elig.fee) >= 100) return res.status(503).json({ error: 'The configured withdrawal fee is invalid for gateway payouts.' });
    const reviewRequired = String(await getSetting('gateway_withdrawal_review', 'true')).toLowerCase() !== 'false';
    const gross = Math.round(num * 100) / 100;
    const fee = Math.round(gross * elig.fee) / 100;
    const net = Math.round((gross - fee) * 100) / 100;
    if (net <= 0) return res.status(400).json({ error: 'The withdrawal fee leaves no payout amount. Contact support.' });
    const orderId = `apm_wd_${Date.now()}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const { data: withdrawalId, error: withdrawalError } = await supabaseAdmin.rpc('create_mgm_withdrawal_request', {
      p_user_id: user.id,
      p_gross_amount: gross,
      p_net_amount: net,
      p_bank_name: String(bank_name).slice(0, 80),
      p_bank_code: String(bank_code),
      p_account_number: String(account_number),
      p_account_name: String(account_name).slice(0, 100),
      p_order_id: orderId,
      p_gateway_status: reviewRequired ? 'AWAITING_REVIEW' : 'READY_TO_SEND'
    });
    if (withdrawalError) {
      const message = withdrawalError.message || 'Could not create withdrawal';
      if (message.includes('Insufficient balance')) return res.status(400).json({ error: 'Insufficient balance' });
      if (message.includes('already requested')) return res.status(400).json({ error: message });
      throw withdrawalError;
    }
    if (reviewRequired) return res.status(201).json({ ok: true, withdrawal: { id: withdrawalId, order_id: orderId },
      gateway_sent: false, requires_review: true });

    try {
      const submitted = await submitMemberWithdrawalToGateway(withdrawalId);
      return res.status(201).json({ ok: true, withdrawal: { id: withdrawalId, order_id: orderId },
        gateway_sent: true, requires_review: false, gateway_status: submitted.status });
    } catch (error) {
      if (error.definite && error.refunded) return res.status(502).json({ error: `Gateway rejected the payout; your balance has been refunded. ${error.message}` });
      return res.status(202).json({ ok: true, withdrawal: { id: withdrawalId, order_id: orderId },
        gateway_sent: false, pending_confirmation: true,
        message: 'Withdrawal is reserved while gateway submission is reconciled. Do not submit it again.' });
    }
  }

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
  let profile = await ensureTierActive(await getProfile(user.id));
  if (profile?.is_frozen) return res.status(403).json({ error: 'Account frozen' });

  const { tier } = req.body || {};
  const ORDER = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'];
  const cfg = await getTierConfig(tier);
  if (!cfg || cfg.tier === 'A0' || cfg.is_active === false) return res.status(404).json({ error: 'Tier not available' });

  const myRank = ORDER.indexOf(profile.tier);
  const targetRank = ORDER.indexOf(tier);
  if (targetRank < myRank) return res.status(400).json({ error: 'You cannot downgrade to a lower tier' });

  const isRenewal = targetRank === myRank;
  const cost = Number(cfg.upgrade_cost);
  const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', user.id).single();
  if (Number(wallet?.balance || 0) < cost) {
    return res.status(400).json({ error: `Insufficient balance. ${isRenewal ? 'Renewing' : 'Upgrading to'} ${tier} costs ₦${cost.toLocaleString()}` });
  }

  // Expiry: extend from current expiry if still active, else from now. 0 days = lifetime.
  let newExpiry = null;
  const days = Number(cfg.expiry_days || 0);
  if (days > 0) {
    const base = (isRenewal && profile.tier_expires_at && new Date(profile.tier_expires_at) > new Date())
      ? new Date(profile.tier_expires_at)
      : new Date();
    newExpiry = new Date(base.getTime() + days * 86400000).toISOString();
  }

  await supabaseAdmin.from('wallets').update({ balance: Number(wallet.balance) - cost, updated_at: new Date().toISOString() }).eq('user_id', user.id);
  await supabaseAdmin.from('profiles').update({ tier, tier_expires_at: newExpiry }).eq('id', user.id);
  await supabaseAdmin.from('transactions').insert({
    user_id: user.id, type: 'membership_upgrade', amount: cost, status: 'approved',
    reference: `${isRenewal ? 'RENEW' : 'UPGRADE'}_${user.id.slice(0, 8)}_${Date.now()}`,
    description: `${isRenewal ? 'Renewed' : 'Upgraded to'} ${tier}` + (newExpiry ? ` (until ${newExpiry.slice(0, 10)})` : ' (lifetime)')
  });

  return res.json({ ok: true, tier, renewed: isRenewal, expires_at: newExpiry });
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
