/* Renders the admin sidebar + guards the page behind a session check.
   Call renderAdminShell('dashboard') at the top of each admin page,
   passing the current page's key so the right sidebar link is active. */
function renderAdminShell(activeKey){
  const session = DB.getSession();
  if(!session || session.role !== 'admin'){
    location.href = 'admin-login.html';
    return null;
  }

  const links = [
  {key:'dashboard', href:'admin-dashboard.html', icon:'◧', label:'Dashboard'},
  {key:'movies', href:'admin-movies.html', icon:'▤', label:'Movies'},
  {key:'shows', href:'admin-shows.html', icon:'◷', label:'Showtimes'},
  {key:'bookings', href:'admin-bookings.html', icon:'🎟', label:'Bookings'}
];

  const shell = document.createElement('div');
  shell.className = 'admin-shell';
  shell.innerHTML = `
    <aside class="admin-sidebar">
      <a href="admin-dashboard.html" class="brand"><span class="brand-mark"></span>CineHall</a>
      ${links.map(l=>`<a href="${l.href}" class="side-link ${l.key===activeKey?'active':''}"><span>${l.icon}</span>${l.label}</a>`).join('')}
      <div class="side-foot">
        Signed in as ${session.name}<br>
        <a href="index.html" id="adminLogout" style="color:var(--gold);">Log out →</a>
      </div>
    </aside>
    <main class="admin-main">
      <div class="admin-topbar">
        <div style="display:flex; align-items:center; gap:12px;">
          <button class="mobile-menu-btn icon-btn">☰</button>
          <h1 class="admin-title" id="adminPageTitle"></h1>
        </div>
        <div id="adminTopbarRight"></div>
      </div>
      <div id="adminContent"></div>
    </main>
  `;
  document.body.prepend(shell);
  initSidebarToggle();

  document.getElementById('adminLogout').addEventListener('click', e=>{
    e.preventDefault(); DB.clearSession(); location.href = 'index.html';
  });

  return {
    setTitle(t){ document.getElementById('adminPageTitle').textContent = t; },
    content: document.getElementById('adminContent'),
    topbarRight: document.getElementById('adminTopbarRight')
  };
}
