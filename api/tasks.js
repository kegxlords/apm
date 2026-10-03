import supabaseAdmin from '../lib/supabase.js';
import { verifyUser, getProfile } from '../lib/auth.js';
import { getTierConfig, ensureTierActive } from '../lib/tiers.js';

const TIER_ORDER = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'];
const tierRank = (t) => { const i = TIER_ORDER.indexOf(t); return i === -1 ? 0 : i; };
const todayUTC = () => new Date().toISOString().slice(0, 10);

export default async function handler(req, res) {
  const action = req.query.action;
  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    switch (action) {
      case 'getTasks': return await getTasks(user, res);
      case 'claimTask': return await claimTask(req, user, res);
      default: return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    console.error('[APM-TASKS] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ==========================================
// GET TASKS (tier controls what's shown + exact pay)
// ==========================================
async function getTasks(user, res) {
  let profile = await ensureTierActive(await getProfile(user.id));
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  if (profile.is_frozen) return res.status(403).json({ error: 'Account frozen' });

  const tierCfg = await getTierConfig(profile.tier);
  const today = todayUTC();

  const [{ data: tasks, error: tasksError }, { data: claims }] = await Promise.all([
    supabaseAdmin.from('tasks').select('*').eq('is_active', true).order('sort_order', { ascending: true }),
    supabaseAdmin.from('task_claims').select('task_id, claim_date').eq('user_id', user.id)
  ]);

  if (tasksError) return res.status(500).json({ error: tasksError.message });

  const claimMap = {};
  (claims || []).forEach(c => {
    claimMap[c.task_id] = claimMap[c.task_id] || { today: false, ever: true };
    if (c.claim_date === today) claimMap[c.task_id].today = true;
  });

  const claimsToday = (claims || []).filter(c => c.claim_date === today).length;
  const tierIncome = Number(tierCfg.task_bonus || 0); // exact pay per task (0 = use task's own reward)
  const userRank = tierRank(profile.tier);
  const limit = Number(tierCfg.daily_task_limit || 0);

  // Tasks unlocked for this tier, in admin order
  const unlocked = (tasks || []).filter(t => userRank >= tierRank(t.min_tier));
  // Tier's Tasks/Day = exactly how many tasks this tier sees (0 = all)
  const visible = limit > 0 ? unlocked.slice(0, limit) : unlocked;

  const result = visible.map(t => {
    const c = claimMap[t.id];
    const claimed = t.frequency === 'once' ? !!c : !!c?.today;
    return {
      id: t.id,
      title: t.title,
      description: t.description,
      reward_amount: Number(t.reward_amount),
      effective_reward: tierIncome > 0 ? tierIncome : Number(t.reward_amount),
      min_tier: t.min_tier,
      icon: t.icon,
      frequency: t.frequency || 'daily',
      claimed_today: claimed,
      locked: false
    };
  });

  const { data: todayTxns } = await supabaseAdmin
    .from('transactions')
    .select('amount')
    .eq('user_id', user.id)
    .eq('status', 'approved')
    .gte('created_at', `${today}T00:00:00.000Z`);

  return res.json({
    ok: true,
    tier: profile.tier,
    streak: profile.current_streak || 0,
    today_earned: (todayTxns || []).reduce((s, r) => s + Number(r.amount), 0),
    daily_limit: limit,
    tasks_visible: visible.length,
    claims_today: claimsToday,
    task_bonus: tierIncome,
    tier_expires_at: profile.tier_expires_at || null,
    tasks: result
  });
}

// ==========================================
// CLAIM TASK
// ==========================================
async function claimTask(req, user, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { task_id } = req.body || {};
  if (!task_id) return res.status(400).json({ error: 'Missing task_id' });

  let profile = await ensureTierActive(await getProfile(user.id));
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  if (profile.is_frozen) return res.status(403).json({ error: 'Account frozen' });

  const { data: task } = await supabaseAdmin.from('tasks').select('*').eq('id', task_id).single();
  if (!task || !task.is_active) return res.status(404).json({ error: 'Task not available' });

  if (tierRank(profile.tier) < tierRank(task.min_tier)) {
    return res.status(403).json({ error: `Unlock at tier ${task.min_tier}` });
  }

  const tierCfg = await getTierConfig(profile.tier);
  const today = todayUTC();

  // Daily claim limit per tier (0 = unlimited)
  const limit = Number(tierCfg.daily_task_limit || 0);
  if (limit > 0) {
    const { count } = await supabaseAdmin.from('task_claims')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id).eq('claim_date', today);
    if ((count || 0) >= limit) {
      return res.status(400).json({ error: `Your ${profile.tier} plan allows ${limit} task claim${limit === 1 ? '' : 's'} per day. Upgrade for more.` });
    }
  }

  // One-time tasks: block if ever claimed
  if (task.frequency === 'once') {
    const { count } = await supabaseAdmin.from('task_claims')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id).eq('task_id', task_id);
    if (count > 0) return res.status(409).json({ error: 'One-time task — you already claimed it.' });
  }

  // EXACT pay: tier's ₦/task if set, otherwise the task's own reward
  const tierIncome = Number(tierCfg.task_bonus || 0);
  const amount = tierIncome > 0 ? tierIncome : Number(task.reward_amount);

  const { data: claim, error: claimError } = await supabaseAdmin
    .from('task_claims')
    .insert({ user_id: user.id, task_id, amount, claim_date: today })
    .select('id').single();

  if (claimError) {
    if (claimError.code === '23505') return res.status(409).json({ error: 'Already claimed today. Come back tomorrow!' });
    return res.status(500).json({ error: claimError.message });
  }

  const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', user.id).single();
  const newBalance = Number(wallet?.balance || 0) + amount;

  const { error: walletError } = await supabaseAdmin.from('wallets').upsert(
    { user_id: user.id, balance: newBalance, updated_at: new Date().toISOString() },
    { onConflict: 'user_id' }
  );
  if (walletError) return res.status(500).json({ error: walletError.message });

  await supabaseAdmin.from('transactions').insert({
    user_id: user.id,
    type: 'task_claim',
    amount,
    status: 'approved',
    reference: `TASKCLAIM_${claim.id}`,
    description: `Task: ${task.title}` + (tierIncome > 0 ? ` (${profile.tier} rate ₦${tierIncome})` : '')
  });

  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  let streak = profile.current_streak || 0;
  if (profile.last_claim_date === yesterday) streak += 1;
  else if (profile.last_claim_date !== today) streak = 1;

  await supabaseAdmin.from('profiles')
    .update({ current_streak: streak, last_claim_date: today })
    .eq('id', profile.id);

  return res.json({ ok: true, amount, new_balance: newBalance, streak });
}
