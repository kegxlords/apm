import { supabase } from './apm-client.js';

export { supabase };

export async function requireAuth() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    window.location.href = '/login.html';
    throw new Error('Not authenticated');
  }
  return user;
}

export async function requireAdmin() {
  const user = await requireAuth();
  const { data: profile } = await supabase
    .from('profiles')
    .select('is_admin')
    .eq('id', user.id)
    .single();
  if (!profile?.is_admin) {
    window.location.href = '/dashboard.html';
    throw new Error('Not admin');
  }
  return user;
}
