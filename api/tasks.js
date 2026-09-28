import supabaseAdmin from '../lib/supabase.js';
import { verifyUser, getProfile } from '../lib/auth.js';

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
// GET TASKS (with claim status + tier locks)
// ==========================================
async function getTasks(user, res) {
  const profile = await getProfile(user.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  if (profile.is_frozen) return res.status(403).json({ error: 'Account frozen' });

  const today = todayUTC();

  const [{ data: tasks, error: tasksError }, { data: claims }] = await Promise.all([
    supabaseAdmin.from('tasks').select('*').eq('is_active', true).order('sort_order', { ascending: true }),
    supabaseAdmin.from('task_claims').select('task_id').eq('user_id', user.id).eq('claim_date', today)
  ]);

  if (tasksError) return res.status(500).json({ error: tasksError.message });

  const claimedIds = new Set((claims || []).map(c => c.task_id));
  const userRank = tierRank(profile.tier);

  const result = (tasks || []).map(t => ({
    id: t.id,
    title: t.title,
    description: t.description,
    reward_amount: Number(t.reward_amount),
    min_tier: t.min_tier,
    icon: t.icon,
    claimed_today: claimedIds.has(t.id),
    locked: userRank < tierRank(t.min_tier)
  }));

  // Today's earnings (approved transactions since UTC midnight)
  const { data: todayTxns } = await supabaseAdmin
    .from('transactions')
    .select('amount')
    .eq('user_id', user.id)
    .eq('status', 'approved')
    .gte('created_at', `${today}T00:00:00.000Z`);

  const todayEarned = (todayTxns || []).reduce((s, r) => s + Number(r.amount), 0);

  return res.json({
    ok: true,
    tier: profile.tier,
    streak: profile.current_streak || 0,
    today_earned: todayEarned,
    tasks: result
  });
}

// ==========================================
// CLAIM TASK (atomic: claim row = the lock)
// ==========================================
async function claimTask(req, user, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { task_id } = req.body || {};
  if (!task_id) return res.status(400).json({ error: 'Missing task_id' });

  const profile = await getProfile(user.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  if (profile.is_frozen) return res.status(403).json({ error: 'Account frozen' });

  // 1. Load task
  const { data: task } = await supabaseAdmin.from('tasks').select('*').eq('id', task_id).single();
  if (!task || !task.is_active) return res.status(404).json({ error: 'Task not available' });

  // 2. Tier gate
  if (tierRank(profile.tier) < tierRank(task.min_tier)) {
    return res.status(403).json({ error: `Unlock at tier ${task.min_tier}` });
  }

  const today = todayUTC();
  const amount = Number(task.reward_amount);

  // 3. Insert claim FIRST — unique(user_id, task_id, claim_date) blocks duplicates
  const { data: claim, error: claimError } = await supabaseAdmin
    .from('task_claims')
    .insert({ user_id: user.id, task_id, amount, claim_date: today })
    .select('id')
    .single();

  if (claimError) {
    if (claimError.code === '23505') {
      return res.status(409).json({ error: 'Already claimed today. Come back tomorrow!' });
    }
    return res.status(500).json({ error: claimError.message });
  }

  // 4. Credit wallet (upsert = create-if-missing safety)
  const { data: wallet } = await supabaseAdmin
    .from('wallets').select('balance').eq('user_id', user.id).single();
  const newBalance = Number(wallet?.balance || 0) + amount;

  const { error: walletError } = await supabaseAdmin.from('wallets').upsert(
    { user_id: user.id, balance: newBalance, updated_at: new Date().toISOString() },
    { onConflict: 'user_id' }
  );
  if (walletError) return res.status(500).json({ error: walletError.message });

  // 5. Transaction record
  await supabaseAdmin.from('transactions').insert({
    user_id: user.id,
    type: 'task_claim',
    amount,
    status: 'approved',
    reference: `TASKCLAIM_${claim.id}`,
    description: `Task: ${task.title}`
  });

  // 6. Streak update (consecutive daily claims)
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  let streak = profile.current_streak || 0;
  if (profile.last_claim_date === yesterday) streak += 1;
  else if (profile.last_claim_date !== today) streak = 1;

  await supabaseAdmin.from('profiles')
    .update({ current_streak: streak, last_claim_date: today })
    .eq('id', user.id);

  return res.json({ ok: true, amount, new_balance: newBalance, streak });
}
