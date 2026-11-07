import { supabase } from './apm-client.js';

const current = (location.pathname.split('/').pop() || 'dashboard.html');

function headerHTML() {
  return `
    <header class="ops-topbar">
      <a href="/dashboard.html" class="apm-logo"><span class="coin">3M</span><span><b>3M</b><small>MINING OPERATIONS</small></span></a>
      <div class="ops-status"><span class="status-dot"></span><span>LIVE FLEET MONITOR</span></div>
      <div class="header-right">
        <span class="tier-badge" id="shell-tier">A0</span>
        <span class="wallet-chip" id="shell-balance"><i class="fa-solid fa-wallet"></i> ₦0</span>
      </div>
    </header>`;
}
function navHTML() {
  const item = (href, icon, label, extra = '') => `
    <a href="${href}" class="ops-nav-item ${current === href.replace('/', '') ? 'active' : ''} ${extra}">
      <span class="nav-icon"><i class="${icon}"></i></span><span>${label}</span>
    </a>`;
  return `
    <aside class="ops-sidebar">
      <div class="sidebar-kicker">OPERATIONS CONSOLE</div>
      <nav>
        ${item('/dashboard.html', 'fa-solid fa-grid-2', 'Overview')}
        ${item('/tasks.html', 'fa-solid fa-screwdriver-wrench', 'Machine Bay')}
        ${item('/wallet.html', 'fa-solid fa-wallet', 'Wallet')}
        ${item('/deposit.html', 'fa-solid fa-arrow-down', 'Fund Operations')}
        ${item('/withdraw.html', 'fa-solid fa-arrow-up', 'Withdraw Rewards')}
        ${item('/wealth.html', 'fa-solid fa-chart-line', 'Growth Plans')}
        ${item('/membership.html', 'fa-solid fa-layer-group', 'Access Tier')}
        ${item('/team.html', 'fa-solid fa-users', 'Crew Network')}
        ${item('/salary.html', 'fa-solid fa-money-bill-trend-up', 'Salary')}
      </nav>
      <div class="sidebar-footer"><i class="fa-solid fa-shield-halved"></i><span>SECURE WORKSPACE<br><b>3M NORTHSTAR</b></span></div>
    </aside>
    <nav class="ops-mobile-nav">
      ${item('/dashboard.html', 'fa-solid fa-house', 'Home')}
      ${item('/membership.html', 'fa-solid fa-screwdriver-wrench', 'Machines', 'mobile-primary')}
      ${item('/wallet.html', 'fa-solid fa-wallet', 'Wallet')}
      ${item('/salary.html', 'fa-solid fa-money-bill-trend-up', 'Salary')}
      ${item('/profile.html', 'fa-solid fa-user', 'Profile')}
    </nav>`;
}

function renderImpersonationBanner() {
  if (!sessionStorage.getItem('apm_impersonator_session')) return;
  const banner = document.createElement('div');
  banner.id = 'apm-impersonation-banner';
  banner.style.cssText = 'position:fixed;z-index:9999;top:0;left:0;right:0;padding:10px 16px;background:#7c2d12;color:#fff;display:flex;align-items:center;justify-content:center;gap:12px;font:700 13px/1.3 Inter,system-ui,sans-serif;box-shadow:0 2px 12px rgba(0,0,0,.25)';
  banner.innerHTML = '<span><i class="fa-solid fa-user-secret"></i> You are viewing this account as an administrator.</span><button id="apm-return-admin" style="border:1px solid rgba(255,255,255,.7);border-radius:6px;background:transparent;color:#fff;padding:6px 10px;font-weight:700;cursor:pointer">Return to admin</button>';
  document.body.prepend(banner);
  document.body.style.paddingTop = '44px';
  document.getElementById('apm-return-admin').addEventListener('click', async () => {
    const raw = sessionStorage.getItem('apm_impersonator_session');
    try {
      const session = JSON.parse(raw || '{}');
      if (!session.access_token || !session.refresh_token) throw new Error('Saved admin session is unavailable');
      await supabase.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
      sessionStorage.removeItem('apm_impersonator_session');
      sessionStorage.removeItem('apm_impersonator_admin_email');
      window.location.assign('/safe/hide/private/admin.html');
    } catch (error) {
      console.error('[APM] Could not restore admin session:', error);
      alert('The saved admin session has expired. Please sign in again.');
    }
  });
}

async function refreshShell() {
  const tierEl = document.getElementById('shell-tier');
  const balEl = document.getElementById('shell-balance');
  if (!tierEl && !balEl) return;

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    tierEl?.remove(); balEl?.remove();
    return;
  }

  const [{ data: profile }, { data: wallet }] = await Promise.all([
    supabase.from('profiles').select('tier').eq('id', user.id).single(),
    supabase.from('wallets').select('balance').eq('user_id', user.id).single()
  ]);

  if (tierEl) {
    const tier = profile?.tier || 'A0';
    tierEl.textContent = tier;
    tierEl.classList.toggle('paid', tier !== 'A0');
  }
  if (balEl) {
    balEl.innerHTML = `<i class="fa-solid fa-wallet"></i> ₦${Number(wallet?.balance || 0).toLocaleString()}`;
  }
}

function init() {
  const header = document.getElementById('header-container');
  const footer = document.getElementById('footer-container');
  if (header) header.outerHTML = headerHTML();
  if (footer) footer.outerHTML = navHTML();
  renderImpersonationBanner();
  refreshShell();
  supabase.auth.onAuthStateChange(() => refreshShell());
}

window.APMShell = { refresh: refreshShell };
init();
