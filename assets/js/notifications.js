(function () {
  function container() {
    let el = document.getElementById('toast-container');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast-container';
      document.body.appendChild(el);
    }
    return el;
  }

  const ICONS = {
    success: 'fa-solid fa-circle-check',
    gold: 'fa-solid fa-crown',
    error: 'fa-solid fa-circle-exclamation',
    info: 'fa-solid fa-circle-info'
  };

  window.showToast = function (message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<i class="${ICONS[type] || ICONS.info}"></i><span>${message}</span>`;
    container().appendChild(toast);
    setTimeout(() => {
      toast.classList.add('leaving');
      setTimeout(() => toast.remove(), 250);
    }, 3200);
  };
})();
