import supabaseAdmin from '../lib/supabase.js';
import { verifyUser, getProfile } from '../lib/auth.js';

const money = (value) => Math.round(Number(value || 0) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const cronAuthorized = (req) => {
  const expected = process.env.MINING_CRON_SECRET;
  if (!expected) return false;
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return bearer === expected || req.headers['x-cron-secret'] === expected;
};

export default async function handler(req, res) {
  try {
    if (req.query.action === 'processPayouts') return await processPayouts(req, res);

    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const profile = await getProfile(user.id);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    if (profile.is_frozen) return res.status(403).json({ error: 'Account frozen' });

    switch (req.query.action) {
      case 'getPackages': return await getPackages(user.id, res);
      case 'getRented': return await getRented(user.id, res);
      case 'buyPackage': return await buyPackage(req, user.id, res);
      default: return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    console.error('[APM-MINING-MACHINES] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function getPackages(userId, res) {
  const [{ data: packages, error: packageError }, { data: purchases, error: purchaseError }] = await Promise.all([
    supabaseAdmin.from('wealth_packages').select('*').eq('is_active', true).order('investment_amount', { ascending: true }),
    supabaseAdmin.from('wealth_investments').select('package_id').eq('user_id', userId)
  ]);
  if (packageError) throw packageError;
  if (purchaseError) throw purchaseError;
  const counts = {};
  (purchases || []).forEach((purchase) => { counts[purchase.package_id] = (counts[purchase.package_id] || 0) + 1; });
  return res.json({
    ok: true,
    packages: (packages || []).filter((pkg) => (!pkg.start_date || today() >= pkg.start_date) && (!pkg.end_date || today() <= pkg.end_date)).map((pkg) => ({
      ...pkg,
      purchase_count: counts[pkg.id] || 0,
      purchases_remaining: Math.max(0, 3 - (counts[pkg.id] || 0))
    }))
  });
}

async function getRented(userId, res) {
  const { data, error } = await supabaseAdmin.from('wealth_investments')
    .select('*, wealth_packages(name, investment_amount, daily_return, duration_days)')
    .eq('user_id', userId)
    .order('purchased_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return res.json({ ok: true, rented: (data || []).map((machine) => ({
    ...machine,
    amount: money(machine.amount),
    total_earned: money(machine.total_earned),
    daily_return: money(machine.wealth_packages?.daily_return),
    purchase_time: machine.purchased_at || machine.created_at,
    next_income_at: machine.next_payout_at || null
  })) });
}

async function buyPackage(req, userId, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { package_id } = req.body || {};
  if (!package_id) return res.status(400).json({ error: 'Missing package_id' });
  const { data: pkg } = await supabaseAdmin.from('wealth_packages').select('*').eq('id', package_id).eq('is_active', true).single();
  if (!pkg) return res.status(404).json({ error: 'Mining Machine package not found' });
  if ((pkg.start_date && today() < pkg.start_date) || (pkg.end_date && today() > pkg.end_date)) {
    return res.status(400).json({ error: 'This Mining Machine is not currently available' });
  }
  const { count, error: countError } = await supabaseAdmin.from('wealth_investments')
    .select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('package_id', package_id);
  if (countError) throw countError;
  if ((count || 0) >= 3) return res.status(409).json({ error: 'Each Mining Machine package can only be bought 3 times.' });

  const amount = money(pkg.investment_amount);
  const purchasedAt = new Date();
  const endsAt = new Date(purchasedAt.getTime() + Number(pkg.duration_days) * 86400000);
  const nextPayoutAt = new Date(purchasedAt.getTime() + 86400000);
  const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', userId).single();
  if (Number(wallet?.balance || 0) < amount) return res.status(400).json({ error: 'Insufficient wallet balance' });

  const { data: machine, error: machineError } = await supabaseAdmin.from('wealth_investments').insert({
    user_id: userId,
    package_id,
    amount,
    start_date: today(),
    end_date: endsAt.toISOString().slice(0, 10),
    purchased_at: purchasedAt.toISOString(),
    ends_at: endsAt.toISOString(),
    next_payout_at: nextPayoutAt.toISOString(),
    total_earned: 0,
    payout_count: 0,
    status: 'active'
  }).select().single();
  if (machineError) throw machineError;

  const { error: walletError } = await supabaseAdmin.from('wallets').update({
    balance: Number(wallet.balance) - amount,
    updated_at: new Date().toISOString()
  }).eq('user_id', userId);
  if (walletError) throw walletError;
  const { error: transactionError } = await supabaseAdmin.from('transactions').insert({
    user_id: userId,
    type: 'mining_machine_purchase',
    amount,
    status: 'approved',
    reference: `MINING_PURCHASE_${machine.id}`,
    description: `Purchased ${pkg.name}`
  });
  if (transactionError) throw transactionError;
  return res.status(201).json({ ok: true, machine, purchases_remaining: Math.max(0, 2 - (count || 0)) });
}

async function processPayouts(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!cronAuthorized(req)) return res.status(401).json({ error: 'Invalid cron secret' });
  const { data, error } = await supabaseAdmin.rpc('process_due_mining_payouts');
  if (error) throw error;
  const result = Array.isArray(data) ? data[0] : data;
  return res.json({ ok: true, processed_investments: result?.processed_investments || 0, processed_payouts: result?.processed_payouts || 0, processed_at: new Date().toISOString() });
}
