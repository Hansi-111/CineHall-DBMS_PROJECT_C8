/* ============================================================
   CINEHALL — shared UI helpers

   The localStorage mock that used to live here (DB.*, seed(),
   genCode(), requireAuth()) is gone: pages now talk to the API
   through api.js. What remains is presentation-only — DOM lookups,
   date/number formatting, the toast, and the seat-map renderer,
   which takes seats the API returned rather than generating them.
   ============================================================ */

/* ---------- helpers ---------- */
function qs(sel, root=document){ return root.querySelector(sel); }
function qsa(sel, root=document){ return [...root.querySelectorAll(sel)]; }
function fmtDate(iso){
  const d = new Date(iso+'T00:00:00');
  return d.toLocaleDateString('en-US', {weekday:'short', month:'short', day:'numeric'});
}
function toast(msg){
  let el = qs('.toast');
  if(!el){
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(()=>el.classList.remove('show'), 2400);
}
function getParam(name){ return new URLSearchParams(location.search).get(name); }

function initNavToggle(){
  const btn = qs('.nav-toggle'), links = qs('.nav-links');
  if(btn && links){ btn.addEventListener('click', ()=> links.classList.toggle('open')); }
}
function initSidebarToggle(){
  const btn = qs('.mobile-menu-btn'), side = qs('.admin-sidebar');
  if(btn && side){ btn.addEventListener('click', ()=> side.classList.toggle('open')); }
}

/* ---------- seat map generator ----------
   Takes the seats the seatmap endpoint returned — one object per
   physical seat, {id, label, row, number, afterAisle, tier, booked} —
   and renders them grouped by row. Nothing about the auditorium's
   layout is hardcoded here any more: rows, seats per row, the tier
   and the booked state all come from the server.
   Returns {getSelected() → seat objects, totalPrice() → rupees}. */
function buildSeatMap(container, show, seats, opts={}){
  let selected = new Set();
  const maxSelect = opts.maxSelect || 8;
  const priceFor = tier => show.price[tier] || 0;

  container.innerHTML = '';
  const rows = [...new Set(seats.map(s=>s.row))];

  rows.forEach(r=>{
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';
    const label = document.createElement('div');
    label.className = 'row-label'; label.textContent = r;
    rowEl.appendChild(label);

    let aislePlaced = false;
    seats.filter(s=>s.row===r).forEach(seat=>{
      /* afterAisle is true from the first seat past the centre gap,
         so the aisle divider is emitted once, just before it. */
      if(seat.afterAisle && !aislePlaced){
        const aisle = document.createElement('div');
        aisle.className = 'aisle';
        aisle.setAttribute('aria-hidden','true');
        rowEl.appendChild(aisle);
        aislePlaced = true;
      }

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'seat ' + (seat.tier==='premium' ? 'premium ' : '') + (seat.booked ? 'booked' : 'available');
      btn.textContent = seat.number;
      btn.dataset.seat = seat.label;
      btn.dataset.tier = seat.tier;
      btn.dataset.id = seat.id;
      btn.title = `${seat.label} · ${seat.tier} · ₹${priceFor(seat.tier)}`;
      if(!seat.booked){
        btn.addEventListener('click', ()=>{
          if(selected.has(seat.id)){
            selected.delete(seat.id); btn.classList.remove('selected');
          } else {
            if(selected.size >= maxSelect){ toast(`You can select up to ${maxSelect} seats`); return; }
            selected.add(seat.id); btn.classList.add('selected');
          }
          if(opts.onChange) opts.onChange(picked());
        });
      }
      rowEl.appendChild(btn);
    });
    container.appendChild(rowEl);
  });

  function picked(){
    return seats.filter(s=>selected.has(s.id));
  }

  return {
    getSelected: picked,
    totalPrice: () => picked().reduce((sum,s)=>sum + priceFor(s.tier), 0)
  };
}
