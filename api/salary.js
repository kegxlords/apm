import supabaseAdmin from '../lib/supabase.js';
import { verifyUser, getProfile } from '../lib/auth.js';

const money = (value) => Math.round(Number(value || 0) * 100) / 100;

export default async function handler(req, res) {
  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const profile = await getProfile(user.id);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    if (profile.is_frozen) return res.status(403).json({ error: 'Account frozen' });

    if (req.query.action === 'getSalary') return await getSalary(user.id, res);
    if (req.query.action === 'claimSalary') return await claimSalary(req, user.id, res);
    return res.status(400).json({ error: 'Invalid action' });
  } catch (err) {
    console.error('[APM-SALARY] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function calculateSalary(userId) {
  const [{ data: team, error: teamError }, { data: levels, error: levelsError }] = await Promise.all([
    supabaseAdmin.from('profiles').select('id').eq('referred_by', userId),
    supabaseAdmin.from('salary_levels').select('*').eq('is_active', true).order('sort_order', { ascending: true })
  ]);
  if (teamError) throw teamError;
  if (levelsError) throw levelsError;

  const teamIds = (team || []).map((member) => member.id);
  let deposits = [];
  if (teamIds.length) {
    const { data, error } = await supabaseAdmin
      .from('deposits')
      .select('amount')
      .in('user_id', teamIds)
      .eq('status', 'completed');
    if (error) throw error;
    deposits = data || [];
  }
  const total = money(deposits.reduce((sum, row) => sum + Number(row.amount || 0), 0));
  const { data: claims, error: claimsError } = await supabaseAdmin
    .from('salary_claims')
    .select('id, salary_level_id, amount, team_deposits_at_claim, claimed_at')
    .eq('user_id', userId);
  if (claimsError) throw claimsError;
  const claimedByLevel = new Map((claims || []).map((claim) => [claim.salary_level_id, claim]));

  return {
    team_count: teamIds.length,
    total_team_deposits: total,
    claimed_count: (claims || []).length,
    levels: (levels || []).map((level) => {
      const claim = claimedByLevel.get(level.id);
      const threshold = money(level.deposit_threshold);
      return {
        id: level.id,
        label: level.label,
        deposit_threshold: threshold,
        reward_amount: money(level.reward_amount),
        claimed: Boolean(claim),
        claimed_at: claim?.claimed_at || null,
        team_deposits_at_claim: claim ? money(claim.team_deposits_at_claim) : null,
        eligible: total >= threshold && !claim,
        progress: Math.min(total / threshold, 1)
      };
    })
  };
}

async function getSalary(userId, res) {
  return res.json({ ok: true, ...(await calculateSalary(userId)) });
}

async function claimSalary(req, userId, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { level_id } = req.body || {};
  if (!level_id) return res.status(400).json({ error: 'Missing salary level' });

  const state = await calculateSalary(userId);
  const level = state.levels.find((item) => item.id === level_id);
  if (!level) return res.status(404).json({ error: 'Salary level not found' });
  if (level.claimed) return res.status(409).json({ error: 'This salary reward has already been claimed.' });
  if (state.total_team_deposits < level.deposit_threshold) {
    const remaining = level.deposit_threshold - state.total_team_deposits;
    return res.status(400).json({ error: `You need ₦${remaining.toLocaleString()} more in completed team deposits.` });
  }

  const { data: claim, error: claimError } = await supabaseAdmin.from('salary_claims').insert({
    user_id: userId,
    salary_level_id: level.id,
    amount: level.reward_amount,
    team_deposits_at_claim: state.total_team_deposits
  }).select('id').single();
  if (claimError) {
    if (claimError.code === '23505') return res.status(409).json({ error: 'This salary reward has already been claimed.' });
    throw claimError;
  }

  const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', userId).single();
  const newBalance = money(Number(wallet?.balance || 0) + level.reward_amount);
  const { error: walletError } = await supabaseAdmin.from('wallets').upsert(
    { user_id: userId, balance: newBalance, updated_at: new Date().toISOString() },
    { onConflict: 'user_id' }
  );
  if (walletError) throw walletError;

  const { error: transactionError } = await supabaseAdmin.from('transactions').insert({
    user_id: userId,
    type: 'salary_bonus',
    amount: level.reward_amount,
    status: 'approved',
    reference: `SALARY_${claim.id}`,
    description: `${level.label} team deposit salary bonus`
  });
  if (transactionError) throw transactionError;

  return res.json({ ok: true, amount: level.reward_amount, new_balance: newBalance, claim_id: claim.id });
}
