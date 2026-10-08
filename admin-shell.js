/* ============================================================
   CINEHALL — admin shell

   Builds the sidebar/topbar around the admin pages and guards them.
   Call renderAdminShell('dashboard') at the top of each admin page,
   passing the page key so the matching sidebar link is active.
   Returns null (and has already redirected) when the visitor is not
   signed-in staff, so callers just do `const ui = renderAdminShell(...);
   if(!ui) return;`.

   Depends on api.js (api.requireStaff/user/clearSession) and the
   qs/initSidebarToggle helpers from script.js, both loaded first.
   ============================================================ */
function renderAdminShell(activeKey){
  /* requireStaff clears a customer session and sends it to the staff
     login; it returns true only for theater_admin/system_admin. */
  if(!api.requireStaff()) return null;

  const session = api.user();

  const links = [
    {key:'dashboard', href:'admin-dashboard.html', icon:'◧', label:'Dashboard'},
    {key:'movies',    href:'admin-movies.html',    icon:'▤', label:'Movies'},
    {key:'shows',     href:'admin-shows.html',     icon:'◷', label:'Showtimes'},
    {key:'bookings',  href:'admin-bookings.html',  icon:'🎟', label:'Bookings'}
  ];

  const shell = document.createElement('div');
  shell.className = 'admin-shell';
  shell.innerHTML = `
    <aside class="admin-sidebar">
      <a href="admin-dashboard.html" class="brand"><span class="brand-mark"></span>CineHall</a>
      ${links.map(l=>`<a href="${l.href}" class="side-link ${l.key===activeKey?'active':''}"><span>${l.icon}</span>${l.label}</a>`).join('')}
      <div class="side-foot">
        Signed in as ${escapeHtml(session.name)}<br>
        <span class="muted" style="font-size:.72rem;">${escapeHtml(session.role)}</span><br>
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
    e.preventDefault();
    api.clearSession();
    location.href = 'admin-login.html';
  });

  return {
    setTitle(t){ document.getElementById('adminPageTitle').textContent = t; },
    content: document.getElementById('adminContent'),
    topbarRight: document.getElementById('adminTopbarRight')
  };
}