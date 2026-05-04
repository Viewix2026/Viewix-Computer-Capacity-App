import { useState, useMemo, useEffect, useRef, lazy, Suspense } from "react";
import { initFB, onFB, fbSet, fbListen, onAuthReady, signOutUser, authFetch } from "./firebase";
import { fetchMondayUsers, fetchActiveProjectCount, fetchInProgressParents } from "./monday";
import {
  DEFAULT_MONDAY_EDITORS, CONTENT_CATEGORIES, CAT_COLORS,
  VIEWIX_STATUSES, VIEWIX_STATUS_COLORS, CLIENT_REVISION_OPTIONS, CLIENT_REVISION_COLORS,
  DEFAULT_TRAINING, DK, DL, QT, DEF_EDS, DEF_IN,
  QUOTE_SECTIONS, OUTPUT_PRESETS, FILMING_DEFAULTS, EDITING_DEFAULTS,
  DEFAULT_RATE_CARDS, TH, TD, NB, BTN, CSS
} from "./config";
import {
  todayKey, tomorrowKey, getMonday, wKey, fmtD, fmtRange, fmtLabel,
  dayDates, addW, fmtSecs, fmtSecsShort, categorizeContent,
  doCalc, pct, fmtCur, sCol, gSC, dayVal, nextState,
  newDelivery, newVideo, newVideoId, logoBg, makeShortId, deliveryShareUrl
} from "./utils";
import { Logo } from "./components/Logo";
import { Badge, Metric, NumIn, UBar, FChart, StatusSelect, SideIcon } from "./components/UIComponents";
import { Grid } from "./components/Grid";
import { ErrorBoundary } from "./components/ErrorBoundary";
// Eager imports — needed on first render or tiny enough that lazy-load
// adds more cost (in extra HTTP round-trips) than it saves.
import { QuoteCalc, newQuote } from "./components/QuoteCalc";
import { Home } from "./components/Home";
import { Login } from "./components/Login";

// Lazy imports — heavy tab components only mount when their tool is
// active. Cuts the initial JS payload roughly in half.
const Sale                     = lazy(() => import("./components/Sale").then(m => ({ default: m.Sale })));
const SalePublicView           = lazy(() => import("./components/SalePublicView").then(m => ({ default: m.SalePublicView })));
const EditorDashboard          = lazy(() => import("./components/EditorDashboard").then(m => ({ default: m.EditorDashboard })));
const AccountsDashboard        = lazy(() => import("./components/AccountsDashboard").then(m => ({ default: m.AccountsDashboard })));
const Founders                 = lazy(() => import("./components/Founders").then(m => ({ default: m.Founders })));
const Capacity                 = lazy(() => import("./components/Capacity").then(m => ({ default: m.Capacity })));
const Projects                 = lazy(() => import("./components/Projects").then(m => ({ default: m.Projects })));
const Training                 = lazy(() => import("./components/Training").then(m => ({ default: m.Training })));
const DeliveryPublicView       = lazy(() => import("./components/DeliveryPublicView").then(m => ({ default: m.DeliveryPublicView })));
const Preproduction            = lazy(() => import("./components/Preproduction").then(m => ({ default: m.Preproduction })));
const PreproductionPublicView  = lazy(() => import("./components/PreproductionPublicView").then(m => ({ default: m.PreproductionPublicView })));
const RoasCalculator           = lazy(() => import("./components/RoasCalculator").then(m => ({ default: m.RoasCalculator })));
const RoasCalculatorPublicView = lazy(() => import("./components/RoasCalculator").then(m => ({ default: m.RoasCalculatorPublicView })));
const Nurture                  = lazy(() => import("./components/Nurture").then(m => ({ default: m.Nurture })));

export default function App(){
  const[role,setRole]=useState(null); // "founder" | "closer"
  const[loading,setLoading]=useState(true);
  const[tool,setTool]=useState("home");
  const[capTab,setCapTab]=useState("dashboard");
  const[foundersTab,setFoundersTab]=useState("dashboard");
  const[resourceTab,setResourceTab]=useState("roas");
  const[saleTab,setSaleTab]=useState("payment");
  const[nurtureTab,setNurtureTab]=useState("lapsed");

  // ─── Hash-based deep-linking ───────────────────────────────────────
  // Format: #<tool>[/<subTab>][/<recordId>]
  //   #preproduction/socialOrganic/social_1234   → opens that project
  //   #preproduction/runsheets/rs-1234           → opens that runsheet
  //   #projects/deliveries/del-1234              → opens that delivery
  //   #accounts/acct-1234                        → highlights that account
  // (The old #sherpas/cl-1234 deep-link was removed when the Sherpas
  // tab dissolved — sherpa docs now open inline from Projects /
  // Accounts / EditorDashboardViewix via findSherpaDocUrl().)
  // Each tab component reads `route` as a prop and reacts on mount or
  // when the recordId changes. Click handlers anywhere in the app set
  // window.location.hash and the listener below propagates state.
  const[route,setRoute]=useState({tool:null,subTab:null,recordId:null});
  useEffect(()=>{
    const apply=()=>{
      const h=(window.location.hash||"").replace(/^#/,"");
      if(!h){setRoute({tool:null,subTab:null,recordId:null});return;}
      const parts=h.split("/");
      const next={tool:parts[0]||null,subTab:parts[1]||null,recordId:parts[2]||null};
      setRoute(next);
      if(next.tool)setTool(next.tool);
    };
    apply();
    window.addEventListener("hashchange",apply);
    return()=>window.removeEventListener("hashchange",apply);
  },[]);

  // Side-effect: when the hash points to a Sherpa or Account row, scroll
  // the matching DOM node into view shortly after the tab paints. The
  // 250ms delay covers the lazy-load Suspense boundary on Accounts /
  // first paint of the Sherpas list. Idempotent; fires once per route
  // change.
  useEffect(()=>{
    if(!route.tool||!route.subTab)return;
    if(route.tool!=="accounts")return;
    const id=`account-row-${route.subTab}`;
    const t=setTimeout(()=>{
      const el=document.getElementById(id);
      if(el)el.scrollIntoView({behavior:"smooth",block:"center"});
    },250);
    return()=>clearTimeout(t);
  },[route.tool,route.subTab]);

  // Sale (Payment Intake) state — records at /sales, defaults at /salePricing,
  // per-package thank-you content at /saleThankYou (booking link + welcome
  // video + next-steps copy shown to customer after payment clears).
  const[sales,setSales]=useState([]);
  const[salePricing,setSalePricing]=useState(null);
  const[saleThankYou,setSaleThankYou]=useState(null);

  // Capacity state
  const[inputs,setInputs]=useState(DEF_IN);
  const[editors,setEditors]=useState(DEF_EDS);
  const[weekData,setWeekData]=useState({});
  const[curW,setCurW]=useState(wKey(getMonday(new Date())));
  const[scMode,setScMode]=useState(false);const[scIn,setScIn]=useState(null);

  // Quoting state
  const[quotes,setQuotes]=useState([]);
  const[activeQuoteId,setActiveQuoteId]=useState(null);
  const[clientRateCards,setClientRateCards]=useState([]);
  const[clientFilter,setClientFilter]=useState("");
  const[qTab,setQTab]=useState("quotes"); // "quotes" | "ratecards"
  const[rcAdding,setRcAdding]=useState(false);
  const[rcNewName,setRcNewName]=useState("");
  const[rcEditId,setRcEditId]=useState(null);
  const[rcConfirmDelete,setRcConfirmDelete]=useState(null);
  const[rcShowArchive,setRcShowArchive]=useState(false);
  const rcAddRef=useRef(null);

  // Clients state
  const[clients,setClients]=useState([]);
  const[clientAdding,setClientAdding]=useState(false);
  const[clientNewName,setClientNewName]=useState("");
  const[clientNewDoc,setClientNewDoc]=useState("");
  const[clientEditId,setClientEditId]=useState(null);
  const[clientEditName,setClientEditName]=useState("");
  const[clientEditDoc,setClientEditDoc]=useState("");

  // Deliveries state
  const[deliveries,setDeliveries]=useState([]);

  // Projects state — /projects/{id} records created by the Attio webhook
  // (api/webhook-deal-won.js Section 4b). Listener-only: writes happen
  // direct to Firebase from Projects.jsx to avoid the debounced bulk-write
  // clobbering webhook-created records that haven't hit local state yet.
  const[projects,setProjects]=useState([]);
  const[mondayEditorList,setMondayEditorList]=useState(DEFAULT_MONDAY_EDITORS);

  // Buyer Journey state
  const[buyerJourney,setBuyerJourney]=useState({});

  // Accounts state
  const[accounts,setAccounts]=useState({});
  const[turnaround,setTurnaround]=useState({});

  // Training state
  const[trainingData,setTrainingData]=useState(DEFAULT_TRAINING);
  const[trainingSuggestions,setTrainingSuggestions]=useState([]);
  const[activeModuleId,setActiveModuleId]=useState(null);
  const[trainingSubTab,setTrainingSubTab]=useState("modules"); // "modules" | "meetingFeedback"

  // To Do list state
  const[todos,setTodos]=useState([]);
  const[todoNewText,setTodoNewText]=useState("");
  const[todoNewAssignee,setTodoNewAssignee]=useState("Jeremy");
  const[todoNewCategory,setTodoNewCategory]=useState("General");
  const[todoFilter,setTodoFilter]=useState("all");

  // Home state
  const[teamLunch,setTeamLunch]=useState(null);

  // Founders state
  const[foundersData,setFoundersData]=useState({});
  const[foundersMetrics,setFoundersMetrics]=useState({});
  const[attioDeals,setAttioDeals]=useState(null);
  const[attioLoading,setAttioLoading]=useState(false);
  const[revenueTableExpanded,setRevenueTableExpanded]=useState(false);

  // Merge default + custom rate cards, filtering out hidden defaults
  const rcArr=Array.isArray(clientRateCards)?clientRateCards:[];
  const hiddenIds=rcArr.filter(c=>c&&c.deleted).map(c=>c.id.replace("del-",""));
  const visibleDefaults=DEFAULT_RATE_CARDS.filter(d=>!hiddenIds.includes(d.id));
  const customOnly=rcArr.filter(c=>c&&!c.deleted&&!c.archived);
  const archivedCards=rcArr.filter(c=>c&&c.archived);
  const allRateCards=[...visibleDefaults,...customOnly];

  const skipWrite=useRef(true);
  const skipRead=useRef(false);

  // Session restore: if Firebase auth has a persisted user, restore the role immediately.
  useEffect(()=>{
    initFB();
    onAuthReady(restoredRole=>{
      if(restoredRole)setRole(restoredRole);
    });
  },[]);

  const isFounder=role==="founder"||role==="founders";
  const isFounders=role==="founders";
  const isLead=role==="lead";

  // Firebase data listeners — gated on auth being ready so the root listener
  // doesn't attach before the auth token is available (prevents listener lockout
  // once security rules are applied).
  // Re-attach the root listener whenever the role changes (null -> signed-in).
  // Post-rules, an anonymous listener would be denied and never retry, so we
  // defer the attach until the user is actually signed in with a role.
  useEffect(()=>{
    if(!role)return;
    initFB();
    const fallback=setTimeout(()=>{setLoading(false);skipWrite.current=false;},3000);
    const unsubs=[];
    // `cancelled` guard: if role changes (logout → login-as-other-role)
    // before onFB resolves, the cleanup captures the initial noop unsub
    // and the real listener attached inside onFB leaks. Checking the
    // flag inside onFB blocks the attach.
    let cancelled=false;
    onFB(()=>{
      if(cancelled)return;
      const markLoaded=()=>{clearTimeout(fallback);setLoading(false);setTimeout(()=>{skipWrite.current=false;},500);};
      // Track which paths have had their initial fire delivered. The
      // skipRead guard exists to swallow listener echoes from our own
      // bulk-writes, NOT to drop initial data — which is exactly what
      // happens if the very first fire for a path lands inside a
      // skipRead window (e.g. PR #4's videoId migration triggers many
      // /deliveries echoes that overlap the late-arriving /accounts and
      // /sales initial fires). Realtime DB's `on('value')` doesn't
      // re-deliver missed initials, so once dropped, the state stays
      // empty until something else writes. Always letting the first
      // fire through closes that gap; later fires keep the echo guard.
      const firstFireSeen=new Set();
      const listen=(path,apply)=>{
        const off=fbListen(path,(data)=>{
        const isInitial=!firstFireSeen.has(path);
        if(isInitial)firstFireSeen.add(path);
        if(!isInitial&&skipRead.current)return;
        try{
          apply(data);
        }catch(e){console.error("Firebase data parse error:",path,e);}
        markLoaded();
        },e=>{console.error("Firebase listener denied:",path,e);markLoaded();});
        unsubs.push(off);
      };
      listen("/inputs",data=>{if(data)setInputs(prev=>({...prev,...data}));});
      listen("/editors",data=>{if(data&&Array.isArray(data))setEditors(data);});
      listen("/weekData",data=>{if(data)setWeekData(data);});
      listen("/quotes",data=>{
        if(data){
          const qArr=Object.values(data).filter(q=>q&&q.id&&q.items);
          setQuotes(qArr);
        }
      });
      listen("/clientRateCards",data=>{if(data)setClientRateCards(Object.values(data).filter(r=>r&&r.id));});
      listen("/clients",data=>{if(data)setClients(Object.values(data).filter(c=>c&&c.id));});
      listen("/deliveries",data=>{if(data)setDeliveries(Object.values(data).filter(d=>d&&d.id).map(d=>({...d,videos:Array.isArray(d.videos)?d.videos:[]})));});
      listen("/projects",data=>{setProjects(data?Object.values(data).filter(p=>p&&p.id):[]);});
      listen("/buyerJourney",data=>{if(data)setBuyerJourney(data);});
      listen("/accounts",data=>{if(data)setAccounts(data);});
      listen("/turnaround",data=>{if(data)setTurnaround(data);});
      listen("/mondayEditors",data=>{if(data&&Array.isArray(data))setMondayEditorList(data);});
      listen("/training",data=>{if(data&&Array.isArray(data))setTrainingData(data);});
      listen("/trainingSuggestions",data=>{if(data&&Array.isArray(data))setTrainingSuggestions(data);});
      listen("/todos",data=>{if(data)setTodos((Array.isArray(data)?data.filter(Boolean):Object.values(data).filter(Boolean)));});
      listen("/foundersMetrics",data=>{if(data)setFoundersMetrics(data);});
      listen("/teamLunch",data=>{if(data)setTeamLunch(data);});
      if(isFounders)listen("/foundersData",data=>{if(data)setFoundersData(data);});
      listen("/sales",data=>{setSales(data?Object.values(data).filter(s=>s&&s.id):[]);});
      listen("/salePricing",data=>{if(data)setSalePricing(data);});
      listen("/saleThankYou",data=>{if(data)setSaleThankYou(data);});
      listen("/attioCache",data=>{if(data&&data.data)setAttioDeals({data:data.data,total:data.total||data.data.length,lastSyncedAt:data.lastSyncedAt||null});});
    });
    return()=>{cancelled=true;clearTimeout(fallback);unsubs.forEach(u=>u());};
  },[role,isFounders]);

  const wt=useRef(null);
  const deletedPaths=useRef([]);
  useEffect(()=>{if(skipWrite.current)return;if(wt.current)clearTimeout(wt.current);skipRead.current=true;wt.current=setTimeout(()=>{try{fbSet("/inputs",inputs);fbSet("/editors",editors);fbSet("/weekData",weekData);const qObj={};quotes.forEach(q=>{if(q&&q.id)qObj[q.id]=q;});fbSet("/quotes",qObj);const rcObj={};rcArr.forEach(r=>{if(r&&r.id)rcObj[r.id]=r;});fbSet("/clientRateCards",rcObj);clients.forEach(c=>{if(c&&c.id)fbSet("/clients/"+c.id,c);});deliveries.forEach(d=>{if(d&&d.id)fbSet("/deliveries/"+d.id,d);});fbSet("/training",trainingData);fbSet("/trainingSuggestions",trainingSuggestions);const tObj={};todos.forEach(t=>{if(t&&t.id)tObj[t.id]=t;});fbSet("/todos",tObj);fbSet("/foundersMetrics",foundersMetrics);if(teamLunch)fbSet("/teamLunch",teamLunch);if(isFounders)fbSet("/foundersData",foundersData);fbSet("/buyerJourney",buyerJourney);Object.entries(accounts).forEach(([k,v])=>{if(v&&v.id)fbSet("/accounts/"+k,v);});fbSet("/turnaround",turnaround);/* Sales intentionally NOT written from the bulk-write loop. Sales
   are append-only from the dashboard side: created via Sale.jsx's
   direct fbSetAsync at save-time, deleted via Sale.jsx's explicit
   fbSetAsync(null), updated only by the server (Stripe webhook
   adminPatch). Bulk-writing them would clobber server-owned fields
   (schedule slice status, stripePaymentMethodId, etc.) any time
   the dashboard's listener missed an update due to skipRead window. */if(salePricing)fbSet("/salePricing",salePricing);if(saleThankYou)fbSet("/saleThankYou",saleThankYou);deletedPaths.current.forEach(p=>fbSet(p,null));deletedPaths.current=[];}catch(e){console.error("Firebase write error:",e);}setTimeout(()=>{skipRead.current=false;},500);},400);return()=>{if(wt.current){clearTimeout(wt.current);wt.current=null;}};},[inputs,editors,weekData,quotes,clientRateCards,clients,deliveries,trainingData,trainingSuggestions,todos,teamLunch,foundersData,buyerJourney,accounts,turnaround,foundersMetrics,isFounders,sales,salePricing,saleThankYou]);

  // Backfill shortId on existing deliveries (one-time per record). Also handles
  // dedup if two records ever generate the same hash.
  useEffect(()=>{if(!deliveries.length)return;const used=new Set();let changed=false;const next=deliveries.map(d=>{if(!d)return d;if(d.shortId&&!used.has(d.shortId)){used.add(d.shortId);return d;}let id=d.shortId||makeShortId();while(used.has(id))id=makeShortId();used.add(id);if(id!==d.shortId){changed=true;return{...d,shortId:id};}return d;});if(changed)setDeliveries(next);},[deliveries.length]);

  // Backfill canonical videoId on delivery videos and the matching
  // project subtask (source: "video"). The canonical id is what
  // cross-system automations use to resolve subtask <-> video without
  // name matching, which broke every time a producer renamed something.
  // Idempotent — only stamps records currently lacking a videoId, so
  // re-runs are safe. Pre-prod scriptTable backfill is intentionally
  // out of scope: the pre-prod approval flow now stamps matching ids
  // for new approvals, and #2's automation only needs the
  // subtask <-> delivery linkage.
  const videoIdBackfilled = useRef(false);
  useEffect(() => {
    if (videoIdBackfilled.current) return;
    if (!projects.length || !deliveries.length) return;
    videoIdBackfilled.current = true;
    const delById = new Map(deliveries.map(d => [d.id, d]));
    projects.forEach(p => {
      const delId = (p?.links || {}).deliveryId;
      if (!delId) return;
      const del = delById.get(delId);
      if (!del || !Array.isArray(del.videos)) return;
      const subtasks = Object.values(p.subtasks || {}).filter(Boolean);
      del.videos.forEach((vid, idx) => {
        if (!vid) return;
        let videoId = vid.videoId;
        if (!videoId) {
          videoId = newVideoId();
          fbSet(`/deliveries/${delId}/videos/${idx}/videoId`, videoId);
        }
        // Find a video-source subtask in the same project with a
        // matching name and no videoId yet, stamp the canonical id.
        // Name matching is the legacy linkage we're upgrading away
        // from — it's only relied on once, here, during backfill.
        const target = subtasks.find(st =>
          !st.videoId &&
          (st.source === "video" || st.source === "revision") &&
          (st.name || "").trim().toLowerCase() === (vid.name || "").trim().toLowerCase()
        );
        if (target) {
          fbSet(`/projects/${p.id}/subtasks/${target.id}/videoId`, videoId);
        }
      });
    });
  }, [projects, deliveries]);

  // Backfill missing crew members (Jeremy/Steve/Vish) into the roster — one-time per workspace.
  useEffect(()=>{if(!editors.length)return;const required=[{id:"ed-jeremy",name:"Jeremy"},{id:"ed-steve",name:"Steve"},{id:"ed-vish",name:"Vish"}];const existingNames=new Set(editors.map(e=>(e.name||"").toLowerCase()));const toAdd=required.filter(r=>!existingNames.has(r.name.toLowerCase()));if(toAdd.length===0)return;setEditors(prev=>[...prev,...toAdd.map(r=>({id:r.id,name:r.name,phone:"",email:"",role:"crew",defaultDays:{mon:true,tue:true,wed:true,thu:true,fri:true}}))]);},[editors.length]);

  // Auto-update active projects from Monday.com
  useEffect(()=>{
    if(!isFounder||tool!=="capacity")return;
    fetchActiveProjectCount().then(count=>{
      if(count!=null)setInputs(p=>({...p,currentActiveProjects:count}));
    }).catch(()=>{});
  },[role,tool]);

  const login=resolvedRole=>{if(resolvedRole)setRole(resolvedRole);};
  const logout=async()=>{try{await signOutUser();}catch{}setRole(null);};

  // Quote helpers
  const createQuote=(name)=>{const q=newQuote(name);setQuotes(p=>[...p,q]);setActiveQuoteId(q.id);};
  const duplicateQuote=q=>{const nq={...JSON.parse(JSON.stringify(q)),id:`q-${Date.now()}`,clientName:q.clientName+" (Copy)",status:"draft",locked:false,createdAt:new Date().toISOString()};setQuotes(p=>[...p,nq]);setActiveQuoteId(nq.id);};
  const updateQuote=updated=>{setQuotes(p=>p.map(q=>q.id===updated.id?updated:q));};
  const deleteQuote=id=>{setQuotes(p=>p.filter(q=>q.id!==id));if(activeQuoteId===id)setActiveQuoteId(null);};

  const activeQuote=quotes.find(q=>q.id===activeQuoteId);

  // Check for public delivery link — supports both /d/HASH/slug (pretty) and ?d=ID (legacy)
  const pathname=window.location.pathname;
  const prettyDelivery=pathname.match(/^\/d\/([a-z0-9]{4,12})(?:\/|$)/i);
  const deliveryParam=new URLSearchParams(window.location.search).get("d");
  // Suspense fallback shared across the lazy-loaded public views + main
  // content area. Shows the Viewix logo over a "Loading…" caption while
  // the next chunk fetches — typically <300ms on a warm cache.
  const lazyFallback = (
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#0B0F1A"}}>
      <style>{CSS}</style>
      <div style={{textAlign:"center"}}>
        <Logo h={36}/>
        <div style={{marginTop:16,color:"#5A6B85",fontSize:14}}>Loading…</div>
      </div>
    </div>
  );

  if(prettyDelivery||deliveryParam)return(<Suspense fallback={lazyFallback}><style>{CSS}</style><DeliveryPublicView/></Suspense>);

  // Check for public preproduction link — supports both /p/HASH/slug and ?p=ID
  const prettyPreprod=pathname.match(/^\/p\/([a-z0-9]{4,12})(?:\/|$)/i);
  const preprodParam=new URLSearchParams(window.location.search).get("p");
  if(prettyPreprod||preprodParam)return(<Suspense fallback={lazyFallback}><style>{CSS}</style><PreproductionPublicView/></Suspense>);

  // Check for public sale payment link — supports both /s/HASH/slug and ?s=ID
  const prettySale=pathname.match(/^\/s\/([a-z0-9]{4,12})(?:\/|$)/i);
  const saleParam=new URLSearchParams(window.location.search).get("s");
  if(prettySale||saleParam)return(<Suspense fallback={lazyFallback}><style>{CSS}</style><SalePublicView/></Suspense>);

  // Check for public ROAS calculator link (no auth required, pure client-side state)
  const roasParam=new URLSearchParams(window.location.search).get("roas");
  if(roasParam)return(<Suspense fallback={lazyFallback}><RoasCalculatorPublicView/></Suspense>);

  if(!role)return(<><style>{CSS}</style><Login onLogin={login}/></>);
  if(loading)return(<div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#0B0F1A"}}><style>{CSS}</style><div style={{textAlign:"center"}}><Logo h={36}/><div style={{marginTop:16,color:"#5A6B85",fontSize:14}}>Loading...</div></div></div>);

  return(<div style={{fontFamily:"'DM Sans',-apple-system,sans-serif",background:"var(--bg)",color:"var(--fg)",minHeight:"100vh",display:"flex"}}><style>{CSS}</style>

    {/* Sidebar */}
    <div style={{width:72,background:"var(--card)",borderRight:"1px solid var(--border)",display:"flex",flexDirection:"column",alignItems:"center",padding:"16px 8px",gap:4,flexShrink:0}}>
      <div style={{marginBottom:12}}><Logo h={20}/></div>
      <SideIcon icon="🏠" label="Home" active={tool==="home"} onClick={()=>setTool("home")}/>
      {isFounders&&<SideIcon icon="🏛" label="Founders" active={tool==="founders"} onClick={()=>setTool("founders")}/>}
      {isFounder&&<SideIcon icon="📊" label="Capacity" active={tool==="capacity"} onClick={()=>setTool("capacity")}/>}
      {(isFounder||role==="closer"||isLead)&&<SideIcon icon="💰" label="Sale" active={tool==="sale"||tool==="quoting"} onClick={()=>setTool("sale")}/>}
      {isFounder&&<SideIcon icon="🌱" label="Nurture" active={tool==="nurture"} onClick={()=>setTool("nurture")}/>}
      {isFounder&&<SideIcon icon="👥" label="Accounts" active={tool==="accounts"} onClick={()=>setTool("accounts")}/>}
      {(isFounder||isLead)&&<SideIcon icon="📦" label="Projects" active={tool==="projects"||tool==="deliveries"} onClick={()=>setTool("projects")}/>}
      {(isFounder||isLead)&&<SideIcon icon="✏️" label="Pre-Prod" active={tool==="preproduction"} onClick={()=>setTool("preproduction")}/>}
      {(isFounder||role==="editor")&&<SideIcon icon="🎬" label="Editors" active={tool==="editors"} onClick={()=>setTool("editors")}/>}
      <SideIcon icon="🎓" label="Training" active={tool==="training"} onClick={()=>setTool("training")}/>
      {(isFounder||role==="closer")&&<SideIcon icon="📚" label="Resources" active={tool==="resources"} onClick={()=>setTool("resources")}/>}
      <div style={{flex:1}}/>
      <button onClick={logout} style={{padding:"8px",borderRadius:6,border:"none",background:"transparent",color:"var(--muted)",fontSize:9,fontWeight:600,cursor:"pointer",textTransform:"uppercase"}}>Log Out</button>
    </div>

    {/* Main content. Wrapped in Suspense so lazy-loaded tab modules
        can fetch their chunk on first activation without blocking the
        sidebar render. The fallback re-uses the dashboard "Loading…"
        screen so the visual transition is consistent. */}
    <div style={{flex:1,overflow:"auto"}}>
    {/* Tab-scoped error boundary. `key={tool}` resets the boundary when
        the producer switches tabs, so a crash on one tab doesn't stick
        when they navigate away — they don't need to click "Try again"
        first. The root boundary in main.jsx still catches anything
        thrown outside the tab area (sidebar, top-level Firebase setup). */}
    <ErrorBoundary key={tool} label={`the ${tool} tab`}>
    <Suspense fallback={<div style={{padding:40,color:"var(--muted)",fontSize:13}}>Loading…</div>}>

    {/* ═══ CAPACITY PLANNER ═══ */}
    {tool==="capacity"&&isFounder&&(
      <Capacity
        capTab={capTab} setCapTab={setCapTab}
        scMode={scMode} setScMode={setScMode} scIn={scIn} setScIn={setScIn}
        inputs={inputs} setInputs={setInputs}
        editors={editors} setEditors={setEditors}
        curW={curW} setCurW={setCurW} weekData={weekData} setWeekData={setWeekData}
        mondayEditorList={mondayEditorList}
        teamLunch={teamLunch} setTeamLunch={setTeamLunch}
        foundersData={foundersData} setFoundersData={setFoundersData}
        projects={projects}
        isFounder={isFounder}
      />
    )}


    {/* ═══ SALE (Payment Intake + Quotes) ═══ */}
    {(tool==="sale"||tool==="quoting")&&(isFounder||role==="closer"||isLead)&&(
      <Sale
        sales={sales} setSales={setSales}
        salePricing={salePricing} setSalePricing={setSalePricing}
        isFounders={isFounder}
        saleTab={saleTab} setSaleTab={setSaleTab}
        quotes={quotes} setQuotes={setQuotes}
        activeQuoteId={activeQuoteId} setActiveQuoteId={setActiveQuoteId}
        clientRateCards={clientRateCards} setClientRateCards={setClientRateCards}
        clientFilter={clientFilter} setClientFilter={setClientFilter}
        qTab={qTab} setQTab={setQTab}
        rcAdding={rcAdding} setRcAdding={setRcAdding}
        rcNewName={rcNewName} setRcNewName={setRcNewName} rcAddRef={rcAddRef}
        rcEditId={rcEditId} setRcEditId={setRcEditId}
        rcConfirmDelete={rcConfirmDelete} setRcConfirmDelete={setRcConfirmDelete}
        rcShowArchive={rcShowArchive} setRcShowArchive={setRcShowArchive}
        createQuote={createQuote} duplicateQuote={duplicateQuote}
        updateQuote={updateQuote} deleteQuote={deleteQuote}
      />
    )}

    {/* ═══ LEGACY QUOTING (unreachable — kept inert for diff safety, delete in cleanup pass) ═══ */}
    {false&&(<>
      <div style={{padding:"12px 28px",borderBottom:"1px solid var(--border)",display:"flex",alignItems:"center",justifyContent:"space-between",background:"var(--card)"}}>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <span style={{fontSize:15,fontWeight:700,color:"var(--fg)"}}>Quoting Tool</span>
          {!activeQuoteId&&(<div style={{display:"flex",gap:3,background:"var(--bg)",borderRadius:8,padding:3,marginLeft:12}}>
            <button onClick={()=>setQTab("quotes")} style={{padding:"6px 12px",borderRadius:6,border:"none",background:qTab==="quotes"?"var(--card)":"transparent",color:qTab==="quotes"?"var(--fg)":"var(--muted)",fontSize:12,fontWeight:600,cursor:"pointer"}}>Quotes</button>
            <button onClick={()=>setQTab("ratecards")} style={{padding:"6px 12px",borderRadius:6,border:"none",background:qTab==="ratecards"?"var(--card)":"transparent",color:qTab==="ratecards"?"var(--fg)":"var(--muted)",fontSize:12,fontWeight:600,cursor:"pointer"}}>Rate Cards</button>
          </div>)}
        </div>
        {!activeQuoteId&&qTab==="quotes"&&<button onClick={()=>createQuote("New Client")} style={{...BTN,background:"var(--accent)",color:"white"}}>+ New Quote</button>}
      </div>
      <div style={{maxWidth:1200,margin:"0 auto",padding:"24px 28px 60px"}}>

      {/* ── Rate Cards Management ── */}
      {!activeQuoteId&&qTab==="ratecards"&&(<div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <div style={{fontSize:13,fontWeight:700,color:"var(--fg)"}}>Client Rate Cards</div>
          {!rcAdding&&<button onClick={()=>setRcAdding(true)} style={{...BTN,background:"var(--accent)",color:"white"}}>+ New Rate Card</button>}
        </div>
        {rcAdding&&(<div style={{marginBottom:16,padding:"12px 16px",background:"var(--card)",border:"1px solid var(--accent)",borderRadius:10,display:"flex",alignItems:"center",gap:8}}>
          <input ref={rcAddRef} autoFocus type="text" value={rcNewName} onChange={e=>setRcNewName(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&rcNewName.trim()){const rc={id:`rc-${Date.now()}`,name:rcNewName.trim(),rates:{}};QUOTE_SECTIONS.forEach(s=>s.items.forEach(it=>{rc.rates[it.role]=it.rate;}));setClientRateCards(p=>[...p,rc]);setRcNewName("");setRcAdding(false);}if(e.key==="Escape"){setRcAdding(false);setRcNewName("");}}} placeholder="Client name..." style={{flex:1,padding:"8px 12px",borderRadius:6,border:"1px solid var(--border)",background:"var(--input-bg)",color:"var(--fg)",fontSize:14,fontWeight:600,outline:"none"}}/>
          <button onClick={()=>{if(!rcNewName.trim())return;const rc={id:`rc-${Date.now()}`,name:rcNewName.trim(),rates:{}};QUOTE_SECTIONS.forEach(s=>s.items.forEach(it=>{rc.rates[it.role]=it.rate;}));setClientRateCards(p=>[...p,rc]);setRcNewName("");setRcAdding(false);}} style={{...BTN,background:"var(--accent)",color:"white"}}>Create</button>
          <button onClick={()=>{setRcAdding(false);setRcNewName("");}} style={{...BTN,background:"#374151",color:"#9CA3AF"}}>Cancel</button>
        </div>)}
        <div style={{display:"grid",gap:12}}>
          {allRateCards.map(rc=>{
            const isCustom=customOnly.some(c=>c.id===rc.id);
            const isDefault=DEFAULT_RATE_CARDS.some(d=>d.id===rc.id);
            const isEditing=rcEditId===rc.id;
            const updateRate=(role,val)=>{
              if(isCustom){
                setClientRateCards(p=>p.map(c=>c.id===rc.id?{...c,rates:{...c.rates,[role]:val}}:c));
              } else if(isDefault){
                // Copy built-in to custom on first edit
                const copy={...rc,id:`rc-${Date.now()}`,rates:{...rc.rates,[role]:val}};
                setClientRateCards(p=>[...p,copy,{id:`del-${rc.id}`,name:rc.name,deleted:true}]);
                setRcEditId(copy.id);
              }
            };
            const deleteCard=()=>{
              if(isCustom){
                setClientRateCards(p=>p.map(c=>c.id===rc.id?{...c,archived:true}:c));
              } else if(isDefault){
                setClientRateCards(p=>[...p,{id:`del-${rc.id}`,name:rc.name,deleted:true}]);
              }
              if(rcEditId===rc.id)setRcEditId(null);
              setRcConfirmDelete(null);
            };
            return(<div key={rc.id} style={{background:"var(--card)",border:`1px solid ${isEditing?"var(--accent)":"var(--border)"}`,borderRadius:10,overflow:"hidden"}}>
              <div style={{padding:"12px 16px",display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:"1px solid var(--border)"}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontSize:14,fontWeight:700,color:"var(--fg)"}}>{rc.name}</span>
                  <span style={{fontSize:10,color:"var(--muted)",background:"var(--bg)",padding:"2px 8px",borderRadius:4}}>{isDefault?"Built-in":"Custom"}</span>
                  <span style={{fontSize:10,color:"var(--muted)"}}>{Object.keys(rc.rates||{}).length} rates</span>
                </div>
                <div style={{display:"flex",gap:8}}>
                  {!isEditing&&<button onClick={()=>setRcEditId(rc.id)} style={{...BTN,background:"var(--bg)",color:"var(--accent)",border:"1px solid var(--border)"}}>Edit Rates</button>}
                  {isEditing&&<button onClick={()=>setRcEditId(null)} style={{...BTN,background:"#10B981",color:"white"}}>Done</button>}
                  {rcConfirmDelete===rc.id?(
                    <div style={{display:"flex",gap:4,alignItems:"center"}}>
                      <span style={{fontSize:11,color:"#EF4444",fontWeight:600}}>Are you sure?</span>
                      <button onClick={deleteCard} style={{...BTN,background:"#EF4444",color:"white"}}>Yes, Archive</button>
                      <button onClick={()=>setRcConfirmDelete(null)} style={{...BTN,background:"#374151",color:"#9CA3AF"}}>Cancel</button>
                    </div>
                  ):(
                    <button onClick={()=>setRcConfirmDelete(rc.id)} style={{...BTN,background:"#374151",color:"#EF4444"}}>Delete</button>
                  )}
                </div>
              </div>
              {isEditing?(<div style={{padding:"12px 16px"}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                <thead><tr><th style={{...TH,textAlign:"left"}}>Role</th><th style={{...TH,textAlign:"right",width:120}}>Rate/h</th></tr></thead>
                <tbody>{Object.entries(rc.rates||{}).map(([role,rate])=>(<tr key={role}><td style={{padding:"4px 8px",color:"var(--fg)"}}>{role}</td><td style={{padding:"4px 8px"}}><input type="number" value={rate} onChange={e=>updateRate(role,parseFloat(e.target.value)||0)} step={0.5} style={{width:100,padding:"4px 8px",borderRadius:4,border:"1px solid var(--border)",background:"var(--input-bg)",color:"var(--fg)",fontSize:12,fontFamily:"'JetBrains Mono',monospace",outline:"none",textAlign:"right"}}/></td></tr>))}</tbody>
              </table></div>):(
              <div style={{padding:"12px 16px",display:"flex",flexWrap:"wrap",gap:6}}>
                {Object.entries(rc.rates||{}).filter(([_,v])=>v>0).map(([role,rate])=>(
                  <div key={role} style={{fontSize:11,color:"var(--muted)",background:"var(--bg)",padding:"3px 8px",borderRadius:4}}>
                    <span style={{color:"var(--fg)",fontWeight:600}}>{role}:</span> {fmtCur(rate)}
                  </div>
                ))}
              </div>)}
            </div>);
          })}
        </div>
        {/* Archived rate cards */}
        {archivedCards.length>0&&(<div style={{marginTop:24}}>
          <button onClick={()=>setRcShowArchive(!rcShowArchive)} style={{...BTN,background:"transparent",color:"var(--muted)",border:"1px solid var(--border)"}}>
            {rcShowArchive?"Hide":"Show"} Archived ({archivedCards.length})
          </button>
          {rcShowArchive&&(<div style={{display:"grid",gap:8,marginTop:12}}>
            {archivedCards.map(rc=>(<div key={rc.id} style={{background:"var(--card)",border:"1px solid var(--border)",borderRadius:10,padding:"12px 16px",opacity:0.6,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:13,fontWeight:600,color:"var(--fg)"}}>{rc.name}</span>
                <span style={{fontSize:10,color:"var(--muted)",background:"var(--bg)",padding:"2px 8px",borderRadius:4}}>Archived</span>
              </div>
              <button onClick={()=>setClientRateCards(p=>p.map(c=>c.id===rc.id?{...c,archived:false}:c))} style={{...BTN,background:"var(--accent)",color:"white"}}>Restore</button>
            </div>))}
          </div>)}
        </div>)}
      </div>)}

      {/* ── Quotes List ── */}
      {activeQuoteId&&activeQuote?(
        <QuoteCalc quote={activeQuote} onUpdate={updateQuote} onBack={()=>setActiveQuoteId(null)} rateCards={allRateCards}/>
      ):activeQuoteId&&!activeQuote?(
        <div style={{textAlign:"center",padding:40,color:"var(--muted)"}}>Quote not found. <button onClick={()=>setActiveQuoteId(null)} style={{...BTN,background:"var(--accent)",color:"white",marginLeft:8}}>Back to Quotes</button></div>
      ):qTab==="quotes"?(
        <div>
          {/* Client filter */}
          {quotes.length>0&&(<div style={{marginBottom:16,display:"flex",alignItems:"center",gap:12}}>
            <span style={{fontSize:11,fontWeight:700,color:"var(--muted)",textTransform:"uppercase"}}>Filter by client:</span>
            <select value={clientFilter} onChange={e=>setClientFilter(e.target.value)} style={{padding:"6px 12px",borderRadius:6,border:"1px solid var(--border)",background:"var(--input-bg)",color:"var(--fg)",fontSize:13,outline:"none"}}>
              <option value="">All Clients</option>
              {[...new Set(quotes.map(q=>q.clientName))].sort().map(name=>(<option key={name} value={name}>{name}</option>))}
            </select>
            {clientFilter&&<button onClick={()=>setClientFilter("")} style={{...BTN,background:"#374151",color:"#9CA3AF"}}>Clear</button>}
            <span style={{fontSize:12,color:"var(--muted)",marginLeft:"auto"}}>{(clientFilter?quotes.filter(q=>q.clientName===clientFilter):quotes).length} quote{(clientFilter?quotes.filter(q=>q.clientName===clientFilter):quotes).length!==1?"s":""}</span>
          </div>)}
          {quotes.length===0?(<div style={{textAlign:"center",padding:"60px 20px",color:"var(--muted)"}}><div style={{fontSize:40,marginBottom:12}}>💰</div><div style={{fontSize:16,fontWeight:600,marginBottom:8}}>No quotes yet</div><div style={{fontSize:13}}>Click "+ New Quote" to create your first quote.</div></div>):(
            <div style={{display:"grid",gap:12}}>
              {(clientFilter?quotes.filter(q=>q.clientName===clientFilter):quotes).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).map(q=>{
                const cost=q.items.reduce((s,it)=>s+(it.rateOverride??it.rate)*(it.hours||0),0)+(q.customItems||[]).reduce((s,it)=>s+it.rate*(it.hours||0),0);
                const sell=q.sellPriceMode&&q.sellPrice?q.sellPrice:cost>0?cost*(1+(q.margin||0.4)):0;
                return(<div key={q.id} style={{background:"var(--card)",border:"1px solid var(--border)",borderRadius:10,padding:"16px 20px",cursor:"pointer",transition:"all 0.15s"}} onClick={()=>setActiveQuoteId(q.id)}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div>
                      <div style={{fontSize:15,fontWeight:700,color:"var(--fg)"}}>{q.clientName}</div>
                      <div style={{fontSize:11,color:"var(--muted)",marginTop:2}}>{q.locked?"Locked":"Draft"} · {new Date(q.createdAt).toLocaleDateString("en-AU")}</div>
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:12}}>
                      <div style={{textAlign:"right"}}><div style={{fontSize:16,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:"#10B981"}}>{fmtCur(sell)}</div><div style={{fontSize:10,color:"var(--muted)"}}>ex GST</div></div>
                      <button onClick={e=>{e.stopPropagation();duplicateQuote(q);}} style={{...BTN,background:"#374151",color:"#9CA3AF"}} title="Duplicate">⧉</button>
                      {!q.locked&&<button onClick={e=>{e.stopPropagation();deleteQuote(q.id);}} style={{...BTN,background:"#374151",color:"#EF4444"}} title="Delete">x</button>}
                    </div>
                  </div>
                </div>);
              })}
            </div>
          )}
        </div>
      ):null}

      </div>
    </>)}

    {/* ═══ PREPRODUCTION ═══ */}
    {tool==="preproduction"&&(isFounder||isLead)&&(<Preproduction role={role} isFounder={isFounder} dealProjects={projects} route={route.tool==="preproduction"?route:null}/>)}

    {/* ═══ NURTURE — sequence hub (Lapsed Proposals + 5 stub sub-tabs) ═══ */}
    {tool==="nurture"&&isFounder&&(<Nurture attioDeals={attioDeals} isFounder={isFounder} nurtureTab={nurtureTab} setNurtureTab={setNurtureTab} route={route.tool==="nurture"?route:null}/>)}

    {/* ═══ RESOURCES ═══ */}
    {tool==="resources"&&(isFounder||role==="closer")&&(<>
      <div style={{padding:"12px 28px",borderBottom:"1px solid var(--border)",display:"flex",alignItems:"center",justifyContent:"space-between",background:"var(--card)"}}>
        <span style={{fontSize:15,fontWeight:700,color:"var(--fg)"}}>Resources</span>
        <div style={{display:"flex",gap:3,background:"var(--bg)",borderRadius:8,padding:3}}>
          {[{key:"roas",label:"ROAS Calculator"}].map(t=>(
            <button key={t.key} onClick={()=>setResourceTab(t.key)} style={{padding:"7px 14px",borderRadius:6,border:"none",background:resourceTab===t.key?"var(--card)":"transparent",color:resourceTab===t.key?"var(--fg)":"var(--muted)",fontSize:12,fontWeight:600,cursor:"pointer"}}>{t.label}</button>
          ))}
        </div>
      </div>
      {resourceTab==="roas"&&(<RoasCalculator embedded/>)}
    </>)}

    {/* ═══ EDITOR DASHBOARD ═══ */}
    {tool==="editors"&&(isFounder||role==="editor")&&(<EditorDashboard embedded projects={projects} editors={editors} clients={clients} deliveries={deliveries}/>)}

    {/* ═══ ACCOUNTS (clients-only; Turnaround + Buyer Journey relocated to Founders) ═══ */}
    {tool==="accounts"&&isFounder&&(<AccountsDashboard accounts={accounts} setAccounts={setAccounts} turnaround={turnaround} editors={mondayEditorList} clients={clients} setClients={setClients} onDeletePath={p=>deletedPaths.current.push(p)} highlightId={route.tool==="accounts"?route.subTab:null} onSyncAttio={async()=>{const r=await authFetch("/api/attio",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"currentCustomers"})});const d=await r.json();return d.companies||[];}}/>)}

    {/* ═══ PROJECTS (wraps Deliveries as a sub-tab) ═══ */}
    {tool==="projects"&&(isFounder||isLead)&&(<Projects projects={projects} deliveries={deliveries} setDeliveries={setDeliveries} accounts={accounts} editors={editors} setEditors={setEditors} weekData={weekData} clients={clients} setClients={setClients} route={route.tool==="projects"?route:null}/>)}

    {/* Legacy direct-to-Deliveries route (kept so old bookmarks still resolve). */}
    {tool==="deliveries"&&(isFounder||isLead)&&(<Projects projects={projects} deliveries={deliveries} setDeliveries={setDeliveries} accounts={accounts} editors={editors} setEditors={setEditors} weekData={weekData} clients={clients} setClients={setClients} route={route.tool==="projects"?route:null}/>)}


    {/* ═══ TRAINING ═══ */}
    {tool==="training"&&(
      <Training
        role={role} isFounder={isFounder}
        trainingData={trainingData} setTrainingData={setTrainingData}
        trainingSuggestions={trainingSuggestions} setTrainingSuggestions={setTrainingSuggestions}
        activeModuleId={activeModuleId} setActiveModuleId={setActiveModuleId}
        trainingSubTab={trainingSubTab} setTrainingSubTab={setTrainingSubTab}
      />
    )}


    {/* ═══ HOME ═══ */}
    {tool==="home"&&(<Home foundersData={foundersData} setFoundersData={setFoundersData} teamLunch={teamLunch} isFounder={isFounder} isFounders={isFounders}/>)}

    {/* ═══ FOUNDERS ═══ */}
    {tool==="founders"&&isFounders&&(
      <Founders
        foundersData={foundersData} setFoundersData={setFoundersData}
        foundersMetrics={foundersMetrics} setFoundersMetrics={setFoundersMetrics}
        foundersTab={foundersTab} setFoundersTab={setFoundersTab}
        attioDeals={attioDeals} setAttioDeals={setAttioDeals}
        salePricing={salePricing} setSalePricing={setSalePricing}
        saleThankYou={saleThankYou} setSaleThankYou={setSaleThankYou}
        buyerJourney={buyerJourney} setBuyerJourney={setBuyerJourney}
        turnaround={turnaround} setTurnaround={setTurnaround}
        accounts={accounts}
      />
    )}


    </Suspense>
    </ErrorBoundary>
    </div>
  </div>);
}
