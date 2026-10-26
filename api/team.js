import supabaseAdmin from '../lib/supabase.js';
import { verifyUser } from '../lib/auth.js';

const money = (value) => Math.round(Number(value || 0) * 100) / 100;
const PAGE_SIZE = 1000;
const MAX_DEPOSIT_ROWS = 10000;

function maskEmail(email) {
  if (!email || !email.includes('@')) return '';
  const [name, domain] = email.split('@');
  return `${name.slice(0, 1) || '*'}***@${domain || '***'}`;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { data: ownProfile, error: ownProfileError } = await supabaseAdmin
      .from('profiles')
      .select('referral_code')
      .eq('id', user.id)
      .single();
    if (ownProfileError) throw ownProfileError;

    const members = [];
    const seenIds = new Set([user.id]);
    let parentIds = [user.id];
    let memberListTruncated = false;

    for (let level = 1; level <= 3 && parentIds.length; level += 1) {
      const { data: rows, error } = await supabaseAdmin
        .from('profiles')
        .select('id, full_name, email, created_at, referred_by')
        .in('referred_by', parentIds)
        .order('created_at', { ascending: false })
        .limit(PAGE_SIZE);
      if (error) throw error;
      if ((rows || []).length === PAGE_SIZE) memberListTruncated = true;

      const nextParents = [];
      for (const row of rows || []) {
        if (seenIds.has(row.id)) continue;
        seenIds.add(row.id);
        members.push({
          id: row.id,
          name: row.full_name || 'Member',
          email: maskEmail(row.email),
          level,
          joined_at: row.created_at,
          active: false,
          active_machine_count: 0,
          status_label: 'Inactive',
          total_deposits: 0,
          deposit_count: 0
        });
        nextParents.push(row.id);
      }
      parentIds = nextParents;
    }

    const memberById = new Map(members.map((member) => [member.id, member]));
    const memberIds = members.map((member) => member.id);
    if (memberIds.length) {
      const { data: activeMachines, error: machineError } = await supabaseAdmin
        .from('wealth_investments')
        .select('user_id')
        .in('user_id', memberIds)
        .eq('status', 'active');
      if (machineError) throw machineError;
      (activeMachines || []).forEach(({ user_id: userId }) => {
        const member = memberById.get(userId);
        if (member) member.active_machine_count += 1;
      });
      members.forEach((member) => {
        member.active = member.active_machine_count > 0;
        member.status_label = member.active ? 'Active' : 'Inactive';
      });
    }

    const deposits = [];
    let depositRowsTruncated = false;

    for (let offset = 0; memberIds.length && offset < MAX_DEPOSIT_ROWS; offset += PAGE_SIZE) {
      const { data: rows, error } = await supabaseAdmin
        .from('deposits')
        .select('id, user_id, amount, status, created_at')
        .in('user_id', memberIds)
        .order('created_at', { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1);
      if (error) throw error;
      const batch = rows || [];
      for (const row of batch) {
        const member = memberById.get(row.user_id);
        if (member && row.status === 'completed') {
          member.total_deposits = money(member.total_deposits + Number(row.amount || 0));
          member.deposit_count += 1;
        }
      }
      deposits.push(...batch);
      if (batch.length < PAGE_SIZE) break;
      if (offset + PAGE_SIZE >= MAX_DEPOSIT_ROWS) depositRowsTruncated = true;
    }

    const { data: commissionRows, error: commissionError } = await supabaseAdmin
      .from('referral_commissions')
      .select('commission_amount, commission_level, created_at')
      .eq('referrer_id', user.id)
      .eq('status', 'paid')
      .order('created_at', { ascending: false })
      .limit(1000);
    if (commissionError) throw commissionError;

    const settingKeys = ['referral_commission_percentage', 'referral_level_2_percentage', 'referral_level_3_percentage'];
    const { data: settingRows, error: settingError } = await supabaseAdmin
      .from('site_settings')
      .select('key, value')
      .in('key', settingKeys);
    if (settingError) throw settingError;

    const rates = {
      1: '10',
      2: '2',
      3: '1'
    };
    (settingRows || []).forEach(({ key, value }) => {
      if (key === 'referral_commission_percentage') rates[1] = value;
      if (key === 'referral_level_2_percentage') rates[2] = value;
      if (key === 'referral_level_3_percentage') rates[3] = value;
    });

    const memberNameById = new Map(members.map((member) => [member.id, member.name]));
    const depositList = deposits.slice(0, 300).map((row) => ({
      id: row.id,
      member_name: memberNameById.get(row.user_id) || 'Team member',
      level: memberById.get(row.user_id)?.level || 1,
      amount: money(row.amount),
      status: row.status,
      created_at: row.created_at
    }));
    const levelSummary = [1, 2, 3].map((level) => {
      const atLevel = members.filter((member) => member.level === level);
      return {
        level,
        members: atLevel.length,
        active: atLevel.filter((member) => member.active).length,
        inactive: atLevel.filter((member) => !member.active).length,
        deposits: money(atLevel.reduce((sum, member) => sum + member.total_deposits, 0))
      };
    });

    return res.json({
      ok: true,
      referral_code: ownProfile.referral_code || null,
      rates,
      members,
      deposits: depositList,
      level_summary: levelSummary,
      stats: {
        team_members: members.length,
        active_referrals: members.filter((member) => member.active).length,
        inactive_referrals: members.filter((member) => !member.active).length,
        team_deposits: money(members.reduce((sum, member) => sum + member.total_deposits, 0)),
        commissions_earned: money((commissionRows || []).reduce((sum, row) => sum + Number(row.commission_amount || 0), 0))
      },
      commissions: (commissionRows || []).map((row) => ({
        amount: money(row.commission_amount),
        level: row.commission_level || 1,
        created_at: row.created_at
      })),
      truncated: { members: memberListTruncated, deposits: depositRowsTruncated }
    });
  } catch (error) {
    console.error('[APM-TEAM] Error:', error);
    return res.status(500).json({ error: 'Could not load team data' });
  }
}
