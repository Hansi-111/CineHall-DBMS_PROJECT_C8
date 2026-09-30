/* ============================================================
   CINEHALL — shared data layer & helpers
   Backed by localStorage so the front end is fully clickable
   without a server. Swap DB.* functions for real API calls
   once your backend/DB is wired up.
   ============================================================ */

const DB = {
  keys:{ movies:'ch_movies', shows:'ch_shows', bookings:'ch_bookings', session:'ch_session' },

  seed(){
    if(!localStorage.getItem(this.keys.movies)){
      const movies = [
        {id:'m1', title:'Neon Horizon', genre:'Sci-Fi', lang:'English', duration:128, rating:'UA', score:8.4, status:'now', synopsis:'A salvage pilot uncovers a signal that predates the colonies she was born into.'},
        {id:'m2', title:'Paper Tigers', genre:'Drama', lang:'Hindi', duration:142, rating:'U', score:7.9, status:'now', synopsis:'Three siblings return to their childhood home to settle a debt none of them can pay alone.'},
        {id:'m3', title:'Iron Monsoon', genre:'Action', lang:'Tamil', duration:151, rating:'UA', score:8.1, status:'now', synopsis:'A dismantled task force reassembles for one last job before the rains cut off the city.'},
        {id:'m4', title:'The Quiet Orbit', genre:'Thriller', lang:'English', duration:118, rating:'A', score:7.6, status:'now', synopsis:'A station engineer realizes the silence on the comms line is not a malfunction.'},
        {id:'m5', title:'Midnight Carousel', genre:'Fantasy', lang:'English', duration:134, rating:'U', score:8.7, status:'upcoming', synopsis:'A travelling fair appears only on the night of a blue moon, and only to those who need it.'},
        {id:'m6', title:'Ashes of Baroda', genre:'Historical', lang:'Hindi', duration:161, rating:'UA', score:8.9, status:'upcoming', synopsis:'A court painter documents a kingdom bracing for a war it cannot win.'},
      ];
      localStorage.setItem(this.keys.movies, JSON.stringify(movies));
    }
    if(!localStorage.getItem(this.keys.shows)){
      const cinemas = ['CineHall Downtown','CineHall Riverside'];
      const times = ['10:30 AM','1:45 PM','5:00 PM','8:30 PM','10:45 PM'];
      let shows = [], id=1;
      ['m1','m2','m3','m4'].forEach(mid=>{
        cinemas.forEach(cin=>{
          [0,1].forEach(dayOffset=>{
            const d = new Date(); d.setDate(d.getDate()+dayOffset);
            times.slice(0,3).forEach(t=>{
              shows.push({
                id:'s'+id++, movieId:mid, cinema:cin,
                date: d.toISOString().slice(0,10), time:t,
                price:{silver:150, gold:220, premium:320},
                bookedSeats: []
              });
            });
          });
        });
      });
      localStorage.setItem(this.keys.shows, JSON.stringify(shows));
    }
    if(!localStorage.getItem(this.keys.bookings)){
      localStorage.setItem(this.keys.bookings, JSON.stringify([]));
    }
  },

  getMovies(){ return JSON.parse(localStorage.getItem(this.keys.movies)||'[]'); },
  getMovie(id){ return this.getMovies().find(m=>m.id===id); },
  saveMovies(list){ localStorage.setItem(this.keys.movies, JSON.stringify(list)); },

  getShows(){ return JSON.parse(localStorage.getItem(this.keys.shows)||'[]'); },
  getShow(id){ return this.getShows().find(s=>s.id===id); },
  saveShows(list){ localStorage.setItem(this.keys.shows, JSON.stringify(list)); },
  showsForMovie(movieId){ return this.getShows().filter(s=>s.movieId===movieId); },

  getBookings(){ return JSON.parse(localStorage.getItem(this.keys.bookings)||'[]'); },
  saveBookings(list){ localStorage.setItem(this.keys.bookings, JSON.stringify(list)); },

  addBooking(booking){
    const list = this.getBookings();
    list.unshift(booking);
    this.saveBookings(list);
    const shows = this.getShows();
    const show = shows.find(s=>s.id===booking.showId);
    if(show){ show.bookedSeats.push(...booking.seats); this.saveShows(shows); }
  },

  cancelBooking(bookingId){
    const bookings = this.getBookings();
    const booking = bookings.find(b=>b.id===bookingId);
    if(!booking || booking.status==='cancelled') return null;
    booking.status = 'cancelled';
    this.saveBookings(bookings);
    const shows = this.getShows();
    const show = shows.find(s=>s.id===booking.showId);
    if(show){ show.bookedSeats = show.bookedSeats.filter(s=>!booking.seats.includes(s)); this.saveShows(shows); }
    return booking;
  },

  setSession(session){ localStorage.setItem(this.keys.session, JSON.stringify(session)); },
  getSession(){ return JSON.parse(localStorage.getItem(this.keys.session)||'null'); },
  clearSession(){ localStorage.removeItem(this.keys.session); }
};

DB.seed();

/* ---------- helpers ---------- */
function qs(sel, root=document){ return root.querySelector(sel); }
function qsa(sel, root=document){ return [...root.querySelectorAll(sel)]; }
function fmtDate(iso){
  const d = new Date(iso+'T00:00:00');
  return d.toLocaleDateString('en-US', {weekday:'short', month:'short', day:'numeric'});
}
function genCode(){
  return 'CH-' + Math.random().toString(36).slice(2,6).toUpperCase() + '-' + Math.floor(1000+Math.random()*9000);
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

/* Redirects to login if no customer is signed in, remembering the page
   the user was trying to reach so login.html can send them back.
   Returns true if signed in (safe to keep rendering), false otherwise. */
function requireAuth(){
  const session = DB.getSession();
  if(session && session.role==='customer'){ return true; }
  sessionStorage.setItem('ch_redirect_after_login', location.href);
  toast('Please sign in to book tickets');
  location.href = 'login.html';
  return false;
}

function initNavToggle(){
  const btn = qs('.nav-toggle'), links = qs('.nav-links');
  if(btn && links){ btn.addEventListener('click', ()=> links.classList.toggle('open')); }
}
function initSidebarToggle(){
  const btn = qs('.mobile-menu-btn'), side = qs('.admin-sidebar');
  if(btn && side){ btn.addEventListener('click', ()=> side.classList.toggle('open')); }
}

/* ---------- seat map generator ----------
   rows A-H, 10 seats each, split 5 | gap | 5 by a centre aisle.
   Rows G-H = premium, C-E = gold, A-B = silver.
   Renders into a container, returns {getSelected(), totalPrice()} */
function buildSeatMap(container, show, opts={}){
  const rows = ['A','B','C','D','E','F','G','H'];
  const seatsPerRow = 10;
  const aisleAfter = 5;
  const tierFor = r => ['G','H'].includes(r) ? 'premium' : ['C','D','E'].includes(r) ? 'gold' : 'silver';
  let selected = new Set();
  const maxSelect = opts.maxSelect || 8;

  container.innerHTML = '';
  rows.forEach(r=>{
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';
    const label = document.createElement('div');
    label.className = 'row-label'; label.textContent = r;
    rowEl.appendChild(label);
    for(let n=1; n<=seatsPerRow; n++){
      const seatId = `${r}${n}`;
      const tier = tierFor(r);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'seat ' + (tier==='premium' ? 'premium ' : '') + (show.bookedSeats.includes(seatId) ? 'booked' : 'available');
      btn.textContent = n;
      btn.dataset.seat = seatId;
      btn.dataset.tier = tier;
      btn.title = `${seatId} · ${tier} · ₹${show.price[tier]}`;
      if(!show.bookedSeats.includes(seatId)){
        btn.addEventListener('click', ()=>{
          if(selected.has(seatId)){
            selected.delete(seatId); btn.classList.remove('selected');
          } else {
            if(selected.size >= maxSelect){ toast(`You can select up to ${maxSelect} seats`); return; }
            selected.add(seatId); btn.classList.add('selected');
          }
          if(opts.onChange) opts.onChange([...selected]);
        });
      }
      rowEl.appendChild(btn);
      if(n === aisleAfter){
        const aisle = document.createElement('div');
        aisle.className = 'aisle';
        aisle.setAttribute('aria-hidden','true');
        rowEl.appendChild(aisle);
      }
    }
    container.appendChild(rowEl);
  });

  return {
    getSelected: () => [...selected],
    totalPrice: () => [...selected].reduce((sum,s)=>{
      const r = s[0]; return sum + show.price[tierFor(r)];
    }, 0),
    tierFor
  };
}
