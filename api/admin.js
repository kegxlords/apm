import supabaseAdmin from '../lib/supabase.js';
import { verifyUser, isAdmin } from '../lib/auth.js';
import { payReferralCommission, getSetting } from '../lib/rewards.js';
import { getTierConfig, tierExpiryFromNow } from '../lib/tiers.js';
import { randomUUID } from 'node:crypto';
import { callMgmBridge, mgmBridgeConfigured, ngnAmount, validNgnBankCode, MGM_NG_BANKS } from '../lib/mgm-bridge.js';
import { submitMemberWithdrawalToGateway } from '../lib/mgm-operations.js';

const todayUTC = () => new Date().toISOString().slice(0, 10);

export default async function handler(req, res) {
  const action = req.query.action;
  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (!(await isAdmin(user.id))) return res.status(403).json({ error: 'Admin access required' });

    switch (action) {
      case 'get-dashboard-stats': return await getDashboardStats(res);
      case 'get-deposits': return await getDeposits(req, res);
      case 'process-deposit': return await processDeposit(req, res);
      case 'get-withdrawals': return await getWithdrawals(req, res);
      case 'process-withdrawal': return await processWithdrawal(req, res);
      case 'get-users': return await getUsers(req, res);
      case 'update-user': return await updateUser(req, res);
      case 'adjust-balance': return await adjustBalance(req, res);
      case 'get-tasks': return await getTasks(res);
      case 'save-task': return await saveTask(req, res);
      case 'delete-task': return await deleteTask(req, res);
      case 'get-tiers': return await getTiers(res);
      case 'update-tier': return await updateTier(req, res);
      case 'get-wealth-packages': return await getWealthPackages(res);
      case 'save-wealth-package': return await saveWealthPackage(req, res);
      case 'delete-wealth-package': return await deleteWealthPackage(req, res);
      case 'get-investments': return await getInvestments(res);
      case 'send-message': return await sendMessage(req, res);
      case 'get-settings': return await getSettings(res);
      case 'save-settings': return await saveSettings(req, res);
      case 'get-gateway-overview': return await getGatewayOverview(res);
      case 'create-gateway-admin-payout': return await createGatewayAdminPayout(req, user, res);
      case 'reconcile-gateway-admin-payout': return await reconcileGatewayAdminPayout(req, res);
      default: return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    console.error('[APM-ADMIN] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ============ DASHBOARD ============
async function getDashboardStats(res) {
  const today = todayUTC();
  const [users, depComp, depPend, wdApp, wdPend, claimsToday, comm] = await Promise.all([
    supabaseAdmin.from('profiles').select('*', { count: 'exact', head: true }),
    supabaseAdmin.from('deposits').select('amount').eq('status', 'completed'),
    supabaseAdmin.from('deposits').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    supabaseAdmin.from('withdrawals').select('amount').eq('status', 'approved'),
    supabaseAdmin.from('withdrawals').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    supabaseAdmin.from('task_claims').select('id', { count: 'exact', head: true }).eq('claim_date', today),
    supabaseAdmin.from('referral_commissions').select('commission_amount').eq('status', 'paid')
  ]);
  const sum = (rows, k) => (rows || []).reduce((s, r) => s + Number(r[k] || 0), 0);
  return res.json({
    users: users.count || 0,
    totalDeposits: sum(depComp.data, 'amount'),
    pendingDeposits: depPend.count || 0,
    totalWithdrawals: sum(wdApp.data, 'amount'),
    pendingWithdrawals: wdPend.count || 0,
    tasksToday: claimsToday.count || 0,
    totalCommissions: sum(comm.data, 'commission_amount')
  });
}

// ============ DEPOSITS ============
async function getDeposits(req, res) {
  const status = req.query.status || 'pending';
  let q = supabaseAdmin.from('deposits').select('*, profiles!user_id(full_name, email)').order('created_at', { ascending: false }).limit(100);
  if (status !== 'all') q = q.eq('status', status);
  const { data } = await q;
  return res.json({ deposits: data || [] });
}

async function processDeposit(req, res) {
  const { deposit_id, act, note } = req.body;
  const { data: d } = await supabaseAdmin.from('deposits').select('*').eq('id', deposit_id).single();
  if (!d) return res.status(404).json({ error: 'Deposit not found' });
  if (act === 'reconcile') {
    if (d.gateway_provider !== 'mgm_pay' || !d.gateway_order_id) return res.status(400).json({ error: 'This is not an MGM Pay deposit.' });
    const applied = await reconcileDepositOrder(d.gateway_order_id);
    return res.json({ ok: true, status_code: applied.status_code, status: applied.status });
  }
  if (d.status !== 'pending') return res.status(400).json({ error: 'Already processed' });
  if (d.gateway_provider === 'mgm_pay' && act === 'reject') {
    return res.status(409).json({ error: 'Do not manually cancel an MGM Pay order while its status is pending or uncertain. Reconcile it using its original order ID.' });
  }
  if (d.gateway_provider === 'mgm_pay' && act === 'approve') {
    return res.status(400).json({ error: 'Gateway deposits are credited only after MGM Pay confirms success. Use Reconcile to check its status.' });
  }

  if (act === 'reject') {
    await supabaseAdmin.from('deposits').update({ status: 'rejected', note: note || 'Rejected by admin', updated_at: new Date().toISOString() }).eq('id', d.id);
    return res.json({ ok: true, action: 'rejected' });
  }

  if (act === 'approve') {
    // 1. Credit wallet
    const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', d.user_id).single();
    const newBalance = Number(wallet?.balance || 0) + Number(d.amount);
    await supabaseAdmin.from('wallets').upsert(
      { user_id: d.user_id, balance: newBalance, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );
    // 2. Transaction
    await supabaseAdmin.from('transactions').insert({
      user_id: d.user_id, type: 'deposit', amount: Number(d.amount), status: 'approved',
      reference: `DEPOSIT_${d.id}`, description: `Deposit approved (${d.sender_name || 'manual'})`
    });
    // 3. Referral commission (admin-configurable %)
    const comm = await payReferralCommission(d);
    // 4. Complete
    await supabaseAdmin.from('deposits').update({ status: 'completed', paid_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', d.id);
    return res.json({ ok: true, action: 'approved', credited: Number(d.amount), commission: comm });
  }
  return res.status(400).json({ error: 'Invalid action' });
}

// ============ WITHDRAWALS ============
async function getWithdrawals(req, res) {
  const status = req.query.status || 'pending';
  let q = supabaseAdmin.from('withdrawals').select('*, profiles!user_id(full_name, email)').order('created_at', { ascending: false }).limit(100);
  if (status !== 'all') q = q.eq('status', status);
  const { data } = await q;
  return res.json({ withdrawals: data || [] });
}

async function processWithdrawal(req, res) {
  const { withdrawal_id, act, note } = req.body;
  const { data: w } = await supabaseAdmin.from('withdrawals').select('*').eq('id', withdrawal_id).single();
  if (!w) return res.status(404).json({ error: 'Withdrawal not found' });
  if (act === 'reconcile') {
    if (w.gateway_provider !== 'mgm_pay' || !w.gateway_order_id) return res.status(400).json({ error: 'This is not an MGM Pay withdrawal.' });
    const applied = await reconcileWithdrawalOrder(w.gateway_order_id);
    return res.json({ ok: true, status_code: applied.status_code, status: applied.status });
  }
  if (w.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

  if (act === 'reject') {
    if (w.gateway_provider === 'mgm_pay') {
      const { data: rejected, error } = await supabaseAdmin.rpc('reject_mgm_withdrawal_request', {
        p_withdrawal_id: w.id,
        p_note: note || 'Rejected by admin'
      });
      if (error) throw error;
      if (!rejected) return res.status(409).json({ error: 'This payout was already handled or sent to MGM Pay. Reconcile with MGM Pay before taking further action.' });
      return res.json({ ok: true, action: 'rejected_refunded' });
    }
    const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', w.user_id).single();
    await supabaseAdmin.from('wallets').update({ balance: Number(wallet?.balance || 0) + Number(w.amount), updated_at: new Date().toISOString() }).eq('user_id', w.user_id);
    await supabaseAdmin.from('withdrawals').update({ status: 'rejected', note: note || 'Rejected by admin', processed_at: new Date().toISOString() }).eq('id', w.id);
    await supabaseAdmin.from('transactions').update({ status: 'rejected' }).eq('reference', `wd_${w.id}`);
    return res.json({ ok: true, action: 'rejected' });
  }

  if (act === 'approve') {
    if (w.gateway_provider === 'mgm_pay') {
      const result = await submitMemberWithdrawalToGateway(w.id);
      return res.json({ ok: true, action: 'submitted', gateway_status: result.status, settlement_id: result.settlement_id });
    }
    await supabaseAdmin.from('withdrawals').update({ status: 'approved', note: note || 'Approved — pay manually', processed_at: new Date().toISOString() }).eq('id', w.id);
    await supabaseAdmin.from('transactions').update({ status: 'approved' }).eq('reference', `wd_${w.id}`);
    return res.json({ ok: true, action: 'approved' });
  }
  return res.status(400).json({ error: 'Invalid action' });
}

async function reconcileDepositOrder(orderId) {
  const result = await callMgmBridge('query_deposit', { order_id: orderId });
  const d = result.data || {};
  if (String(d.order_id || '') !== String(orderId)) throw new Error('MGM Pay returned a different deposit order ID.');
  const { data: applied, error } = await supabaseAdmin.rpc('apply_mgm_deposit_callback', {
    p_order_id: orderId,
    p_payment_id: d.payment_id ? String(d.payment_id) : null,
    p_amount: Number(d.amount),
    p_currency: String(d.currency || 'NGN'),
    p_status: d.status ? String(d.status) : null,
    p_status_code: Number(d.status_code),
    p_status_detail: d.status_detail ? String(d.status_detail) : null,
    p_payload: d
  });
  if (error) throw error;
  if (!applied?.ok) throw new Error(applied?.error || 'Could not apply provider deposit status.');
  if (Number(d.status_code) === 100) {
    const { data: deposit, error: depositError } = await supabaseAdmin.from('deposits')
      .select('id,user_id,amount,status').eq('id', applied.deposit_id).single();
    if (depositError) throw depositError;
    if (deposit.status === 'completed') await payReferralCommission(deposit);
  }
  return d;
}

async function reconcileWithdrawalOrder(orderId) {
  const result = await callMgmBridge('query_withdrawal', { order_id: orderId });
  const d = result.data || {};
  if (String(d.order_id || '') !== String(orderId)) throw new Error('MGM Pay returned a different payout order ID.');
  const { data: applied, error } = await supabaseAdmin.rpc('apply_mgm_withdrawal_callback', {
    p_order_id: orderId,
    p_settlement_id: d.settlement_id ? String(d.settlement_id) : null,
    p_amount: Number(d.amount),
    p_currency: String(d.currency || 'NGN'),
    p_status: d.status ? String(d.status) : null,
    p_status_code: Number(d.status_code),
    p_status_detail: d.status_detail ? String(d.status_detail) : null,
    p_payload: d
  });
  if (error) throw error;
  if (!applied?.ok) throw new Error(applied?.error || 'Could not apply provider payout status.');
  return d;
}

async function reconcileGatewayAdminPayout(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const orderId = String(req.body?.order_id || '').trim();
  if (!orderId) return res.status(400).json({ error: 'Order ID is required.' });
  const result = await callMgmBridge('query_withdrawal', { order_id: orderId });
  const d = result.data || {};
  if (String(d.order_id || '') !== orderId) throw new Error('MGM Pay returned a different payout order ID.');
  const { data: applied, error } = await supabaseAdmin.rpc('apply_mgm_withdrawal_callback', {
    p_order_id: orderId,
    p_settlement_id: d.settlement_id ? String(d.settlement_id) : null,
    p_amount: Number(d.amount),
    p_currency: String(d.currency || 'NGN'),
    p_status: d.status ? String(d.status) : null,
    p_status_code: Number(d.status_code),
    p_status_detail: d.status_detail ? String(d.status_detail) : null,
    p_payload: d
  });
  if (error) throw error;
  if (!applied?.ok || applied.kind !== 'admin_payout') throw new Error(applied?.error || 'Could not reconcile this admin payout.');
  return res.json({ ok: true, status_code: d.status_code, status: d.status });
}

async function getGatewayOverview(res) {
  if (!mgmBridgeConfigured()) return res.status(503).json({ error: 'MGM bridge is not configured on the app server.' });
  const [balance, payouts] = await Promise.all([
    callMgmBridge('balance'),
    supabaseAdmin.from('gateway_admin_payouts').select('*').order('created_at', { ascending: false }).limit(30)
  ]);
  if (payouts.error) throw payouts.error;
  return res.json({ balance: balance.data || {}, payouts: payouts.data || [] });
}

async function createGatewayAdminPayout(req, admin, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!mgmBridgeConfigured()) return res.status(503).json({ error: 'MGM bridge is not configured on the app server.' });
  const { amount, bank_code, account_number, account_name } = req.body || {};
  const payoutAmount = Math.round(Number(amount) * 100) / 100;
  if (!Number.isFinite(payoutAmount) || payoutAmount <= 0) return res.status(400).json({ error: 'Enter a valid payout amount.' });
  if (!validNgnBankCode(bank_code)) return res.status(400).json({ error: 'Select a supported MGM Pay bank.' });
  if (!/^\d{10}$/.test(String(account_number || ''))) return res.status(400).json({ error: 'Account number must be 10 digits.' });
  if (!String(account_name || '').trim()) return res.status(400).json({ error: 'Account name is required.' });

  const balanceResult = await callMgmBridge('balance');
  const available = Number(balanceResult.data?.available_balance);
  if (!Number.isFinite(available)) return res.status(502).json({ error: 'MGM Pay did not return an available balance.' });
  if (payoutAmount > available) return res.status(400).json({ error: `Requested payout exceeds gateway available balance (${available.toLocaleString()} NGN).` });

  const bankName = Object.entries(MGM_NG_BANKS).find(([, code]) => String(code) === String(bank_code))?.[0];
  const orderId = `apm_admin_${Date.now()}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const { data: record, error: insertError } = await supabaseAdmin.from('gateway_admin_payouts').insert({
    admin_user_id: admin.id,
    order_id: orderId,
    amount: payoutAmount,
    currency: 'NGN',
    bank_name: bankName,
    bank_code: String(bank_code),
    account_number: String(account_number),
    account_name: String(account_name).trim().slice(0, 100),
    status: 'pending',
    gateway_status: 'SUBMITTING'
  }).select().single();
  if (insertError) throw insertError;

  try {
    const result = await callMgmBridge('create_withdrawal', {
      order_id: orderId, amount: ngnAmount(payoutAmount),
      payee: { name: record.account_name, account: record.account_number, account_type: 'BANK', bank_code: record.bank_code }
    });
    const d = result.data || {};
    const { error } = await supabaseAdmin.from('gateway_admin_payouts').update({
      settlement_id: d.settlement_id || null,
      gateway_status: d.status || 'SUBMITTED',
      gateway_status_code: Number.isInteger(Number(d.status_code)) ? Number(d.status_code) : null,
      gateway_status_detail: d.status_detail || null,
      gateway_payload: d,
      updated_at: new Date().toISOString()
    }).eq('id', record.id);
    if (error) throw error;
    return res.status(201).json({ ok: true, payout: { ...record, gateway_status: d.status || 'SUBMITTED' } });
  } catch (error) {
    await supabaseAdmin.from('gateway_admin_payouts').update({
      status: error.definite ? 'rejected' : 'pending',
      gateway_status: error.definite ? 'REJECTED' : 'SUBMISSION_UNKNOWN',
      gateway_status_detail: String(error.message || 'Payout submission outcome unknown').slice(0, 500),
      updated_at: new Date().toISOString(),
      ...(error.definite ? { processed_at: new Date().toISOString() } : {})
    }).eq('id', record.id).eq('status', 'pending');
    if (error.definite) return res.status(502).json({ error: `MGM Pay rejected the payout request: ${error.message}` });
    return res.status(202).json({ ok: true, payout: { id: record.id, order_id: orderId, gateway_status: 'SUBMISSION_UNKNOWN' },
      message: 'The payout submission is uncertain. Reconcile this order before retrying; do not send it again.' });
  }
}

// ============ USERS ============
async function getUsers(req, res) {
  const search = (req.query.search || '').trim();
  let q = supabaseAdmin.from('profiles')
    .select('id, email, full_name, tier, tier_expires_at, is_frozen, created_at, wallets!left(balance)')
    .order('created_at', { ascending: false }).limit(200);
  if (search) q = q.or(`email.ilike.%${search}%,full_name.ilike.%${search}%`);
  const { data } = await q;
  return res.json({ users: data || [] });
}

async function updateUser(req, res) {
  const { user_id, tier, is_frozen, tier_expiry_days } = req.body;
  const updates = {};
  if (is_frozen !== undefined) updates.is_frozen = is_frozen;

  if (tier !== undefined) {
    updates.tier = tier;
    if (tier_expiry_days !== undefined && tier_expiry_days !== null && tier_expiry_days !== '') {
      updates.tier_expires_at = tierExpiryFromNow(tier_expiry_days);
    } else {
      const cfg = await getTierConfig(tier);
      updates.tier_expires_at = tierExpiryFromNow(cfg.expiry_days);
    }
  } else if (tier_expiry_days !== undefined && tier_expiry_days !== null && tier_expiry_days !== '') {
    updates.tier_expires_at = tierExpiryFromNow(tier_expiry_days);
  }

  const { error } = await supabaseAdmin.from('profiles').update(updates).eq('id', user_id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
}

async function adjustBalance(req, res) {
  const { user_id, amount, type, reason } = req.body;
  const num = Number(amount);
  if (!num || num <= 0) return res.status(400).json({ error: 'Invalid amount' });
  const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', user_id).single();
  if (!wallet) return res.status(400).json({ error: 'Wallet not found' });
  let newBalance = Number(wallet.balance);
  if (type === 'credit') newBalance += num;
  else if (type === 'debit') {
    if (newBalance < num) return res.status(400).json({ error: 'Insufficient balance for debit' });
    newBalance -= num;
  } else return res.status(400).json({ error: 'Invalid type' });
  await supabaseAdmin.from('wallets').update({ balance: newBalance, updated_at: new Date().toISOString() }).eq('user_id', user_id);
  await supabaseAdmin.from('transactions').insert({
    user_id, type: type === 'credit' ? 'admin_credit' : 'admin_debit', amount: num, status: 'approved',
    reference: `admin_adj_${Date.now()}`, description: `Admin ${type}: ${reason || 'Manual adjustment'}`
  });
  return res.json({ ok: true, new_balance: newBalance });
}

// ============ TASKS MANAGER ============
async function getTasks(res) {
  const [tasks, claims] = await Promise.all([
    supabaseAdmin.from('tasks').select('*').order('sort_order', { ascending: true }),
    supabaseAdmin.from('task_claims').select('task_id, claim_date')
  ]);
  const today = todayUTC();
  const stats = {};
  (claims.data || []).forEach(c => {
    stats[c.task_id] = stats[c.task_id] || { total: 0, today: 0 };
    stats[c.task_id].total++;
    if (c.claim_date === today) stats[c.task_id].today++;
  });
  return res.json({ tasks: (tasks.data || []).map(t => ({ ...t, claims: stats[t.id] || { total: 0, today: 0 } })) });
}

async function saveTask(req, res) {
  const { id, title, description, reward_amount, min_tier, icon, is_active, sort_order, frequency } = req.body;
  if (!title || !reward_amount) return res.status(400).json({ error: 'Title and reward are required' });
  const payload = {
    title, description: description || null, reward_amount: Number(reward_amount),
    min_tier: min_tier || 'A0', icon: icon || 'fa-solid fa-star',
    frequency: frequency || 'daily',
    is_active: is_active !== false, sort_order: Number(sort_order || 0)
  };
  const { error } = id
    ? await supabaseAdmin.from('tasks').update(payload).eq('id', id)
    : await supabaseAdmin.from('tasks').insert(payload);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
}

async function deleteTask(req, res) {
  const { id } = req.body;
  const { error } = await supabaseAdmin.from('tasks').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
}

// ============ TIERS ============
async function getTiers(res) {
  const [tiers, profiles] = await Promise.all([
    supabaseAdmin.from('apm_tiers').select('*').order('sort_order', { ascending: true }),
    supabaseAdmin.from('profiles').select('tier')
  ]);
  const counts = {};
  (profiles.data || []).forEach(p => { counts[p.tier] = (counts[p.tier] || 0) + 1; });
  return res.json({ tiers: (tiers.data || []).map(t => ({ ...t, members: counts[t.tier] || 0 })) });
}

async function updateTier(req, res) {
  const { tier, upgrade_cost, description, is_active, expiry_days, daily_task_limit, task_bonus } = req.body;
  const updates = {};
  if (upgrade_cost !== undefined) updates.upgrade_cost = Number(upgrade_cost);
  if (description !== undefined) updates.description = description;
  if (is_active !== undefined) updates.is_active = is_active;
  if (expiry_days !== undefined) updates.expiry_days = Number(expiry_days);
  if (daily_task_limit !== undefined) updates.daily_task_limit = Number(daily_task_limit);
  if (task_bonus !== undefined) updates.task_bonus = Number(task_bonus);
  const { error } = await supabaseAdmin.from('apm_tiers').update(updates).eq('tier', tier);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
}

// ============ WEALTH ============
async function getWealthPackages(res) {
  const [{ data, error }, { data: buyerCounts, error: countError }] = await Promise.all([
    supabaseAdmin.from('wealth_packages').select('*').order('investment_amount', { ascending: true }),
    supabaseAdmin.rpc('get_mining_package_buyer_counts')
  ]);
  if (error) return res.status(500).json({ error: error.message });
  if (countError) return res.status(500).json({ error: countError.message });
  const counts = Object.fromEntries((buyerCounts || []).map((row) => [row.package_id, Number(row.buyers_count || 0)]));
  return res.json({ packages: (data || []).map((pkg) => ({
    ...pkg,
    buyers_count: counts[pkg.id] || 0,
    users_remaining: pkg.is_limited ? Math.max(0, Number(pkg.max_users || 0) - (counts[pkg.id] || 0)) : null
  })) });
}

async function saveWealthPackage(req, res) {
  const { id, name, investment_amount, duration_days, total_return, start_date, end_date, is_active,
    is_limited, max_users, available_from, available_until } = req.body;
  const investment = Number(investment_amount);
  const days = Number(duration_days);
  const maturityPayout = Number(total_return);
  if (!name || !Number.isFinite(investment) || !Number.isInteger(days) || !Number.isFinite(maturityPayout)) {
    return res.status(400).json({ error: 'All core fields are required' });
  }
  if (investment <= 0 || days <= 0 || maturityPayout <= investment) {
    return res.status(400).json({ error: 'Maturity payout must be greater than the positive investment amount and duration' });
  }
  const limited = is_limited === true || is_limited === 'true';
  const maxUsers = max_users === '' || max_users === null || max_users === undefined ? null : Number(max_users);
  if (limited && (!Number.isInteger(maxUsers) || maxUsers <= 0)) {
    return res.status(400).json({ error: 'Limited packages require a positive whole-number user limit' });
  }
  const validTimestamp = (value) => !value || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
  if (!validTimestamp(available_from) || !validTimestamp(available_until)) {
    return res.status(400).json({ error: 'Availability dates must be valid date/time values' });
  }
  if (available_from && available_until && Date.parse(available_until) <= Date.parse(available_from)) {
    return res.status(400).json({ error: 'Availability end must be later than its start' });
  }
  const payload = {
    name, investment_amount: investment,
    daily_return: Number(((maturityPayout - investment) / days).toFixed(2)),
    duration_days: days, total_return: maturityPayout,
    start_date: start_date || null, end_date: end_date || null,
    is_limited: limited, max_users: limited ? maxUsers : null,
    available_from: available_from || null, available_until: available_until || null,
    is_active: is_active !== false, updated_at: new Date().toISOString()
  };
  const { error } = id
    ? await supabaseAdmin.from('wealth_packages').update(payload).eq('id', id)
    : await supabaseAdmin.from('wealth_packages').insert(payload);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
}

async function deleteWealthPackage(req, res) {
  const { id } = req.body;
  const { error } = await supabaseAdmin.from('wealth_packages').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
}

async function getInvestments(res) {
  const { data } = await supabaseAdmin.from('wealth_investments')
    .select('*, profiles!user_id(email, full_name), wealth_packages(name)')
    .order('created_at', { ascending: false }).limit(100);
  return res.json({ investments: data || [] });
}

// ============ MESSAGES & SETTINGS ============
async function sendMessage(req, res) {
  const { user_id, title, body } = req.body;
  if (!user_id || !title || !body) return res.status(400).json({ error: 'All fields required' });
  const { error } = await supabaseAdmin.from('messages').insert({ user_id, title, body });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
}

async function getSettings(res) {
  const { data } = await supabaseAdmin.from('site_settings').select('key, value');
  const settings = {};
  (data || []).forEach(r => settings[r.key] = r.value);
  return res.json({ settings });
}

async function saveSettings(req, res) {
  const entries = Object.entries(req.body || {});
  for (const [key, value] of entries) {
    const { error } = await supabaseAdmin.from('site_settings').upsert({ key, value: String(value) });
    if (error) return res.status(500).json({ error: `Could not save ${key}: ${error.message}` });
  }
  return res.json({ ok: true });
}
