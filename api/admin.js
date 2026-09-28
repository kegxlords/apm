import supabaseAdmin from '../lib/supabase.js';
import { verifyUser, isAdmin } from '../lib/auth.js';
import { payReferralCommission, getSetting } from '../lib/rewards.js';

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
  if (d.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

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
  if (w.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

  if (act === 'reject') {
    const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', w.user_id).single();
    await supabaseAdmin.from('wallets').update({ balance: Number(wallet?.balance || 0) + Number(w.amount), updated_at: new Date().toISOString() }).eq('user_id', w.user_id);
    await supabaseAdmin.from('withdrawals').update({ status: 'rejected', note: note || 'Rejected by admin', processed_at: new Date().toISOString() }).eq('id', w.id);
    await supabaseAdmin.from('transactions').update({ status: 'rejected' }).eq('reference', `wd_${w.id}`);
    return res.json({ ok: true, action: 'rejected' });
  }

  if (act === 'approve') {
    await supabaseAdmin.from('withdrawals').update({ status: 'approved', note: note || 'Approved — pay manually', processed_at: new Date().toISOString() }).eq('id', w.id);
    await supabaseAdmin.from('transactions').update({ status: 'approved' }).eq('reference', `wd_${w.id}`);
    return res.json({ ok: true, action: 'approved' });
  }
  return res.status(400).json({ error: 'Invalid action' });
}

// ============ USERS ============
async function getUsers(req, res) {
  const search = (req.query.search || '').trim();
  let q = supabaseAdmin.from('profiles')
    .select('id, email, full_name, tier, is_frozen, created_at, wallets!left(balance)')
    .order('created_at', { ascending: false }).limit(200);
  if (search) q = q.or(`email.ilike.%${search}%,full_name.ilike.%${search}%`);
  const { data } = await q;
  return res.json({ users: data || [] });
}

async function updateUser(req, res) {
  const { user_id, tier, is_frozen } = req.body;
  const updates = {};
  if (tier !== undefined) updates.tier = tier;
  if (is_frozen !== undefined) updates.is_frozen = is_frozen;
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
  const { id, title, description, reward_amount, min_tier, icon, is_active, sort_order } = req.body;
  if (!title || !reward_amount) return res.status(400).json({ error: 'Title and reward are required' });
  const payload = {
    title, description: description || null, reward_amount: Number(reward_amount),
    min_tier: min_tier || 'A0', icon: icon || 'fa-solid fa-star',
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
  const { tier, upgrade_cost, description, is_active } = req.body;
  const updates = {};
  if (upgrade_cost !== undefined) updates.upgrade_cost = Number(upgrade_cost);
  if (description !== undefined) updates.description = description;
  if (is_active !== undefined) updates.is_active = is_active;
  const { error } = await supabaseAdmin.from('apm_tiers').update(updates).eq('tier', tier);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
}

// ============ WEALTH ============
async function getWealthPackages(res) {
  const { data } = await supabaseAdmin.from('wealth_packages').select('*').order('investment_amount', { ascending: true });
  return res.json({ packages: data || [] });
}

async function saveWealthPackage(req, res) {
  const { id, name, investment_amount, daily_return, duration_days, total_return, start_date, end_date, is_active } = req.body;
  if (!name || !investment_amount || !daily_return || !duration_days || !total_return) {
    return res.status(400).json({ error: 'All core fields are required' });
  }
  const payload = {
    name, investment_amount: Number(investment_amount), daily_return: Number(daily_return),
    duration_days: Number(duration_days), total_return: Number(total_return),
    start_date: start_date || null, end_date: end_date || null,
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
    await supabaseAdmin.from('site_settings').upsert({ key, value: String(value) });
  }
  return res.json({ ok: true });
}
