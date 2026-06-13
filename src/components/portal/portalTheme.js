// Viewix Client Portal — scoped design token layer.
//
// Verbatim from the Claude Design handoff (project/index.html <style>).
// Injected as <style>{PORTAL_CSS}</style> inside the /clients/ portal root ONLY.
// Everything is scoped under `.vx` so it never touches the staff
// dashboard's dark theme in src/config.js (different DOM subtree, no
// global selectors). `.vx.dark` ships but stays internal-only (the user
// menu calls it out as such).
export const PORTAL_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600;700;800&display=swap');

.vx {
  --bg:        #ffffff;
  --bg-2:      #f4f5f9;
  --surface:   #ffffff;
  --surface-2: #f4f5f9;
  --surface-3: #ecedf2;
  --line:      #e1e3e9;
  --line-2:    #cbccd1;
  --line-3:    #b2b4bd;

  --text:      #0d1117;
  --text-2:    #4b5566;
  --text-3:    #7c8696;
  --text-4:    #a8b0bf;
  --heading:   #004f99;

  --accent:    #0082fa;
  --accent-2:  #006acc;
  --accent-soft: rgba(0,130,250,0.08);
  --accent-line: rgba(0,130,250,0.28);

  --orange:    #f87700;
  --orange-2:  #ae3a00;
  --orange-soft: rgba(248,119,0,0.10);
  --orange-line: rgba(248,119,0,0.30);

  --ok:        #1b9b6e;
  --ok-soft:   rgba(27,155,110,0.10);
  --warn:      var(--orange);
  --warn-soft: var(--orange-soft);
  --danger:    var(--orange);
  --danger-soft: var(--orange-soft);

  --r-sm: 6px;
  --r-md: 10px;
  --r-lg: 14px;
  --r-xl: 20px;

  color: var(--text);
  background: var(--bg);
  font-family: 'Montserrat', system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  letter-spacing: -0.005em;
  min-height: 100vh;
}
.vx.dark {
  --bg:        #07090e;
  --bg-2:      #0d111a;
  --surface:   #11151e;
  --surface-2: #181d28;
  --surface-3: #232a38;
  --line:      rgba(255,255,255,0.07);
  --line-2:    rgba(255,255,255,0.12);
  --line-3:    rgba(255,255,255,0.18);

  --text:      #e9ecf3;
  --text-2:    #9aa3b8;
  --text-3:    #626c82;
  --text-4:    #424a5c;
  --heading:   #e9ecf3;

  --accent:    #0082fa;
  --accent-2:  #4ba6ff;
  --accent-soft: rgba(0,130,250,0.16);
  --accent-line: rgba(0,130,250,0.36);

  --orange:    #f87700;
  --orange-2:  #ff8a1f;
  --orange-soft: rgba(248,119,0,0.16);
  --orange-line: rgba(248,119,0,0.36);
}
.vx, .vx * { box-sizing: border-box; }
.vx .mono {
  font-family: 'Montserrat', system-ui, sans-serif;
  font-weight: 600;
  font-feature-settings: "tnum" 1;
}

.vx-grid-bg {
  background-image:
    linear-gradient(to right, rgba(15,18,26,0.04) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(15,18,26,0.04) 1px, transparent 1px);
  background-size: 48px 48px;
}
.vx-grid-accent {
  background-image:
    linear-gradient(to right, rgba(255,255,255,0.10) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(255,255,255,0.10) 1px, transparent 1px);
  background-size: 48px 48px;
}

.vx input, .vx button, .vx textarea, .vx select {
  font: inherit; color: inherit; background: transparent;
  border: 0; outline: 0; margin: 0;
}
.vx button { cursor: pointer; }
.vx button:focus-visible, .vx a:focus-visible, .vx [role="button"]:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 2px;
}

.vx-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
.vx-scroll::-webkit-scrollbar-thumb { background: rgba(15,18,26,0.12); border-radius: 4px; }
.vx-scroll::-webkit-scrollbar-track { background: transparent; }

@keyframes vx-pulse { 0%,100% { opacity:.55 } 50% { opacity: 1 } }
.vx-pulse { animation: vx-pulse 2.2s ease-in-out infinite; }

.vx-glow { box-shadow: 0 0 0 1px rgba(28,132,237,0.32), 0 12px 38px -10px rgba(28,132,237,0.45); }

.vx-dot { width:6px; height:6px; border-radius:999px; display:inline-block; }
.vx-dot.live { background: var(--ok); box-shadow: 0 0 0 3px rgba(16,163,127,0.18); }
.vx-dot.pending { background: var(--warn); }
.vx-dot.muted { background: var(--text-3); }
.vx-dot.live-pulse { background: var(--ok); animation: vx-pulse 2s ease-in-out infinite; box-shadow: 0 0 0 4px rgba(16,163,127,0.14); }

.vx a { color: inherit; }
`;
