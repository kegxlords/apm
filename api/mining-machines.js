import supabaseAdmin from '../lib/supabase.js';
import { verifyUser, getProfile } from '../lib/auth.js';

const money = (value) => Math.round(Number(value || 0) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const purchaseLimit = (pkg) => [2, 5, 10, 365].includes(Number(pkg.duration_days)) ? 1 : 2;

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
  const [{ data: packages, error: packageError }, { data: purchases, error: purchaseError }, { data: buyerCounts, error: buyerCountError }] = await Promise.all([
    supabaseAdmin.from('wealth_packages').select('*').order('investment_amount', { ascending: true }),
    supabaseAdmin.from('wealth_investments').select('package_id').eq('user_id', userId),
    supabaseAdmin.rpc('get_mining_package_buyer_counts')
  ]);
  if (packageError) throw packageError;
  if (purchaseError) throw purchaseError;
  if (buyerCountError) throw buyerCountError;
  const counts = {};
  (purchases || []).forEach((purchase) => { counts[purchase.package_id] = (counts[purchase.package_id] || 0) + 1; });
  const currentDate = today();
  const currentTime = Date.now();
  const buyersByPackage = Object.fromEntries((buyerCounts || []).map((row) => [row.package_id, Number(row.buyers_count || 0)]));
  return res.json({
    ok: true,
    packages: (packages || []).map((pkg) => {
      const startsLater = Boolean((pkg.available_from && Date.parse(pkg.available_from) > currentTime)
        || (!pkg.available_from && pkg.start_date && currentDate < pkg.start_date));
      const expired = Boolean((pkg.available_until && Date.parse(pkg.available_until) < currentTime)
        || (!pkg.available_until && pkg.end_date && currentDate > pkg.end_date));
      const buyersCount = buyersByPackage[pkg.id] || 0;
      const usersRemaining = pkg.is_limited ? Math.max(0, Number(pkg.max_users || 0) - buyersCount) : null;
      const soldOut = pkg.is_limited && usersRemaining <= 0;
      const comingSoon = !pkg.is_active || startsLater;
      return {
        ...pkg,
        is_available: Boolean(pkg.is_active) && !startsLater && !expired && !soldOut,
        coming_soon: comingSoon,
        expired,
        sold_out: soldOut,
        buyers_count: buyersCount,
        users_remaining: usersRemaining,
        purchase_count: counts[pkg.id] || 0,
        purchase_limit: purchaseLimit(pkg),
        purchases_remaining: Math.max(0, purchaseLimit(pkg) - (counts[pkg.id] || 0)),
        profit_at_maturity: money(Math.max(0, Number(pkg.total_return || 0) - Number(pkg.investment_amount || 0)))
      };
    })
  });
}

async function getRented(userId, res) {
  const { data, error } = await supabaseAdmin.from('wealth_investments')
    .select('*, wealth_packages(name, investment_amount, daily_return, total_return, duration_days)')
    .eq('user_id', userId)
    .order('purchased_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return res.json({ ok: true, rented: (data || []).map((machine) => ({
    ...machine,
    amount: money(machine.amount),
    total_earned: money(machine.total_earned),
    daily_return: money(machine.wealth_packages?.daily_return),
    maturity_total: money(machine.maturity_total ?? machine.wealth_packages?.total_return ?? machine.amount),
    profit_at_maturity: money(Math.max(0, Number(machine.maturity_total ?? machine.wealth_packages?.total_return ?? machine.amount) - Number(machine.amount || 0))),
    purchase_time: machine.purchased_at || machine.created_at,
    next_income_at: machine.next_payout_at || null
  })) });
}

async function buyPackage(req, userId, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { package_id } = req.body || {};
  if (!package_id) return res.status(400).json({ error: 'Missing package_id' });
  const { data: pkg } = await supabaseAdmin.from('wealth_packages').select('*').eq('id', package_id).single();
  if (!pkg) return res.status(404).json({ error: 'Mining Machine package not found' });
  if (!pkg.is_active) return res.status(400).json({ error: 'This Mining Machine package is marked Coming Soon' });
  const now = Date.now();
  if ((pkg.available_from && Date.parse(pkg.available_from) > now)
    || (pkg.available_until && Date.parse(pkg.available_until) < now)
    || (!pkg.available_from && pkg.start_date && today() < pkg.start_date)
    || (!pkg.available_until && pkg.end_date && today() > pkg.end_date)) {
    return res.status(400).json({ error: 'This Mining Machine is not currently available' });
  }
  const { count, error: countError } = await supabaseAdmin.from('wealth_investments')
    .select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('package_id', package_id);
  if (countError) throw countError;
  const limit = purchaseLimit(pkg);
  if ((count || 0) >= limit) return res.status(409).json({ error: `This ${pkg.duration_days}-day Mining Machine package can only be bought ${limit} time${limit === 1 ? '' : 's'}.` });

  const { data: purchaseData, error: purchaseError } = await supabaseAdmin.rpc('purchase_mining_machine', {
    p_user_id: userId,
    p_package_id: package_id
  });
  if (purchaseError) {
    const message = purchaseError.message || 'Could not purchase Mining Machine';
    if (message.includes('can only be bought')) return res.status(409).json({ error: message });
    if (message.includes('limited package is sold out') || message.includes('maximum number of users')) return res.status(409).json({ error: message });
    if (message.includes('Insufficient wallet balance')) return res.status(400).json({ error: message });
    if (message.includes('not currently available')) return res.status(400).json({ error: message });
    if (message.includes('not found')) return res.status(404).json({ error: message });
    throw purchaseError;
  }
  const purchase = Array.isArray(purchaseData) ? purchaseData[0] : purchaseData;
  return res.status(201).json({
    ok: true,
    machine: purchase?.machine,
    purchases_remaining: Number(purchase?.purchases_remaining || 0)
  });
}

async function processPayouts(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // The existing cPanel cron calls this endpoint. Daily machines are settled first
  // so the maturity RPC does not pay the 50K package a second time.
  const daily = await processDailyMachinePayouts();
  const { data, error } = await supabaseAdmin.rpc('settle_matured_mining_investments');
  if (error) throw error;
  const result = Array.isArray(data) ? data[0] : data;
  return res.json({
    ok: true,
    daily_machine_users: daily.users,
    daily_machine_payouts: daily.payouts,
    daily_machine_amount: money(daily.amount),
    processed_investments: result?.processed_investments || 0,
    processed_payouts: result?.processed_investments || 0,
    returned_capital_amount: money(result?.capital_returned_amount || 0),
    profit_paid_amount: money(result?.profit_paid_amount || 0),
    processed_at: new Date().toISOString()
  });
}

// The 50K machine is the only package with automatic income.
// Payout #1 is due 24 hours after purchase; each later payout is due every 24 hours.
// Only the daily income is paid; the purchase capital is not returned.
async function processDailyMachinePayouts() {
  const now = Date.now();
  const dayMs = 86400000;
  const { data: machines, error } = await supabaseAdmin
    .from('wealth_investments')
    .select('id, user_id, amount, created_at, purchased_at, total_earned, status, wealth_packages!inner(name, investment_amount, daily_return, duration_days)')
    .eq('status', 'active')
    .eq('wealth_packages.investment_amount', 50000)
    .eq('wealth_packages.daily_return', 1500)
    .eq('wealth_packages.duration_days', 365);
  if (error) throw error;

  let users = 0;
  let payouts = 0;
  let amount = 0;
  for (const machine of machines || []) {
    const pkg = machine.wealth_packages;
    const purchasedAt = new Date(machine.purchased_at || machine.created_at).getTime();
    if (!Number.isFinite(purchasedAt)) continue;
    const dueCount = Math.min(365, Math.floor((now - purchasedAt) / dayMs));
    if (dueCount < 1) continue;

    const refs = Array.from({ length: dueCount }, (_, index) => `MACHINE_DAILY_${machine.id}_${index + 1}`);
    const { data: existing, error: existingError } = await supabaseAdmin
      .from('transactions').select('reference').eq('user_id', machine.user_id).in('reference', refs);
    if (existingError) throw existingError;
    const existingRefs = new Set((existing || []).map((row) => row.reference));
    const pending = refs.map((reference, index) => existingRefs.has(reference) ? null : index + 1).filter(Boolean);
    if (!pending.length) continue;

    const profit = Number(pkg.daily_return) * pending.length;
    const finalPayout = dueCount >= 365;
    const totalCredit = profit;
    const { data: wallet, error: walletError } = await supabaseAdmin
      .from('wallets').select('balance').eq('user_id', machine.user_id).single();
    if (walletError) throw walletError;
    const newBalance = Number(wallet?.balance || 0) + totalCredit;
    const { error: balanceError } = await supabaseAdmin.from('wallets').upsert(
      { user_id: machine.user_id, balance: newBalance, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );
    if (balanceError) throw balanceError;

    const rows = pending.map((index) => ({
      user_id: machine.user_id,
      type: 'mining_machine_profit',
      amount: Number(pkg.daily_return),
      status: 'approved',
      reference: `MACHINE_DAILY_${machine.id}_${index}`,
      description: `24-hour machine income: ${pkg.name}`
    }));
    const { error: transactionError } = await supabaseAdmin.from('transactions').insert(rows);
    if (transactionError) throw transactionError;

    const updates = {
      total_earned: Number(machine.total_earned || 0) + totalCredit,
      next_payout_at: finalPayout ? null : new Date(purchasedAt + (dueCount + 1) * dayMs).toISOString()
    };
    if (finalPayout) {
      updates.status = 'completed';
      updates.maturity_paid_at = new Date().toISOString();
    }
    const { error: updateError } = await supabaseAdmin.from('wealth_investments')
      .update(updates).eq('id', machine.id).eq('status', 'active');
    if (updateError) throw updateError;

    users += 1;
    payouts += pending.length;
    amount += totalCredit;
  }
  return { users, payouts, amount };
}
