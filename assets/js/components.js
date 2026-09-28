import { supabase } from './apm-client.js';

const current = (location.pathname.split('/').pop() || 'dashboard.html');

function headerHTML() {
  return `
    <header class="apm-header">
      <a href="/dashboard.html" class="apm-logo">
        <span class="coin">A</span> APM<span class="bolt">⚡</span>
      </a>
      <div class="header-right">
        <span class="tier-badge" id="shell-tier">A0</span>
        <span class="wallet-chip" id="shell-balance"><i class="fa-solid fa-wallet"></i> ₦0</span>
      </div>
    </header>`;
}

function navHTML() {
  const item = (href, icon, label, extra = '') => `
    <a href="${href}" class="${current === href.replace('/', '') ? 'active' : ''} ${extra}">
      ${extra === 'center' ? `<span class="nav-bubble"><i class="${icon}"></i></span>` : `<i class="${icon}"></i>`}
      <span>${label}</span>
    </a>`;
  return `
    <nav class="apm-nav">
      ${item('/dashboard.html', 'fa-solid fa-house', 'Home')}
      ${item('/wealth.html', 'fa-solid fa-gem', 'Wealth')}
      ${item('/tasks.html', 'fa-solid fa-hand-pointer', 'Tasks', 'center')}
      ${item('/team.html', 'fa-solid fa-users', 'Team')}
      ${item('/profile.html', 'fa-solid fa-user', 'Profile')}
    </nav>`;
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
  refreshShell();
  supabase.auth.onAuthStateChange(() => refreshShell());
}

window.APMShell = { refresh: refreshShell };
init();
