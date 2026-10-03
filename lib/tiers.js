import supabaseAdmin from './supabase.js';

export async function getTierConfig(tier) {
  const { data } = await supabaseAdmin.from('apm_tiers').select('*').eq('tier', tier).single();
  return data || { tier, upgrade_cost: 0, expiry_days: 0, daily_task_limit: 0, task_bonus: 0 };
}

// Lazily downgrade expired tiers; returns the fresh profile
export async function ensureTierActive(profile) {
  if (!profile) return profile;
  if (profile.tier && profile.tier !== 'A0' && profile.tier_expires_at) {
    if (new Date(profile.tier_expires_at).getTime() < Date.now()) {
      await supabaseAdmin.from('profiles')
        .update({ tier: 'A0', tier_expires_at: null })
        .eq('id', profile.id);
      return { ...profile, tier: 'A0', tier_expires_at: null, just_expired: true };
    }
  }
  return profile;
}

// 0 or less = lifetime (null)
export function tierExpiryFromNow(expiryDays) {
  const days = Number(expiryDays || 0);
  if (!days || days <= 0) return null;
  return new Date(Date.now() + days * 86400000).toISOString();
}
