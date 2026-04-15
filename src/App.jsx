import { useState, useMemo, useEffect, useRef } from "react";
import { initFB, onFB, fbSet, fbListen, onAuthReady, signOutUser } from "./firebase";
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
  newDelivery, newVideo
} from "./utils";
import { Logo } from "./components/Logo";
import { Badge, Metric, NumIn, UBar, FChart, StatusSelect, SideIcon } from "./components/UIComponents";
import { Grid } from "./components/Grid";
import { QuoteCalc, newQuote } from "./components/QuoteCalc";
import { EditorDashboard } from "./components/EditorDashboard";
import { BuyerJourney } from "./components/BuyerJourney";
import { AccountsDashboard } from "./components/AccountsDashboard";
import { FoundersData } from "./components/FoundersData";
import { DeliveryPublicView } from "./components/DeliveryPublicView";
import { Preproduction } from "./components/Preproduction";
import { PreproductionPublicView } from "./components/PreproductionPublicView";
import { RoasCalculator, RoasCalculatorPublicView } from "./components/RoasCalculator";
import { Login } from "./components/Login";

export default function App(){
  const[role,setRole]=useState(null); // "founder" | "closer"
  const[loading,setLoading]=useState(true);
  const[tool,setTool]=useState("home");
  const[capTab,setCapTab]=useState("dashboard");
  const[foundersTab,setFoundersTab]=useState("dashboard");
  const[resourceTab,setResourceTab]=useState("roas");

  // Capacity state
  const[inputs,setInputs]=useState(DEF_IN);
  const[editors,setEditors]=useState(DEF_EDS);
  const[weekData,setWeekData]=useState({});
  const[curW,setCurW]=useState(wKey(getMonday(new Date())));
  const[scMode,setScMode]=useState(false);const[scIn,setScIn]=useState(null);
  const[jumpOpen,setJumpOpen]=useState(false);const[jumpDate,setJumpDate]=useState("");

  // Roster state
  const[rosterAdding,setRosterAdding]=useState(false);const[rosterNewName,setRosterNewName]=useState("");
  const[rosterEditId,setRosterEditId]=useState(null);const[rosterEditName,setRosterEditName]=useState("");
  const rosterAddRef=useRef(null);const rosterEditRef=useRef(null);

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

  // Time logs state
  const[allTimeLogs,setAllTimeLogs]=useState({});
  const[timeLogDate,setTimeLogDate]=useState(todayKey());
  const[timeLogLoading,setTimeLogLoading]=useState(false);

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
  const[activeDeliveryId,setActiveDeliveryId]=useState(null);
  const[mondayEditorList,setMondayEditorList]=useState(DEFAULT_MONDAY_EDITORS);
  const[importMode,setImportMode]=useState(false);
  const[importProjects,setImportProjects]=useState([]);
  const[importLoading,setImportLoading]=useState(false);

  // Buyer Journey state
  const[buyerJourney,setBuyerJourney]=useState({});

  // Accounts state
  const[accounts,setAccounts]=useState({});
  const[turnaround,setTurnaround]=useState({});

  // Training state
  const[trainingData,setTrainingData]=useState(DEFAULT_TRAINING);
  const[trainingSuggestions,setTrainingSuggestions]=useState([]);
  const[activeModuleId,setActiveModuleId]=useState(null);
  const[trainingEditMode,setTrainingEditMode]=useState(false);
  const[trainingCommentText,setTrainingCommentText]=useState("");
  const[sugType,setSugType]=useState("new");
  const[sugTitle,setSugTitle]=useState("");
  const[sugDesc,setSugDesc]=useState("");
  const[sugOpen,setSugOpen]=useState(false);
  const[editCatId,setEditCatId]=useState(null);
  const[editCatName,setEditCatName]=useState("");
  const[collapsedCats,setCollapsedCats]=useState({});
  const[editModId,setEditModId]=useState(null);
  const[editModName,setEditModName]=useState("");

  // To Do list state
  const[todos,setTodos]=useState([]);
  const[todoNewText,setTodoNewText]=useState("");
  const[todoNewAssignee,setTodoNewAssignee]=useState("Jeremy");
  const[todoNewCategory,setTodoNewCategory]=useState("General");
  const[todoFilter,setTodoFilter]=useState("all");

  // Home state
  const[teamLunch,setTeamLunch]=useState(null);
  const[googleReviewData,setGoogleReviewData]=useState(null);

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

  // Firebase data listeners — gated on auth being ready so the root listener
  // doesn't attach before the auth token is available (prevents listener lockout
  // once security rules are applied).
  useEffect(()=>{
    initFB();
    const fallback=setTimeout(()=>{setLoading(false);skipWrite.current=false;},3000);
    onFB(()=>{onAuthReady(()=>{
      clearTimeout(fallback);
      fbListen("/",(data)=>{
        if(skipRead.current)return;
        try{
          if(data){
            if(data.inputs)setInputs(prev=>({...prev,...data.inputs}));
            if(data.editors&&Array.isArray(data.editors))setEditors(data.editors);
            if(data.weekData)setWeekData(data.weekData);
            if(data.quotes){
              const qArr=Object.values(data.quotes).filter(q=>q&&q.id&&q.items);
              setQuotes(qArr);
            }
            if(data.clientRateCards){
              const rcArr=Object.values(data.clientRateCards).filter(r=>r&&r.id);
              setClientRateCards(rcArr);
            }
            if(data.clients){
              const cArr=Object.values(data.clients).filter(c=>c&&c.id);
              setClients(cArr);
            }
            if(data.deliveries){
              const dArr=Object.values(data.deliveries).filter(d=>d&&d.id).map(d=>({...d,videos:Array.isArray(d.videos)?d.videos:[]}));
              setDeliveries(dArr);
            }
            if(data.buyerJourney){
              setBuyerJourney(data.buyerJourney);
            }
            if(data.accounts){
              setAccounts(data.accounts);
            }
            if(data.turnaround){
              setTurnaround(data.turnaround);
            }
            if(data.mondayEditors&&Array.isArray(data.mondayEditors)){
              setMondayEditorList(data.mondayEditors);
            }
            if(data.training&&Array.isArray(data.training)){
              setTrainingData(data.training);
            }
            if(data.trainingSuggestions&&Array.isArray(data.trainingSuggestions)){
              setTrainingSuggestions(data.trainingSuggestions);
            }
            if(data.todos){
              const arr=Array.isArray(data.todos)?data.todos.filter(Boolean):Object.values(data.todos).filter(Boolean);
              setTodos(arr);
            }
            if(data.foundersMetrics){setFoundersMetrics(data.foundersMetrics);}
            if(data.teamLunch){
              setTeamLunch(data.teamLunch);
            }
            if(data.foundersData){
              setFoundersData(data.foundersData);
            }
            if(data.attioCache&&data.attioCache.data){
              setAttioDeals({data:data.attioCache.data,total:data.attioCache.total||data.attioCache.data.length,lastSyncedAt:data.attioCache.lastSyncedAt||null});
            }
          }
        }catch(e){console.error("Firebase data parse error:",e);}
        setLoading(false);
        setTimeout(()=>{skipWrite.current=false;},500);
      });
    });});
  },[]);

  const wt=useRef(null);
  const deletedPaths=useRef([]);
  useEffect(()=>{if(skipWrite.current)return;if(wt.current)clearTimeout(wt.current);skipRead.current=true;wt.current=setTimeout(()=>{try{fbSet("/inputs",inputs);fbSet("/editors",editors);fbSet("/weekData",weekData);const qObj={};quotes.forEach(q=>{if(q&&q.id)qObj[q.id]=q;});fbSet("/quotes",qObj);const rcObj={};rcArr.forEach(r=>{if(r&&r.id)rcObj[r.id]=r;});fbSet("/clientRateCards",rcObj);clients.forEach(c=>{if(c&&c.id)fbSet("/clients/"+c.id,c);});deliveries.forEach(d=>{if(d&&d.id)fbSet("/deliveries/"+d.id,d);});fbSet("/training",trainingData);fbSet("/trainingSuggestions",trainingSuggestions);const tObj={};todos.forEach(t=>{if(t&&t.id)tObj[t.id]=t;});fbSet("/todos",tObj);fbSet("/foundersMetrics",foundersMetrics);if(teamLunch)fbSet("/teamLunch",teamLunch);fbSet("/foundersData",foundersData);fbSet("/buyerJourney",buyerJourney);Object.entries(accounts).forEach(([k,v])=>{if(v&&v.id)fbSet("/accounts/"+k,v);});fbSet("/turnaround",turnaround);deletedPaths.current.forEach(p=>fbSet(p,null));deletedPaths.current=[];}catch(e){console.error("Firebase write error:",e);}setTimeout(()=>{skipRead.current=false;},500);},400);},[inputs,editors,weekData,quotes,clientRateCards,clients,deliveries,trainingData,trainingSuggestions,todos,teamLunch,foundersData,buyerJourney,accounts,turnaround,foundersMetrics]);

  useEffect(()=>{if(rosterAdding&&rosterAddRef.current)rosterAddRef.current.focus();},[rosterAdding]);
  useEffect(()=>{if(rosterEditId&&rosterEditRef.current)rosterEditRef.current.focus();},[rosterEditId]);

  const isFounder=role==="founder"||role==="founders";
  const isFounders=role==="founders";

  // Auto-update active projects from Monday.com
  useEffect(()=>{
    if(!isFounder||tool!=="capacity")return;
    fetchActiveProjectCount().then(count=>{
      if(count!=null)setInputs(p=>({...p,currentActiveProjects:count}));
    }).catch(()=>{});
  },[role,tool]);

  // Time logs listener
  useEffect(()=>{
    if(capTab!=="timelogs")return;
    setTimeLogLoading(true);
    let unsub=()=>{};
    onFB(()=>{
      unsub=fbListen("/timeLogs",(data)=>{
        setAllTimeLogs(data||{});
        setTimeLogLoading(false);
      });
    });
    return()=>unsub();
  },[capTab]);

  // Google Reviews auto-fetch
  useEffect(()=>{
    if(tool!=="home"||googleReviewData)return;
    fetch("/api/google-reviews").then(r=>r.json()).then(data=>{if(data?.rating)setGoogleReviewData(data);}).catch(()=>{});
  },[tool]);

  const login=resolvedRole=>{if(resolvedRole)setRole(resolvedRole);};
  const logout=async()=>{try{await signOutUser();}catch{}setRole(null);};

  // Capacity helpers
  const goW=dir=>setCurW(wKey(addW(new Date(curW+"T00:00:00"),dir)));
  const goToday=()=>setCurW(wKey(getMonday(new Date())));
  const jumpTo=()=>{if(!jumpDate)return;setCurW(wKey(getMonday(new Date(jumpDate+"T00:00:00"))));setJumpOpen(false);setJumpDate("");};
  const upWeek=(wk,data)=>setWeekData(p=>({...p,[wk]:data}));
  const rosterToggle=(eid,day)=>setEditors(prev=>prev.map(e=>e.id===eid?{...e,defaultDays:{...e.defaultDays,[day]:!e.defaultDays[day]}}:e));
  const rosterAdd=()=>{if(!rosterNewName.trim())return;setEditors(prev=>[...prev,{id:`ed-${Date.now()}`,name:rosterNewName.trim(),defaultDays:{mon:true,tue:true,wed:true,thu:true,fri:true}}]);setRosterNewName("");setRosterAdding(false);};
  const rosterRemove=id=>setEditors(prev=>prev.filter(e=>e.id!==id));
  const rosterRename=()=>{if(!rosterEditName.trim()){setRosterEditId(null);return;}setEditors(prev=>prev.map(e=>e.id===rosterEditId?{...e,name:rosterEditName.trim()}:e));setRosterEditId(null);};

  const ai=scMode&&scIn?scIn:inputs;
  const cwEds=weekData[curW]?.editors||editors.map(e=>({...e,days:{...e.defaultDays}}));
  const occ=cwEds.reduce((s,e)=>s+DK.filter(d=>dayVal(e.days[d])==="in").length,0);
  const c=useMemo(()=>doCalc(ai,occ),[ai,occ]);
  const upIn=(k,v)=>{if(scMode)setScIn(p=>({...(p||inputs),[k]:v}));else setInputs(p=>({...p,[k]:v}));};
  const monD=new Date(curW+"T00:00:00");

  // Quote helpers
  const createQuote=(name)=>{const q=newQuote(name);setQuotes(p=>[...p,q]);setActiveQuoteId(q.id);};
  const duplicateQuote=q=>{const nq={...JSON.parse(JSON.stringify(q)),id:`q-${Date.now()}`,clientName:q.clientName+" (Copy)",status:"draft",locked:false,createdAt:new Date().toISOString()};setQuotes(p=>[...p,nq]);setActiveQuoteId(nq.id);};
  const updateQuote=updated=>{setQuotes(p=>p.map(q=>q.id===updated.id?updated:q));};
  const deleteQuote=id=>{setQuotes(p=>p.filter(q=>q.id!==id));if(activeQuoteId===id)setActiveQuoteId(null);};

  const activeQuote=quotes.find(q=>q.id===activeQuoteId);

  // Check for public delivery link
  const deliveryParam=new URLSearchParams(window.location.search).get("d");
  if(deliveryParam)return(<><style>{CSS}</style><DeliveryPublicView/></>);

  // Check for public preproduction link
  const preprodParam=new URLSearchParams(window.location.search).get("p");
  if(preprodParam)return(<><style>{CSS}</style><PreproductionPublicView/></>);

  // Check for public ROAS calculator link (no auth required, pure client-side state)
  const roasParam=new URLSearchParams(window.location.search).get("roas");
  if(roasParam)return(<RoasCalculatorPublicView/>);

  if(!role)return(<><style>{CSS}</style><Login onLogin={login}/></>);
  if(loading)return(<div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#0B0F1A"}}><style>{CSS}</style><div style={{textAlign:"center"}}><Logo h={36}/><div style={{marginTop:16,color:"#5A6B85",fontSize:14}}>Loading...</div></div></div>);

  return(<div style={{fontFamily:"'DM Sans',-apple-system,sans-serif",background:"var(--bg)",color:"var(--fg)",minHeight:"100vh",display:"flex"}}><style>{CSS}</style>

    {/* Sidebar */}
    <div style={{width:72,background:"var(--card)",borderRight:"1px solid var(--border)",display:"flex",flexDirection:"column",alignItems:"center",padding:"16px 8px",gap:4,flexShrink:0}}>
      <div style={{marginBottom:12}}><Logo h={20}/></div>
      <SideIcon icon="🏠" label="Home" active={tool==="home"} onClick={()=>setTool("home")}/>
      {isFounders&&<SideIcon icon="🏛" label="Founders" active={tool==="founders"} onClick={()=>setTool("founders")}/>}
      {isFounder&&<SideIcon icon="📊" label="Capacity" active={tool==="capacity"} onClick={()=>setTool("capacity")}/>}
      {(isFounder||role==="closer")&&<SideIcon icon="💰" label="Quoting" active={tool==="quoting"} onClick={()=>setTool("quoting")}/>}
      {isFounder&&<SideIcon icon="🧭" label="Buyer Journey" active={tool==="buyerjourney"} onClick={()=>setTool("buyerjourney")}/>}
      {isFounder&&<SideIcon icon="👥" label="Accounts" active={tool==="accounts"} onClick={()=>setTool("accounts")}/>}
      {isFounder&&<SideIcon icon="📦" label="Deliveries" active={tool==="deliveries"} onClick={()=>setTool("deliveries")}/>}
      {(isFounder||role==="lead"||role==="editor")&&<SideIcon icon="✏️" label="Pre-Prod" active={tool==="preproduction"} onClick={()=>setTool("preproduction")}/>}
      {(isFounder||role==="editor")&&<SideIcon icon="🎬" label="Editors" active={tool==="editors"} onClick={()=>setTool("editors")}/>}
      <SideIcon icon="📋" label="Sherpas" active={tool==="sherpas"} onClick={()=>setTool("sherpas")}/>
      <SideIcon icon="🎓" label="Training" active={tool==="training"} onClick={()=>setTool("training")}/>
      {(isFounder||role==="closer")&&<SideIcon icon="📚" label="Resources" active={tool==="resources"} onClick={()=>setTool("resources")}/>}
      <div style={{flex:1}}/>
      <button onClick={logout} style={{padding:"8px",borderRadius:6,border:"none",background:"transparent",color:"var(--muted)",fontSize:9,fontWeight:600,cursor:"pointer",textTransform:"uppercase"}}>Log Out</button>
    </div>

    {/* Main content */}
    <div style={{flex:1,overflow:"auto"}}>

    {/* ═══ CAPACITY PLANNER ═══ */}
    {tool==="capacity"&&isFounder&&(<>
      <div style={{padding:"12px 28px",borderBottom:"1px solid var(--border)",display:"flex",alignItems:"center",justifyContent:"space-between",background:"var(--card)"}}>
        <span style={{fontSize:15,fontWeight:700,color:"var(--fg)"}}>Capacity Planner</span>
        <div style={{display:"flex",gap:3,background:"var(--bg)",borderRadius:8,padding:3}}>
          {[{key:"dashboard",label:"Dashboard"},{key:"roster",label:"Team Roster"},{key:"schedule",label:"Weekly Schedule"},{key:"forecast",label:"Forecast"},{key:"timelogs",label:"Time Logs"},{key:"lunch",label:"Team Lunch"}].map(t=>(<button key={t.key} onClick={()=>setCapTab(t.key)} style={{padding:"7px 14px",borderRadius:6,border:"none",background:capTab===t.key?"var(--card)":"transparent",color:capTab===t.key?"var(--fg)":"var(--muted)",fontSize:12,fontWeight:600,cursor:"pointer"}}>{t.label}</button>))}
        </div>
      </div>

      {scMode&&(<div style={{padding:"10px 28px",background:"#1A1510",borderBottom:"1px solid #3D2E10",display:"flex",alignItems:"center",justifyContent:"space-between"}}><span style={{fontSize:12,fontWeight:700,color:"#F59E0B"}}>WHAT-IF MODE</span><div style={{display:"flex",gap:8}}><button onClick={()=>{if(scIn)setInputs(scIn);setScMode(false);setScIn(null);}} style={{...BTN,background:"#10B981",color:"white"}}>Apply</button><button onClick={()=>{setScMode(false);setScIn(null);}} style={{...BTN,background:"#374151",color:"#9CA3AF"}}>Discard</button></div></div>)}

      <div style={{maxWidth:1200,margin:"0 auto",padding:"24px 28px 60px"}}>

      {capTab==="dashboard"&&(<>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:24,padding:"20px 24px",background:"var(--card)",borderRadius:12,border:"1px solid var(--border)"}}><div><div style={{fontSize:12,color:"var(--muted)",fontWeight:600,marginBottom:8,textTransform:"uppercase",letterSpacing:"0.05em"}}>Current Capacity Status</div><Badge util={c.realUtil} large/><div style={{fontSize:13,color:"var(--muted)",marginTop:10}}>{c.realUtil>=0.85?`Hire ${c.editorsNeeded} editor(s) NOW`:c.realUtil>=0.7?"Monitor closely - plan hire":"No action needed"}</div></div><div style={{textAlign:"right"}}><div style={{fontSize:40,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:c.realUtil>=0.85?"#EF4444":"var(--fg)"}}>{pct(c.realUtil)}</div><div style={{fontSize:12,color:"var(--muted)"}}>Real utilisation</div></div></div>
        <div style={{fontSize:13,fontWeight:700,color:"var(--fg)",marginBottom:10}}>This Week's Stats</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))",gap:12,marginBottom:24}}><Metric label="Active Projects" value={ai.currentActiveProjects}/><Metric label="Weekly Workload" value={`${Math.round(c.workload)}h`} sub={`of ${c.realCapacity}h capacity`}/><Metric label="Spare Hours" value={`${c.spareHours}h`} accent={c.spareHours<=10?"#EF4444":"#10B981"}/><Metric label="Suites Occupied" value={`${c.occupiedSuiteDays}/${c.maxSuiteDays}`} sub="suite-days/week"/><Metric label="Editors to Fill" value={c.editorsNeeded} accent={c.editorsNeeded>0?"#F59E0B":"#10B981"}/><Metric label="Filled Util" value={pct(c.filledUtil)} sub="if all suites staffed"/></div>
        <div style={{background:scMode?"#1A1510":"var(--card)",border:`1px solid ${scMode?"#3D2E10":"var(--border)"}`,borderRadius:12,padding:"20px 24px",marginBottom:24}}><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}><span style={{fontSize:13,fontWeight:700,color:"var(--fg)"}}>Model Inputs</span>{!scMode&&<button onClick={()=>{setScIn({...inputs});setScMode(true);}} style={{...BTN,border:"1px solid var(--border)",background:"transparent",color:"var(--accent)"}}>What-If Mode</button>}</div><div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:16}}><NumIn label="Total Edit Suites" value={ai.totalSuites} onChange={v=>upIn("totalSuites",v)} min={1}/><NumIn label="Hours / Suite / Day" value={ai.hoursPerSuitePerDay} onChange={v=>upIn("hoursPerSuitePerDay",v)} min={1} step={0.5}/><NumIn label="Active Projects" value={ai.currentActiveProjects} onChange={v=>upIn("currentActiveProjects",v)} min={0}/><NumIn label="Avg Edit Hrs / Project / Wk" value={ai.avgEditHoursPerProject} onChange={v=>upIn("avgEditHoursPerProject",v)} min={0} step={0.5}/><NumIn label="New Projects / Week" value={ai.newProjectsPerWeek} onChange={v=>upIn("newProjectsPerWeek",v)} min={0}/><NumIn label="Avg Project Duration" value={ai.avgProjectDuration} onChange={v=>upIn("avgProjectDuration",v)} min={1} suffix="weeks"/><NumIn label="Target Utilisation" value={Math.round(ai.targetUtilisation*100)} onChange={v=>upIn("targetUtilisation",v/100)} min={10} max={100} suffix="%"/></div></div>
        <div style={{background:"var(--card)",border:"1px solid var(--border)",borderRadius:12,padding:"20px 24px"}}><div style={{fontSize:13,fontWeight:700,color:"var(--fg)",marginBottom:12}}>Queueing Theory</div><div style={{display:"flex",gap:8,flexWrap:"wrap"}}>{QT.map(q=>{const on=c.realUtil>=q.util-0.025&&c.realUtil<q.util+0.05;return(<div key={q.util} style={{padding:"8px 14px",borderRadius:8,textAlign:"center",minWidth:75,background:on?"var(--accent-soft)":"var(--bg)",border:on?"1px solid var(--accent)":"1px solid var(--border)"}}><div style={{fontSize:14,fontWeight:800,color:on?"var(--accent)":"var(--fg)",fontFamily:"'JetBrains Mono',monospace"}}>{pct(q.util)}</div><div style={{fontSize:11,color:"var(--muted)",fontWeight:600}}>{q.wait} wait</div></div>);})}</div></div>
      </>)}

      {capTab==="roster"&&(<div style={{background:"var(--card)",border:"1px solid var(--border)",borderRadius:12,padding:"20px 24px"}}><div style={{marginBottom:4,fontSize:17,fontWeight:800,color:"var(--fg)"}}>Team Roster</div><div style={{fontSize:12,color:"var(--muted)",marginBottom:20}}>Default working days for all future weeks. Override specific weeks in Weekly Schedule.</div><div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"separate",borderSpacing:0,fontSize:13}}><thead><tr><th style={{...TH,width:180,textAlign:"left"}}>Editor</th>{DL.map(d=>(<th key={d} style={{...TH,textAlign:"center",minWidth:80}}>{d}</th>))}<th style={{...TH,width:55,textAlign:"center"}}>Days</th><th style={{...TH,width:40}}></th></tr></thead><tbody>{editors.map(ed=>{const dn=DK.filter(d=>ed.defaultDays[d]).length;const isE=rosterEditId===ed.id;return(<tr key={ed.id}><td style={{...TD,fontWeight:700,color:"var(--fg)",cursor:"pointer"}} onClick={()=>{if(!isE){setRosterEditId(ed.id);setRosterEditName(ed.name);}}}>{isE?(<input ref={rosterEditRef} type="text" value={rosterEditName} onChange={e=>setRosterEditName(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")rosterRename();if(e.key==="Escape")setRosterEditId(null);}} onBlur={rosterRename} style={{width:"100%",padding:"3px 6px",borderRadius:4,border:"1px solid var(--accent)",background:"var(--input-bg)",color:"var(--fg)",fontSize:13,fontWeight:700,outline:"none"}}/>):(<span style={{borderBottom:"1px dashed #3A4558"}}>{ed.name}</span>)}</td>{DK.map(day=>(<td key={day} onClick={()=>rosterToggle(ed.id,day)} style={{...TD,textAlign:"center",cursor:"pointer",userSelect:"none",background:ed.defaultDays[day]?"var(--accent-soft)":"transparent",color:ed.defaultDays[day]?"var(--accent)":"#3A4558",fontWeight:700}}>{ed.defaultDays[day]?"IN":"-"}</td>))}<td style={{...TD,textAlign:"center",fontWeight:700,fontFamily:"'JetBrains Mono',monospace"}}>{dn}</td><td style={{...TD,textAlign:"center"}}><button onClick={()=>rosterRemove(ed.id)} style={{background:"none",border:"none",cursor:"pointer",color:"#5A6B85",fontSize:16}}>x</button></td></tr>);})}
      {rosterAdding&&(<tr><td style={TD}><input ref={rosterAddRef} type="text" value={rosterNewName} onChange={e=>setRosterNewName(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")rosterAdd();if(e.key==="Escape"){setRosterAdding(false);setRosterNewName("");}}} placeholder="Editor name..." style={{width:"100%",padding:"5px 8px",borderRadius:6,border:"1px solid var(--accent)",background:"var(--input-bg)",color:"var(--fg)",fontSize:13,fontWeight:600,outline:"none"}}/></td><td style={TD} colSpan={5}></td><td style={{...TD,textAlign:"center"}}><button onClick={rosterAdd} style={{...BTN,background:"var(--accent)",color:"white"}}>Add</button></td><td style={{...TD,textAlign:"center"}}><button onClick={()=>{setRosterAdding(false);setRosterNewName("");}} style={{background:"none",border:"none",cursor:"pointer",color:"#5A6B85",fontSize:16}}>x</button></td></tr>)}</tbody></table></div>{!rosterAdding&&<button onClick={()=>setRosterAdding(true)} style={{marginTop:12,padding:"8px 16px",borderRadius:8,border:"1px dashed var(--border)",background:"transparent",color:"var(--muted)",fontSize:12,fontWeight:600,cursor:"pointer"}}>+ Add Editor</button>}</div>)}

      {capTab==="schedule"&&(<div style={{background:"var(--card)",border:"1px solid var(--border)",borderRadius:12,padding:"20px 24px"}}><div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20,flexWrap:"wrap",gap:12}}><div style={{display:"flex",alignItems:"center",gap:8}}><button onClick={()=>goW(-1)} style={NB}>&larr;</button><div style={{textAlign:"center",minWidth:220}}><div style={{fontSize:17,fontWeight:800,color:"var(--fg)"}}>Week of {fmtLabel(monD)}</div><div style={{fontSize:12,color:"var(--muted)",marginTop:2}}>{fmtRange(monD)}</div></div><button onClick={()=>goW(1)} style={NB}>&rarr;</button></div><div style={{display:"flex",gap:8}}><button onClick={goToday} style={{...NB,fontSize:11,fontWeight:600}}>Today</button><div style={{position:"relative"}}><button onClick={()=>setJumpOpen(!jumpOpen)} style={{...NB,fontSize:11,fontWeight:600}}>Jump to Date</button>{jumpOpen&&(<div style={{position:"absolute",top:"100%",right:0,marginTop:6,background:"var(--card)",border:"1px solid var(--border)",borderRadius:10,padding:12,zIndex:100,boxShadow:"0 8px 24px rgba(0,0,0,0.4)"}}><input type="date" value={jumpDate} onChange={e=>setJumpDate(e.target.value)} style={{padding:"8px 10px",borderRadius:6,border:"1px solid var(--border)",background:"var(--input-bg)",color:"var(--fg)",fontSize:13,outline:"none",colorScheme:"dark"}}/><button onClick={jumpTo} style={{marginTop:8,width:"100%",padding:"7px",borderRadius:6,border:"none",background:"var(--accent)",color:"white",fontSize:12,fontWeight:700,cursor:"pointer"}}>Go</button></div>)}</div></div></div>
        <Grid wk={curW} weekData={weekData} onUpdate={upWeek} masterEds={editors} inputs={ai} onUpdateSuites={v=>{if(scMode)setScIn(p=>({...(p||inputs),totalSuites:v}));else setInputs(p=>({...p,totalSuites:v}));}}/>
      </div>)}

      {capTab==="forecast"&&(<><div style={{background:"var(--card)",border:"1px solid var(--border)",borderRadius:12,padding:"20px 24px",marginBottom:20}}><div style={{fontSize:13,fontWeight:700,color:"var(--fg)",marginBottom:4}}>12-Week Workload Forecast</div><div style={{fontSize:12,color:"var(--muted)",marginBottom:16}}>{ai.newProjectsPerWeek} new/week, {ai.avgProjectDuration}-week duration, {ai.avgEditHoursPerProject}h avg edit</div><FChart forecast={c.forecast}/></div><div style={{background:"var(--card)",border:"1px solid var(--border)",borderRadius:12,padding:"20px 24px",overflowX:"auto"}}><div style={{fontSize:13,fontWeight:700,color:"var(--fg)",marginBottom:12}}>Forecast Detail</div><table style={{width:"100%",borderCollapse:"separate",borderSpacing:0,fontSize:12}}><thead><tr>{["Week","Projects","Workload","Real Util","Filled Util","Suites","Status"].map(h=>(<th key={h} style={{...TH,textAlign:h==="Week"?"left":"center"}}>{h}</th>))}</tr></thead><tbody>{c.forecast.map(f=>(<tr key={f.week}><td style={{...TD,fontWeight:700,fontFamily:"'JetBrains Mono',monospace"}}>W{f.week}{f.week===0?" (now)":""}</td><td style={{...TD,textAlign:"center",fontFamily:"'JetBrains Mono',monospace"}}>{f.projects}</td><td style={{...TD,textAlign:"center",fontFamily:"'JetBrains Mono',monospace"}}>{f.workload}h</td><td style={{...TD,textAlign:"center"}}><div style={{display:"flex",alignItems:"center",gap:8,justifyContent:"center"}}><div style={{width:60}}><UBar value={f.realUtil} height={8}/></div><span style={{fontFamily:"'JetBrains Mono',monospace",fontWeight:700,fontSize:11,color:f.realUtil>=0.95?"#EF4444":"var(--fg)"}}>{pct(f.realUtil)}</span></div></td><td style={{...TD,textAlign:"center",fontFamily:"'JetBrains Mono',monospace"}}>{pct(f.filledUtil)}</td><td style={{...TD,textAlign:"center",fontFamily:"'JetBrains Mono',monospace",fontWeight:700}}>{f.suitesNeeded}</td><td style={{...TD,textAlign:"center"}}><Badge util={f.realUtil}/></td></tr>))}</tbody></table></div></>)}

      {capTab==="timelogs"&&(()=>{
        const fmtHM=(secs)=>{const h=Math.floor(secs/3600);const m=Math.floor((secs%3600)/60);if(h>0&&m>0)return`${h}h ${m}m`;if(h>0)return`${h}h`;if(m>0)return`${m}m`;if(secs>0)return`${secs}s`;return"0m";};
        const editorMap={};
        mondayEditorList.forEach(ed=>{editorMap[ed.id]=ed.name;});
        // Build data for selected date
        const dateData={};
        Object.entries(allTimeLogs).forEach(([edId,dates])=>{
          if(!dates||typeof dates!=="object")return;
          const dayData=dates[timeLogDate];
          if(!dayData||typeof dayData!=="object")return;
          const edName=editorMap[edId]||`Editor ${edId}`;
          const tasks=[];
          let edTotal=0;
          Object.entries(dayData).forEach(([taskId,val])=>{
            const secs=typeof val==="number"?val:(val?.secs||0);
            const name=typeof val==="object"?(val?.name||taskId):taskId;
            const parentName=typeof val==="object"?(val?.parentName||""):"";
            const stage=typeof val==="object"?(val?.stage||""):"";
            const category=typeof val==="object"?(val?.category||categorizeContent(parentName,val?.type)):categorizeContent(parentName,"");
            if(secs>0){
              tasks.push({taskId,secs,name,parentName,stage,category});
              edTotal+=secs;
            }
          });
          if(tasks.length>0)dateData[edId]={name:edName,tasks,total:edTotal};
        });
        const grandTotal=Object.values(dateData).reduce((s,ed)=>s+ed.total,0);
        const datePrev=()=>{const d=new Date(timeLogDate+"T00:00:00");d.setDate(d.getDate()-1);setTimeLogDate(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`);};
        const dateNext=()=>{const d=new Date(timeLogDate+"T00:00:00");d.setDate(d.getDate()+1);setTimeLogDate(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`);};
        const dateLabel=new Date(timeLogDate+"T00:00:00").toLocaleDateString("en-AU",{weekday:"long",day:"numeric",month:"long",year:"numeric"});

        return(<div>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}}>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <button onClick={datePrev} style={NB}>&larr;</button>
              <div style={{textAlign:"center",minWidth:260}}>
                <div style={{fontSize:17,fontWeight:800,color:"var(--fg)"}}>{dateLabel}</div>
                {timeLogDate===todayKey()&&<div style={{fontSize:11,color:"var(--accent)",fontWeight:600,marginTop:2}}>Today</div>}
              </div>
              <button onClick={dateNext} style={NB}>&rarr;</button>
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>setTimeLogDate(todayKey())} style={{...NB,fontSize:11,fontWeight:600}}>Today</button>
              <div style={{padding:"8px 16px",borderRadius:8,background:grandTotal>0?"rgba(16,185,129,0.12)":"var(--bg)",border:"1px solid var(--border)"}}>
                <span style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.05em"}}>Total </span>
                <span style={{fontSize:18,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:grandTotal>0?"#10B981":"var(--fg)",marginLeft:8}}>{fmtHM(grandTotal)}</span>
              </div>
            </div>
          </div>

          {timeLogLoading?(<div style={{textAlign:"center",padding:60,color:"var(--muted)"}}>Loading time logs...</div>)
          :Object.keys(dateData).length===0?(<div style={{textAlign:"center",padding:60,color:"var(--muted)",background:"var(--card)",borderRadius:12,border:"1px solid var(--border)"}}><div style={{fontSize:40,marginBottom:12}}>⏱</div><div style={{fontSize:16,fontWeight:600,marginBottom:8}}>No time logged</div><div style={{fontSize:13}}>No editors have logged time for this date</div></div>)
          :(<div style={{display:"grid",gap:16}}>
            {Object.entries(dateData).sort((a,b)=>b[1].total-a[1].total).map(([edId,ed])=>(
              <div key={edId} style={{background:"var(--card)",border:"1px solid var(--border)",borderRadius:12,overflow:"hidden"}}>
                <div style={{padding:"14px 20px",borderBottom:"1px solid var(--border)",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div style={{display:"flex",alignItems:"center",gap:10}}>
                    <span style={{width:32,height:32,borderRadius:"50%",background:"var(--accent-soft)",color:"var(--accent)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:800}}>{ed.name.split(" ").map(n=>n[0]).join("")}</span>
                    <span style={{fontSize:14,fontWeight:700,color:"var(--fg)"}}>{ed.name}</span>
                  </div>
                  <span style={{fontSize:18,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:"#10B981"}}>{fmtHM(ed.total)}</span>
                </div>
                <div style={{padding:"8px 12px"}}>
                  {ed.tasks.sort((a,b)=>b.secs-a.secs).map(t=>{
                    const stageColors={"Edit":"#0082FA","Shoot":"#F87700","Pre Production":"#8B5CF6","Revisions":"#EF4444","Delivery":"#10B981"};
                    const stageCol=stageColors[t.stage]||"var(--accent)";
                    return(
                    <div key={t.taskId} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 12px",borderBottom:"1px solid var(--border-light)"}}>
                      <div style={{flex:1}}>
                        {t.parentName&&<div style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.04em",marginBottom:2}}>{t.parentName}</div>}
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          <span style={{fontSize:13,color:"var(--fg)",fontWeight:500}}>{t.name}</span>
                          {t.stage&&<span style={{fontSize:9,fontWeight:700,padding:"2px 8px",borderRadius:3,background:`${stageCol}20`,color:stageCol,textTransform:"uppercase"}}>{t.stage}</span>}
                          {t.category&&<span style={{fontSize:9,fontWeight:700,padding:"2px 8px",borderRadius:3,background:`${CAT_COLORS[t.category]||"#5A6B85"}15`,color:CAT_COLORS[t.category]||"#5A6B85"}}>{t.category}</span>}
                        </div>
                      </div>
                      <span style={{fontSize:14,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:"var(--fg)"}}>{fmtHM(t.secs)}</span>
                    </div>);
                  })}
                </div>
              </div>
            ))}
          </div>)}

          {/* Category Averages (all time) */}
          {Object.keys(allTimeLogs).length>0&&(()=>{
            const catStats={};
            CONTENT_CATEGORIES.forEach(cat=>{catStats[cat]={};});
            Object.entries(allTimeLogs).forEach(([edId,dates])=>{
              if(!dates||typeof dates!=="object")return;
              Object.entries(dates).forEach(([date,tasks2])=>{
                if(!tasks2||typeof tasks2!=="object")return;
                const parentTotals={};
                Object.entries(tasks2).forEach(([tid,val])=>{
                  const secs=typeof val==="number"?val:(val?.secs||0);
                  if(secs<=0)return;
                  const cat=typeof val==="object"?(val?.category||"Other"):"Other";
                  const pName=typeof val==="object"?(val?.parentName||tid):tid;
                  const key=`${cat}|||${pName}|||${date}`;
                  if(!parentTotals[key])parentTotals[key]={cat,secs:0};
                  parentTotals[key].secs+=secs;
                });
                Object.values(parentTotals).forEach(({cat,secs})=>{
                  if(!catStats[cat])catStats[cat]={};
                  if(!catStats[cat][edId])catStats[cat][edId]={totalSecs:0,count:0};
                  catStats[cat][edId].totalSecs+=secs;
                  catStats[cat][edId].count+=1;
                });
              });
            });
            const hasCatData=CONTENT_CATEGORIES.some(cat=>Object.keys(catStats[cat]).length>0);
            if(!hasCatData)return null;
            return(<div style={{marginTop:32}}>
              <div style={{fontSize:15,fontWeight:800,color:"var(--fg)",marginBottom:16}}>Average Time by Content Type</div>
              <div style={{display:"grid",gap:16}}>
                {CONTENT_CATEGORIES.map(cat=>{
                  const editors2=catStats[cat];
                  const edEntries=Object.entries(editors2).filter(([_,v])=>v.count>0);
                  if(edEntries.length===0)return null;
                  const allTotal=edEntries.reduce((s,[_,v])=>s+v.totalSecs,0);
                  const allCount=edEntries.reduce((s,[_,v])=>s+v.count,0);
                  const allAvg=allCount>0?Math.round(allTotal/allCount):0;
                  const catColor=CAT_COLORS[cat]||"#5A6B85";
                  return(<div key={cat} style={{background:"var(--card)",border:"1px solid var(--border)",borderRadius:12,overflow:"hidden"}}>
                    <div style={{padding:"14px 20px",borderBottom:"1px solid var(--border)",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <div style={{display:"flex",alignItems:"center",gap:10}}>
                        <span style={{width:10,height:10,borderRadius:"50%",background:catColor}}/>
                        <span style={{fontSize:14,fontWeight:700,color:"var(--fg)"}}>{cat}</span>
                        <span style={{fontSize:11,color:"var(--muted)"}}>{allCount} task{allCount!==1?"s":""} logged</span>
                      </div>
                      <div style={{textAlign:"right"}}>
                        <div style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.04em"}}>Avg per task</div>
                        <div style={{fontSize:18,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:catColor}}>{fmtHM(allAvg)}</div>
                      </div>
                    </div>
                    <div style={{padding:"8px 12px"}}>
                      {edEntries.sort((a,b)=>b[1].count-a[1].count).map(([edId2,v])=>{
                        const edName2=editorMap[edId2]||`Editor ${edId2}`;
                        const avg=v.count>0?Math.round(v.totalSecs/v.count):0;
                        return(<div key={edId2} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 10px",borderBottom:"1px solid var(--border-light)"}}>
                          <div style={{display:"flex",alignItems:"center",gap:8}}>
                            <span style={{width:24,height:24,borderRadius:"50%",background:"var(--accent-soft)",color:"var(--accent)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:800}}>{edName2.split(" ").map(n=>n[0]).join("")}</span>
                            <span style={{fontSize:12,color:"var(--fg)",fontWeight:500}}>{edName2}</span>
                            <span style={{fontSize:10,color:"var(--muted)"}}>{v.count} task{v.count!==1?"s":""}</span>
                          </div>
                          <div style={{display:"flex",alignItems:"center",gap:12}}>
                            <span style={{fontSize:10,color:"var(--muted)"}}>avg</span>
                            <span style={{fontSize:13,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:"var(--fg)"}}>{fmtHM(avg)}</span>
                          </div>
                        </div>);
                      })}
                    </div>
                  </div>);
                })}
              </div>
            </div>);
          })()}
        </div>);
      })()}

      {capTab==="lunch"&&(
        <div style={{maxWidth:700,margin:"0 auto"}}>
          <div style={{background:"var(--card)",border:"1px solid var(--border)",borderRadius:12,padding:"24px"}}>
            <div style={{fontSize:15,fontWeight:700,color:"var(--fg)",marginBottom:16}}>Team Lunch</div>
            {isFounder?(
              <div>
                <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:8}}>
                  <input type="date" value={teamLunch?.date||""} onChange={e=>setTeamLunch(p=>({...p,date:e.target.value}))} style={{padding:"8px 12px",borderRadius:8,border:"1px solid var(--border)",background:"var(--input-bg)",color:"var(--fg)",fontSize:13,outline:"none",colorScheme:"dark"}}/>
                  <input value={teamLunch?.time||""} onChange={e=>setTeamLunch(p=>({...p,time:e.target.value}))} placeholder="Time (e.g. 12:30pm)" style={{padding:"8px 12px",borderRadius:8,border:"1px solid var(--border)",background:"var(--input-bg)",color:"var(--fg)",fontSize:13,outline:"none",width:160}}/>
                  <input value={teamLunch?.location||""} onChange={e=>setTeamLunch(p=>({...p,location:e.target.value}))} placeholder="Location" style={{padding:"8px 12px",borderRadius:8,border:"1px solid var(--border)",background:"var(--input-bg)",color:"var(--fg)",fontSize:13,outline:"none",flex:1,minWidth:180}}/>
                </div>
                <input value={teamLunch?.notes||""} onChange={e=>setTeamLunch(p=>({...p,notes:e.target.value}))} placeholder="Notes" style={{padding:"8px 12px",borderRadius:8,border:"1px solid var(--border)",background:"var(--input-bg)",color:"var(--fg)",fontSize:13,outline:"none",width:"100%"}}/>
              </div>
            ):(
              teamLunch?(
                <div style={{padding:"16px 20px",background:"var(--bg)",borderRadius:10,border:"1px solid var(--border)"}}>
                  <div style={{fontSize:20,fontWeight:800,color:"var(--accent)",fontFamily:"'JetBrains Mono',monospace",marginBottom:4}}>{teamLunch.date?new Date(teamLunch.date+"T00:00:00").toLocaleDateString("en-AU",{weekday:"long",day:"numeric",month:"long",year:"numeric"}):"Date TBC"}</div>
                  {teamLunch.time&&<div style={{fontSize:14,color:"var(--fg)",marginBottom:4}}>{teamLunch.time}</div>}
                  {teamLunch.location&&<div style={{fontSize:13,color:"var(--muted)"}}>📍 {teamLunch.location}</div>}
                  {teamLunch.notes&&<div style={{fontSize:13,color:"var(--muted)",marginTop:8}}>{teamLunch.notes}</div>}
                </div>
              ):(
                <div style={{padding:30,textAlign:"center",color:"var(--muted)",fontSize:13}}>No team lunch scheduled. Founders can set one.</div>
              )
            )}
          </div>
        </div>
      )}

      </div>
    </>)}

    {/* ═══ QUOTING TOOL ═══ */}
    {tool==="quoting"&&(<>
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
    {tool==="preproduction"&&(isFounder||role==="lead"||role==="editor")&&(<Preproduction/>)}

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
    {tool==="editors"&&(isFounder||role==="editor")&&(<EditorDashboard embedded/>)}

    {/* ═══ BUYER JOURNEY ═══ */}
    {tool==="buyerjourney"&&isFounder&&(<BuyerJourney data={buyerJourney} onChange={setBuyerJourney}/>)}

    {/* ═══ ACCOUNTS ═══ */}
    {tool==="accounts"&&isFounder&&(<AccountsDashboard accounts={accounts} setAccounts={setAccounts} turnaround={turnaround} setTurnaround={setTurnaround} editors={mondayEditorList} clients={clients} setClients={setClients} onDeletePath={p=>deletedPaths.current.push(p)} onSyncAttio={async()=>{const r=await fetch("/api/attio",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"currentCustomers"})});const d=await r.json();return d.companies||[];}}/>)}

    {/* ═══ DELIVERIES ═══ */}
    {tool==="deliveries"&&isFounder&&(()=>{
      const activeDelivery=deliveries.find(d=>d.id===activeDeliveryId);

      const getAcctLogo=(clientName)=>{if(!clientName)return null;const nameLC=clientName.toLowerCase();const match=Object.values(accounts).find(a=>a&&(a.companyName||"").toLowerCase()===nameLC);return match?.logoUrl||null;};

      const startImport=()=>{setImportMode(true);setImportLoading(true);fetchInProgressParents().then(items=>{setImportProjects(items);setImportLoading(false);}).catch(()=>setImportLoading(false));};
      const importProject=(proj)=>{
        const nameParts=proj.name.split(":");
        const clientName=nameParts.length>1?nameParts[0].trim():proj.name;
        const projectName=nameParts.length>1?nameParts.slice(1).join(":").trim():proj.name;
        const videos=(proj.subitems||[]).map(sub=>({id:`v-${sub.id}`,name:sub.name,link:"",viewixStatus:"In Development",revision1:"",revision2:"",notes:""}));
        const d={...newDelivery(clientName,projectName),videos,mondayItemId:proj.id};
        setDeliveries(p=>[...p,d]);
        setActiveDeliveryId(d.id);
        setImportMode(false);
      };
      const createBlank=()=>{const d=newDelivery("New Client","New Project");setDeliveries(p=>[...p,d]);setActiveDeliveryId(d.id);setImportMode(false);};
      const updateDelivery=(updated)=>{setDeliveries(p=>p.map(d=>d.id===updated.id?updated:d));};
      const deleteDelivery=(id)=>{setDeliveries(p=>p.filter(d=>d.id!==id));if(activeDeliveryId===id)setActiveDeliveryId(null);};
      const shareUrl=(id)=>`${window.location.origin}?d=${id}`;
      const copyLink=(id)=>{navigator.clipboard?.writeText(shareUrl(id));};

      if(activeDelivery){
        const d=activeDelivery;
        const setD=(patch)=>updateDelivery({...d,...patch});
        const addVideo=()=>setD({videos:[...d.videos,newVideo()]});
        const updateVideo=(vid,patch)=>setD({videos:d.videos.map(v=>v.id===vid?{...v,...patch}:v)});
        const removeVideo=(vid)=>setD({videos:d.videos.filter(v=>v.id!==vid)});
        const inputSt={padding:"8px 12px",borderRadius:6,border:"1px solid var(--border)",background:"var(--input-bg)",color:"var(--fg)",fontSize:13,outline:"none",width:"100%"};

        return(<>
          <div style={{padding:"12px 28px",borderBottom:"1px solid var(--border)",display:"flex",alignItems:"center",justifyContent:"space-between",background:"var(--card)"}}>
            <div style={{display:"flex",alignItems:"center",gap:12}}>
              <button onClick={()=>setActiveDeliveryId(null)} style={{...NB,fontSize:12}}>&larr; Back</button>
              <span style={{fontSize:15,fontWeight:700,color:"var(--fg)"}}>{d.clientName}: {d.projectName}</span>
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>copyLink(d.id)} style={{...BTN,background:"var(--accent)",color:"white"}}>Copy Share Link</button>
              <button onClick={()=>deleteDelivery(d.id)} style={{...BTN,background:"#374151",color:"#EF4444"}}>Delete</button>
            </div>
          </div>
          <div style={{maxWidth:1200,margin:"0 auto",padding:"24px 28px 60px"}}>
            {/* Project details */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginBottom:20}}>
              <div><label style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.04em",marginBottom:4,display:"block"}}>Client Name</label><input value={d.clientName} onChange={e=>setD({clientName:e.target.value})} style={inputSt}/></div>
              <div><label style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.04em",marginBottom:4,display:"block"}}>Project Name</label><input value={d.projectName} onChange={e=>setD({projectName:e.target.value})} style={inputSt}/></div>
              <div><label style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.04em",marginBottom:4,display:"block"}}>Client Logo URL</label><input value={d.logoUrl||""} onChange={e=>setD({logoUrl:e.target.value})} placeholder="https://..." style={inputSt}/></div>
            </div>

            {/* Share link */}
            <div style={{padding:"12px 16px",background:"var(--bg)",borderRadius:8,border:"1px solid var(--border)",marginBottom:20,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <div><span style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.04em"}}>Client Share Link</span><div style={{fontSize:12,color:"var(--accent)",marginTop:2,fontFamily:"'JetBrains Mono',monospace"}}>{shareUrl(d.id)}</div></div>
              <button onClick={()=>copyLink(d.id)} style={{...BTN,background:"var(--accent)",color:"white"}}>Copy</button>
            </div>

            {/* Videos table */}
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <span style={{fontSize:13,fontWeight:700,color:"var(--fg)"}}>Videos ({d.videos.length})</span>
              <button onClick={addVideo} style={{...BTN,background:"var(--accent)",color:"white"}}>+ Add Video</button>
            </div>
            {d.videos.length===0?(<div style={{textAlign:"center",padding:40,color:"var(--muted)",background:"var(--card)",borderRadius:12,border:"1px solid var(--border)"}}><div style={{fontSize:13}}>No videos yet. Click "+ Add Video" to start.</div></div>)
            :(<div style={{background:"var(--card)",border:"1px solid var(--border)",borderRadius:12,overflow:"hidden"}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
              <thead><tr>
                <th style={{...TH,textAlign:"left",padding:"8px 12px"}}>Video Name</th>
                <th style={{...TH,textAlign:"left",padding:"8px 12px",width:200}}>Link</th>
                <th style={{...TH,textAlign:"center",padding:"8px 12px",width:140}}>Viewix Status</th>
                <th style={{...TH,textAlign:"center",padding:"8px 12px",width:120}}>Rev Round 1</th>
                <th style={{...TH,textAlign:"center",padding:"8px 12px",width:120}}>Rev Round 2</th>
                <th style={{...TH,textAlign:"left",padding:"8px 12px",width:180}}>Notes</th>
                <th style={{...TH,width:40}}></th>
              </tr></thead>
              <tbody>{d.videos.map(v=>(<tr key={v.id}>
                <td style={{padding:"6px 12px",borderBottom:"1px solid var(--border-light)"}}><input value={v.name} onChange={e=>updateVideo(v.id,{name:e.target.value})} placeholder="Video name..." style={{...inputSt,fontWeight:600}}/></td>
                <td style={{padding:"6px 12px",borderBottom:"1px solid var(--border-light)"}}><input value={v.link} onChange={e=>updateVideo(v.id,{link:e.target.value})} placeholder="https://..." style={inputSt}/></td>
                <td style={{padding:"6px 12px",borderBottom:"1px solid var(--border-light)",textAlign:"center"}}><StatusSelect value={v.viewixStatus} options={VIEWIX_STATUSES} colors={VIEWIX_STATUS_COLORS} onChange={val=>updateVideo(v.id,{viewixStatus:val})}/></td>
                <td style={{padding:"6px 12px",borderBottom:"1px solid var(--border-light)",textAlign:"center"}}><StatusSelect value={v.revision1} options={CLIENT_REVISION_OPTIONS} colors={CLIENT_REVISION_COLORS} onChange={val=>updateVideo(v.id,{revision1:val})}/></td>
                <td style={{padding:"6px 12px",borderBottom:"1px solid var(--border-light)",textAlign:"center"}}><StatusSelect value={v.revision2} options={CLIENT_REVISION_OPTIONS} colors={CLIENT_REVISION_COLORS} onChange={val=>updateVideo(v.id,{revision2:val})}/></td>
                <td style={{padding:"6px 12px",borderBottom:"1px solid var(--border-light)"}}><input value={v.notes||""} onChange={e=>updateVideo(v.id,{notes:e.target.value})} placeholder="Notes..." style={inputSt}/></td>
                <td style={{padding:"6px 12px",borderBottom:"1px solid var(--border-light)",textAlign:"center"}}><button onClick={()=>removeVideo(v.id)} style={{background:"none",border:"none",cursor:"pointer",color:"#5A6B85",fontSize:16}}>x</button></td>
              </tr>))}</tbody>
            </table></div>)}
          </div>
        </>);
      }

      // Deliveries list
      return(<>
        <div style={{padding:"12px 28px",borderBottom:"1px solid var(--border)",display:"flex",alignItems:"center",justifyContent:"space-between",background:"var(--card)"}}>
          <span style={{fontSize:15,fontWeight:700,color:"var(--fg)"}}>Deliveries</span>
          <div style={{display:"flex",gap:8}}>
            <button onClick={startImport} style={{...BTN,background:"var(--accent)",color:"white"}}>+ Import from Monday.com</button>
            <button onClick={createBlank} style={{...BTN,background:"#374151",color:"var(--fg)"}}>+ Blank Delivery</button>
          </div>
        </div>
        <div style={{maxWidth:1200,margin:"0 auto",padding:"24px 28px 60px"}}>

          {/* Import picker */}
          {importMode&&(<div style={{marginBottom:24,background:"var(--card)",border:"1px solid var(--accent)",borderRadius:12,padding:"20px 24px"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
              <div style={{fontSize:13,fontWeight:700,color:"var(--fg)"}}>Select a project to import</div>
              <button onClick={()=>setImportMode(false)} style={{...BTN,background:"#374151",color:"#9CA3AF"}}>Cancel</button>
            </div>
            {importLoading?(<div style={{textAlign:"center",padding:30,color:"var(--muted)"}}>Loading projects from Monday.com...</div>)
            :importProjects.length===0?(<div style={{textAlign:"center",padding:30,color:"var(--muted)"}}>No "In Progress" projects found</div>)
            :(<div style={{display:"grid",gap:8,maxHeight:400,overflowY:"auto"}}>
              {importProjects.map(proj=>(<div key={proj.id} onClick={()=>importProject(proj)}
                style={{padding:"12px 16px",background:"var(--bg)",border:"1px solid var(--border)",borderRadius:8,cursor:"pointer",transition:"all 0.15s"}}>
                <div style={{fontSize:14,fontWeight:700,color:"var(--fg)"}}>{proj.name}</div>
                <div style={{fontSize:11,color:"var(--muted)",marginTop:2}}>{(proj.subitems||[]).length} sub-task{(proj.subitems||[]).length!==1?"s":""}</div>
              </div>))}
            </div>)}
          </div>)}

          {deliveries.length===0&&!importMode?(<div style={{textAlign:"center",padding:60,color:"var(--muted)",background:"var(--card)",borderRadius:12,border:"1px solid var(--border)"}}><div style={{fontSize:40,marginBottom:12}}>📦</div><div style={{fontSize:16,fontWeight:600,marginBottom:8}}>No deliveries yet</div><div style={{fontSize:13}}>Import from Monday.com or create a blank delivery</div></div>)
          :(<div style={{display:"grid",gap:12}}>
            {deliveries.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).map(d=>{
              const ready=d.videos.filter(v=>v.viewixStatus==="Completed"||v.viewixStatus==="Ready for Review").length;
              const approved=d.videos.filter(v=>v.revision1==="Approved").length;
              return(<div key={d.id} style={{background:"var(--card)",border:"1px solid var(--border)",borderRadius:10,padding:"16px 20px",cursor:"pointer",transition:"all 0.15s"}} onClick={()=>setActiveDeliveryId(d.id)}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div style={{display:"flex",alignItems:"center",gap:12}}>
                    {(getAcctLogo(d.clientName)||d.logoUrl)&&<img src={getAcctLogo(d.clientName)||d.logoUrl} alt="" onError={e=>{e.target.style.display="none";}} style={{height:28,borderRadius:4,objectFit:"contain",background:"#fff",padding:3}}/>}
                    <div>
                      <div style={{fontSize:15,fontWeight:700,color:"var(--fg)"}}>{d.clientName}</div>
                      <div style={{fontSize:12,color:"var(--muted)"}}>{d.projectName} · {d.videos.length} video{d.videos.length!==1?"s":""}</div>
                    </div>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:12}}>
                    <div style={{textAlign:"right"}}>
                      <div style={{fontSize:11,color:"var(--muted)"}}>{ready}/{d.videos.length} ready · {approved}/{d.videos.length} approved</div>
                    </div>
                    <button onClick={e=>{e.stopPropagation();copyLink(d.id);}} style={{...BTN,background:"var(--bg)",color:"var(--accent)",border:"1px solid var(--border)"}}>Copy Link</button>
                  </div>
                </div>
              </div>);
            })}
          </div>)}
        </div>
      </>);
    })()}

    {/* ═══ SHERPAS ═══ */}
    {tool==="sherpas"&&(<>
      <div style={{padding:"12px 28px",borderBottom:"1px solid var(--border)",display:"flex",alignItems:"center",justifyContent:"space-between",background:"var(--card)"}}>
        <span style={{fontSize:15,fontWeight:700,color:"var(--fg)"}}>Sherpas</span>
        {!clientAdding&&<button onClick={()=>setClientAdding(true)} style={{...BTN,background:"var(--accent)",color:"white"}}>+ Add Client</button>}
      </div>
      <div style={{maxWidth:900,margin:"0 auto",padding:"24px 28px 60px"}}>
        <a href="https://drive.google.com/drive/folders/1G11LcWKYrEckvh3ip_duYMyVNuoKAqnN" target="_blank" rel="noopener noreferrer" style={{display:"flex",alignItems:"center",gap:10,padding:"12px 16px",background:"var(--card)",border:"1px solid var(--border)",borderRadius:10,textDecoration:"none",marginBottom:20}}>
          <span style={{fontSize:18}}>📁</span>
          <span style={{fontSize:13,fontWeight:600,color:"var(--fg)"}}>Project Briefs</span>
          <span style={{marginLeft:"auto",color:"var(--muted)",fontSize:12}}>↗</span>
        </a>
        {clientAdding&&(<div style={{marginBottom:16,padding:"16px 20px",background:"var(--card)",border:"1px solid var(--accent)",borderRadius:10}}>
          <div style={{fontSize:13,fontWeight:700,color:"var(--fg)",marginBottom:12}}>New Client</div>
          <div style={{display:"flex",gap:8,marginBottom:8}}>
            <input type="text" value={clientNewName} onChange={e=>setClientNewName(e.target.value)} placeholder="Client name..." autoFocus
              style={{flex:1,padding:"10px 12px",borderRadius:8,border:"1px solid var(--border)",background:"var(--input-bg)",color:"var(--fg)",fontSize:14,fontWeight:600,outline:"none"}}/>
          </div>
          <div style={{display:"flex",gap:8,marginBottom:12}}>
            <input type="text" value={clientNewDoc} onChange={e=>setClientNewDoc(e.target.value)} placeholder="Google Doc URL (optional)..."
              style={{flex:1,padding:"10px 12px",borderRadius:8,border:"1px solid var(--border)",background:"var(--input-bg)",color:"var(--fg)",fontSize:13,outline:"none"}}/>
          </div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={()=>{if(!clientNewName.trim())return;setClients(p=>[...p,{id:`cl-${Date.now()}`,name:clientNewName.trim(),projectLead:"",docUrl:clientNewDoc.trim()}]);setClientNewName("");setClientNewDoc("");setClientAdding(false);}} style={{...BTN,background:"var(--accent)",color:"white"}}>Add</button>
            <button onClick={()=>{setClientAdding(false);setClientNewName("");setClientNewDoc("");}} style={{...BTN,background:"#374151",color:"#9CA3AF"}}>Cancel</button>
          </div>
        </div>)}
        {clients.length===0&&!clientAdding?(<div style={{textAlign:"center",padding:60,color:"var(--muted)",background:"var(--card)",borderRadius:12,border:"1px solid var(--border)"}}><div style={{fontSize:40,marginBottom:12}}>📋</div><div style={{fontSize:16,fontWeight:600,marginBottom:8}}>No clients yet</div><div style={{fontSize:13}}>Click "+ Add Client" to get started</div></div>)
        :(<div style={{display:"grid",gap:8}}>
          {clients.sort((a,b)=>(a.name||"").localeCompare(b.name||"")).map(cl=>{
            const isEditing=clientEditId===cl.id;
            return(<div key={cl.id} style={{background:"var(--card)",border:`1px solid ${isEditing?"var(--accent)":"var(--border)"}`,borderRadius:10,padding:"14px 20px"}}>
              {isEditing?(<div>
                <input type="text" defaultValue={cl.name} id={`cl-name-${cl.id}`}
                  style={{width:"100%",padding:"8px 12px",borderRadius:6,border:"1px solid var(--border)",background:"var(--input-bg)",color:"var(--fg)",fontSize:14,fontWeight:600,outline:"none",marginBottom:8}}/>
                <input type="text" defaultValue={cl.docUrl||""} id={`cl-doc-${cl.id}`} placeholder="Google Doc URL..."
                  style={{width:"100%",padding:"8px 12px",borderRadius:6,border:"1px solid var(--border)",background:"var(--input-bg)",color:"var(--fg)",fontSize:13,outline:"none",marginBottom:8}}/>
                {(cl.projectLead||cl.accountManager)&&<div style={{padding:"8px 12px",marginBottom:8,fontSize:12,color:"var(--muted)",background:"var(--bg)",borderRadius:6}}>
                  {cl.projectLead&&<span>Project Lead: <span style={{color:"var(--fg)",fontWeight:600}}>{cl.projectLead}</span></span>}
                  {cl.projectLead&&cl.accountManager&&<span style={{margin:"0 8px"}}>|</span>}
                  {cl.accountManager&&<span>Account Manager: <span style={{color:"var(--accent)",fontWeight:600}}>{cl.accountManager}</span></span>}
                </div>}
                <div style={{display:"flex",gap:8}}>
                  <button onClick={()=>{const n=document.getElementById(`cl-name-${cl.id}`)?.value?.trim();const d=document.getElementById(`cl-doc-${cl.id}`)?.value?.trim();if(!n)return;setClients(p=>p.map(c=>c.id===cl.id?{...c,name:n,docUrl:d||""}:c));setClientEditId(null);}} style={{...BTN,background:"var(--accent)",color:"white"}}>Save</button>
                  <button onClick={()=>setClientEditId(null)} style={{...BTN,background:"#374151",color:"#9CA3AF"}}>Cancel</button>
                  <button onClick={()=>{deletedPaths.current.push("/clients/"+cl.id);setClients(p=>p.filter(c=>c.id!==cl.id));setClientEditId(null);}} style={{...BTN,background:"#374151",color:"#EF4444",marginLeft:"auto"}}>Delete</button>
                </div>
              </div>)
              :(<div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div>
                  <div style={{fontSize:14,fontWeight:700,color:"var(--fg)"}}>{cl.name}</div>
                  {cl.projectLead&&<div style={{fontSize:12,color:"var(--muted)",marginTop:2}}>Project Lead: <span style={{color:"var(--fg)",fontWeight:600}}>{cl.projectLead}</span></div>}
                  {cl.accountManager&&<div style={{fontSize:12,color:"var(--muted)",marginTop:2}}>Account Manager: <span style={{color:"var(--accent)",fontWeight:600}}>{cl.accountManager}</span></div>}
                  {cl.docUrl&&<a href={cl.docUrl} target="_blank" rel="noopener noreferrer" style={{fontSize:12,color:"var(--accent)",textDecoration:"none",display:"inline-flex",alignItems:"center",gap:4,marginTop:4}}>📄 Open Google Doc</a>}
                </div>
                <button onClick={()=>setClientEditId(cl.id)} style={{...BTN,background:"var(--bg)",color:"var(--accent)",border:"1px solid var(--border)"}}>Edit</button>
              </div>)}
            </div>);
          })}
        </div>)}
      </div>
    </>)}

    {/* ═══ TRAINING ═══ */}
    {tool==="training"&&(()=>{
      const isAdmin=role==="founder"||role==="founders";
      const userName=isAdmin?"Jeremy":role==="closer"?"Team":"Editor";

      // Training helper functions
      const updateCat=(catId,patch)=>setTrainingData(p=>p.map(c=>c.id===catId?{...c,...patch}:c));
      const updateMod=(catId,modId,patch)=>setTrainingData(p=>p.map(c=>c.id===catId?{...c,modules:(c.modules||[]).map(m=>m.id===modId?{...m,...patch}:m)}:c));
      const addCategory=()=>{setTrainingData(p=>[...p,{id:`tc-${Date.now()}`,name:"New Category",order:p.length+1,modules:[]}]);};
      const deleteCat=(catId)=>setTrainingData(p=>p.filter(c=>c.id!==catId));
      const addModule=(catId)=>{setTrainingData(p=>p.map(c=>c.id===catId?{...c,modules:[...(c.modules||[]),{id:`tm-${Date.now()}`,name:"New Module",order:(c.modules||[]).length+1,description:"",videoUrl:"",comments:[],completions:{}}]}:c));};
      const deleteMod=(catId,modId)=>setTrainingData(p=>p.map(c=>c.id===catId?{...c,modules:(c.modules||[]).filter(m=>m.id!==modId)}:c));
      const addComment=(catId,modId,text)=>{if(!text.trim())return;updateMod(catId,modId,{comments:[...(trainingData.find(c=>c.id===catId)?.modules?.find(m=>m.id===modId)?.comments||[]),{id:`cmt-${Date.now()}`,author:userName,text:text.trim(),createdAt:new Date().toISOString()}]});};
      const reorderMod=(catId,modId,dir)=>{setTrainingData(p=>p.map(c=>{if(c.id!==catId)return c;const mods=[...(c.modules||[])].sort((a,b)=>(a.order||0)-(b.order||0));const idx=mods.findIndex(m=>m.id===modId);if(idx<0)return c;const swapIdx=idx+dir;if(swapIdx<0||swapIdx>=mods.length)return c;const tmp=mods[idx].order;mods[idx]={...mods[idx],order:mods[swapIdx].order};mods[swapIdx]={...mods[swapIdx],order:tmp};return{...c,modules:mods};}));};
      const reorderCat=(catId,dir)=>{setTrainingData(p=>{const idx=p.findIndex(c=>c.id===catId);if(idx<0)return p;const si=idx+dir;if(si<0||si>=p.length)return p;const n=[...p];[n[idx],n[si]]=[n[si],n[idx]];return n;});};
      const toggleCat=(catId)=>setCollapsedCats(p=>{const cur=p[catId]===undefined?true:p[catId];return{...p,[catId]:!cur};});
      const addSuggestion=(type,title,desc)=>{setTrainingSuggestions(p=>[...p,{id:`sug-${Date.now()}`,type,title,description:desc,author:userName,createdAt:new Date().toISOString(),status:"pending"}]);};
      const dismissSuggestion=(id)=>setTrainingSuggestions(p=>p.filter(s=>s.id!==id));

      // Find active module and its category
      let activeMod=null,activeCat=null;
      if(activeModuleId){trainingData.forEach(c=>{const m=(c.modules||[]).find(m2=>m2.id===activeModuleId);if(m){activeMod=m;activeCat=c;}});}

      // Module detail view
      if(activeMod&&activeCat){
        const videoId=activeMod.videoUrl?.match(/f\.io\/([^\s?]+)/)?.[1]||null;
        const completionCount=Object.keys(activeMod.completions||{}).length;
        const commentText=trainingCommentText;
        const setCommentText=setTrainingCommentText;

        return(<>
          <div style={{padding:"12px 28px",borderBottom:"1px solid var(--border)",display:"flex",alignItems:"center",justifyContent:"space-between",background:"var(--card)"}}>
            <div style={{display:"flex",alignItems:"center",gap:12}}>
              <button onClick={()=>setActiveModuleId(null)} style={{...NB,fontSize:12}}>&larr; Back</button>
              <div>
                <div style={{fontSize:11,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.04em"}}>{activeCat.name}</div>
                <div style={{fontSize:15,fontWeight:700,color:"var(--fg)"}}>{activeMod.name}</div>
              </div>
            </div>
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              {isAdmin&&!trainingEditMode&&(<button onClick={()=>setTrainingEditMode(true)} style={{...BTN,background:"var(--bg)",color:"var(--accent)",border:"1px solid var(--border)"}}>Edit Module</button>)}
            </div>
          </div>
          <div style={{maxWidth:900,margin:"0 auto",padding:"24px 28px 60px"}}>
            {/* Video embed */}
            {activeMod.videoUrl&&(<div style={{marginBottom:24,borderRadius:12,overflow:"hidden",background:"#000",aspectRatio:"16/9"}}>
              <iframe src={activeMod.videoUrl.includes("frame.io")||activeMod.videoUrl.includes("f.io")?activeMod.videoUrl:activeMod.videoUrl} style={{width:"100%",height:"100%",border:"none"}} allow="fullscreen" allowFullScreen/>
            </div>)}
            {!activeMod.videoUrl&&isAdmin&&(<div style={{marginBottom:24,padding:"40px 20px",textAlign:"center",background:"var(--card)",borderRadius:12,border:"1px dashed var(--border)",color:"var(--muted)"}}><div style={{fontSize:13}}>No video added. Edit this module to add a Frame.io link.</div></div>)}

            {/* Description */}
            {activeMod.description&&(<div style={{marginBottom:24,padding:"20px",background:"var(--card)",borderRadius:12,border:"1px solid var(--border)"}}>
              <div style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.04em",marginBottom:8}}>Description</div>
              <div style={{fontSize:14,color:"var(--fg)",lineHeight:1.7,whiteSpace:"pre-wrap"}}>{activeMod.description}</div>
            </div>)}

            {/* Admin edit */}
            {isAdmin&&trainingEditMode&&(<div style={{marginBottom:24,padding:"20px",background:"var(--card)",borderRadius:12,border:"1px solid var(--accent)"}}>
              <div style={{fontSize:12,fontWeight:700,color:"var(--fg)",marginBottom:12}}>Edit Module</div>
              <div style={{display:"grid",gap:10}}>
                <input value={activeMod.name} onChange={e=>updateMod(activeCat.id,activeMod.id,{name:e.target.value})} placeholder="Module name..." style={{padding:"10px 12px",borderRadius:8,border:"1px solid var(--border)",background:"var(--input-bg)",color:"var(--fg)",fontSize:14,fontWeight:600,outline:"none"}}/>
                <input value={activeMod.videoUrl||""} onChange={e=>updateMod(activeCat.id,activeMod.id,{videoUrl:e.target.value})} placeholder="Frame.io link (e.g. https://f.io/HVX4NtTD)..." style={{padding:"10px 12px",borderRadius:8,border:"1px solid var(--border)",background:"var(--input-bg)",color:"var(--fg)",fontSize:13,outline:"none"}}/>
                <textarea value={activeMod.description||""} onChange={e=>updateMod(activeCat.id,activeMod.id,{description:e.target.value})} placeholder="Module description..." rows={4} style={{padding:"10px 12px",borderRadius:8,border:"1px solid var(--border)",background:"var(--input-bg)",color:"var(--fg)",fontSize:13,outline:"none",resize:"vertical",fontFamily:"'DM Sans',sans-serif"}}/>
              </div>
              <button onClick={()=>setTrainingEditMode(false)} style={{...BTN,background:"#10B981",color:"white",marginTop:10}}>Done Editing</button>
            </div>)}

            {/* Comments */}
            <div style={{background:"var(--card)",borderRadius:12,border:"1px solid var(--border)",padding:"20px"}}>
              <div style={{fontSize:13,fontWeight:700,color:"var(--fg)",marginBottom:16}}>Comments ({(activeMod.comments||[]).length})</div>
              {(activeMod.comments||[]).length>0&&(<div style={{display:"grid",gap:8,marginBottom:16}}>
                {(activeMod.comments||[]).map(c=>(<div key={c.id} style={{padding:"12px",background:"var(--bg)",borderRadius:8}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                    <span style={{fontSize:12,fontWeight:700,color:"var(--accent)"}}>{c.author}</span>
                    <span style={{fontSize:10,color:"var(--muted)"}}>{new Date(c.createdAt).toLocaleDateString("en-AU",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})}</span>
                  </div>
                  <div style={{fontSize:13,color:"var(--fg)",lineHeight:1.5}}>{c.text}</div>
                </div>))}
              </div>)}
              <div style={{display:"flex",gap:8}}>
                <input value={commentText} onChange={e=>setCommentText(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&commentText.trim()){addComment(activeCat.id,activeMod.id,commentText);setCommentText("");}}} placeholder="Add a comment..." style={{flex:1,padding:"10px 12px",borderRadius:8,border:"1px solid var(--border)",background:"var(--input-bg)",color:"var(--fg)",fontSize:13,outline:"none"}}/>
                <button onClick={()=>{if(commentText.trim()){addComment(activeCat.id,activeMod.id,commentText);setCommentText("");}}} style={{...BTN,background:"var(--accent)",color:"white"}}>Post</button>
              </div>
            </div>
          </div>
        </>);
      }

      // Training list view
      const visibleTraining=role==="trial"
        ?trainingData.filter(c=>(c.name||"").toLowerCase().includes("trial"))
        :trainingData;

      return(<>
        <div style={{padding:"12px 28px",borderBottom:"1px solid var(--border)",display:"flex",alignItems:"center",justifyContent:"space-between",background:"var(--card)"}}>
          <span style={{fontSize:15,fontWeight:700,color:"var(--fg)"}}>Training</span>
          <div style={{display:"flex",gap:8}}>
            {!isAdmin&&<button onClick={()=>setSugOpen(!sugOpen)} style={{...BTN,background:"var(--bg)",color:"var(--accent)",border:"1px solid var(--border)"}}>{sugOpen?"Cancel":"Suggest"}</button>}
            {isAdmin&&<button onClick={addCategory} style={{...BTN,background:"var(--accent)",color:"white"}}>+ Add Category</button>}
          </div>
        </div>
        <div style={{maxWidth:900,margin:"0 auto",padding:"24px 28px 60px"}}>

          {/* Suggestion form (non-admin) */}
          {sugOpen&&(<div style={{marginBottom:24,padding:"20px",background:"var(--card)",border:"1px solid var(--accent)",borderRadius:12}}>
            <div style={{fontSize:13,fontWeight:700,color:"var(--fg)",marginBottom:12}}>Suggest a change</div>
            <div style={{display:"flex",gap:8,marginBottom:10}}>
              <button onClick={()=>setSugType("new")} style={{...BTN,background:sugType==="new"?"var(--accent)":"var(--bg)",color:sugType==="new"?"white":"var(--muted)",border:"1px solid var(--border)"}}>New Module</button>
              <button onClick={()=>setSugType("outdated")} style={{...BTN,background:sugType==="outdated"?"#F59E0B":"var(--bg)",color:sugType==="outdated"?"white":"var(--muted)",border:"1px solid var(--border)"}}>Flag Outdated</button>
            </div>
            <input value={sugTitle} onChange={e=>setSugTitle(e.target.value)} placeholder={sugType==="new"?"Module title...":"Which module needs updating..."} style={{width:"100%",padding:"10px 12px",borderRadius:8,border:"1px solid var(--border)",background:"var(--input-bg)",color:"var(--fg)",fontSize:13,outline:"none",marginBottom:8}}/>
            <textarea value={sugDesc} onChange={e=>setSugDesc(e.target.value)} placeholder="Details..." rows={3} style={{width:"100%",padding:"10px 12px",borderRadius:8,border:"1px solid var(--border)",background:"var(--input-bg)",color:"var(--fg)",fontSize:13,outline:"none",resize:"vertical",fontFamily:"'DM Sans',sans-serif",marginBottom:8}}/>
            <button onClick={()=>{if(sugTitle.trim()){addSuggestion(sugType,sugTitle,sugDesc);setSugTitle("");setSugDesc("");setSugOpen(false);}}} style={{...BTN,background:"var(--accent)",color:"white"}}>Submit</button>
          </div>)}

          {/* Pending suggestions (admin only) */}
          {isAdmin&&trainingSuggestions.filter(s=>s.status==="pending").length>0&&(<div style={{marginBottom:24,background:"var(--card)",border:"1px solid #F59E0B",borderRadius:12,padding:"16px 20px"}}>
            <div style={{fontSize:12,fontWeight:700,color:"#F59E0B",marginBottom:12}}>Suggestions ({trainingSuggestions.filter(s=>s.status==="pending").length})</div>
            <div style={{display:"grid",gap:8}}>
              {trainingSuggestions.filter(s=>s.status==="pending").map(s=>(<div key={s.id} style={{padding:"10px 12px",background:"var(--bg)",borderRadius:8,display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                <div>
                  <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:4}}>
                    <span style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:3,background:s.type==="new"?"rgba(0,130,250,0.12)":"rgba(245,158,11,0.12)",color:s.type==="new"?"#0082FA":"#F59E0B",textTransform:"uppercase"}}>{s.type==="new"?"New Module":"Outdated"}</span>
                    <span style={{fontSize:12,fontWeight:600,color:"var(--fg)"}}>{s.title}</span>
                  </div>
                  {s.description&&<div style={{fontSize:11,color:"var(--muted)"}}>{s.description}</div>}
                  <div style={{fontSize:10,color:"var(--muted)",marginTop:4}}>by {s.author} · {new Date(s.createdAt).toLocaleDateString("en-AU")}</div>
                </div>
                <button onClick={()=>dismissSuggestion(s.id)} style={{...BTN,background:"#374151",color:"#9CA3AF"}}>Dismiss</button>
              </div>))}
            </div>
          </div>)}

          {/* Categories and modules */}
          {visibleTraining.sort((a,b)=>(a.order||0)-(b.order||0)).map(cat=>{
            const isCollapsed=collapsedCats[cat.id]!==false;
            const sortedMods=(cat.modules||[]).sort((a,b)=>(a.order||0)-(b.order||0));
            return(<div key={cat.id} style={{marginBottom:20}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 16px",background:"var(--card)",border:"1px solid var(--border)",borderRadius:isCollapsed?10:"10px 10px 0 0",cursor:"pointer"}} onClick={()=>toggleCat(cat.id)}>
              {editCatId===cat.id?(<div style={{display:"flex",gap:8,flex:1}} onClick={e=>e.stopPropagation()}>
                <input value={editCatName} onChange={e=>setEditCatName(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"){updateCat(cat.id,{name:editCatName.trim()||cat.name});setEditCatId(null);}}} autoFocus style={{flex:1,padding:"6px 12px",borderRadius:6,border:"1px solid var(--accent)",background:"var(--input-bg)",color:"var(--fg)",fontSize:14,fontWeight:700,outline:"none"}}/>
                <button onClick={()=>{updateCat(cat.id,{name:editCatName.trim()||cat.name});setEditCatId(null);}} style={{...BTN,background:"#10B981",color:"white"}}>Save</button>
                <button onClick={()=>setEditCatId(null)} style={{...BTN,background:"#374151",color:"#9CA3AF"}}>Cancel</button>
              </div>)
              :(<div style={{display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:12,color:"var(--muted)",transition:"transform 0.2s",transform:isCollapsed?"rotate(-90deg)":"rotate(0deg)"}}>▼</span>
                <span style={{fontSize:15,fontWeight:800,color:"var(--fg)"}}>{cat.name}</span>
                <span style={{fontSize:11,color:"var(--muted)"}}>{sortedMods.length} module{sortedMods.length!==1?"s":""}</span>
              </div>)}
              {isAdmin&&editCatId!==cat.id&&(<div style={{display:"flex",gap:6}} onClick={e=>e.stopPropagation()}>
                <button onClick={()=>reorderCat(cat.id,-1)} style={{background:"none",border:"1px solid var(--border)",borderRadius:6,color:"var(--muted)",cursor:"pointer",fontSize:11,padding:"4px 8px"}}>▲</button>
                <button onClick={()=>reorderCat(cat.id,1)} style={{background:"none",border:"1px solid var(--border)",borderRadius:6,color:"var(--muted)",cursor:"pointer",fontSize:11,padding:"4px 8px"}}>▼</button>
                <button onClick={()=>{setEditCatId(cat.id);setEditCatName(cat.name);}} style={{...BTN,background:"var(--bg)",color:"var(--muted)",border:"1px solid var(--border)"}}>Rename</button>
                <button onClick={()=>addModule(cat.id)} style={{...BTN,background:"var(--bg)",color:"var(--accent)",border:"1px solid var(--border)"}}>+ Module</button>
                {sortedMods.length===0&&<button onClick={()=>deleteCat(cat.id)} style={{...BTN,background:"#374151",color:"#EF4444"}}>Delete</button>}
              </div>)}
            </div>
            {!isCollapsed&&<div style={{display:"grid",gap:1}}>
              {sortedMods.map((mod,idx)=>{
                const commentCount=(mod.comments||[]).length;
                return(<div key={mod.id} style={{background:"var(--card)",borderLeft:"1px solid var(--border)",borderRight:"1px solid var(--border)",borderBottom:"1px solid var(--border)",padding:"12px 20px",display:"flex",justifyContent:"space-between",alignItems:"center",borderRadius:idx===sortedMods.length-1?"0 0 10px 10px":"0"}}>
                  {editModId===mod.id?(<div style={{display:"flex",gap:8,flex:1}} onClick={e=>e.stopPropagation()}>
                    <input value={editModName} onChange={e=>setEditModName(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"){updateMod(cat.id,mod.id,{name:editModName.trim()||mod.name});setEditModId(null);}}} autoFocus style={{flex:1,padding:"6px 12px",borderRadius:6,border:"1px solid var(--accent)",background:"var(--input-bg)",color:"var(--fg)",fontSize:13,fontWeight:600,outline:"none"}}/>
                    <button onClick={()=>{updateMod(cat.id,mod.id,{name:editModName.trim()||mod.name});setEditModId(null);}} style={{...BTN,background:"#10B981",color:"white"}}>Save</button>
                    <button onClick={()=>setEditModId(null)} style={{...BTN,background:"#374151",color:"#9CA3AF"}}>Cancel</button>
                  </div>)
                  :(<div style={{display:"flex",alignItems:"center",gap:12,cursor:"pointer",flex:1}} onClick={()=>setActiveModuleId(mod.id)}>
                    <span style={{fontSize:13,fontWeight:800,color:"var(--muted)",fontFamily:"'JetBrains Mono',monospace",width:24,textAlign:"center"}}>{idx+1}</span>
                    <div>
                      <div style={{fontSize:14,fontWeight:600,color:"var(--fg)"}}>{mod.name}</div>
                      <div style={{display:"flex",gap:8,marginTop:2}}>
                        {mod.videoUrl&&<span style={{fontSize:10,color:"var(--accent)"}}>🎥 Video</span>}
                        {commentCount>0&&<span style={{fontSize:10,color:"var(--muted)"}}>{commentCount} comment{commentCount!==1?"s":""}</span>}
                      </div>
                    </div>
                  </div>)}
                  <div style={{display:"flex",gap:4,alignItems:"center"}}>
                    {isAdmin&&editModId!==mod.id&&(<>
                      <button onClick={e=>{e.stopPropagation();reorderMod(cat.id,mod.id,-1);}} style={{background:"none",border:"none",cursor:"pointer",color:"var(--muted)",fontSize:10,padding:"2px 4px"}} title="Move up">▲</button>
                      <button onClick={e=>{e.stopPropagation();reorderMod(cat.id,mod.id,1);}} style={{background:"none",border:"none",cursor:"pointer",color:"var(--muted)",fontSize:10,padding:"2px 4px"}} title="Move down">▼</button>
                      <button onClick={e=>{e.stopPropagation();setEditModId(mod.id);setEditModName(mod.name);}} style={{background:"none",border:"none",cursor:"pointer",color:"var(--muted)",fontSize:10,padding:"2px 4px"}} title="Rename">✏️</button>
                      <button onClick={e=>{e.stopPropagation();deleteMod(cat.id,mod.id);}} style={{background:"none",border:"none",cursor:"pointer",color:"#5A6B85",fontSize:14,padding:"2px 4px"}}>x</button>
                    </>)}
                    {editModId!==mod.id&&<span style={{color:"var(--muted)",fontSize:14,cursor:"pointer"}} onClick={()=>setActiveModuleId(mod.id)}>→</span>}
                  </div>
                </div>);
              })}
            </div>}
          </div>);})}
        </div>
      </>);
    })()}

    {/* ═══ HOME ═══ */}
    {tool==="home"&&(<>
      <div style={{padding:"12px 28px",borderBottom:"1px solid var(--border)",display:"flex",alignItems:"center",justifyContent:"space-between",background:"var(--card)"}}>
        <span style={{fontSize:15,fontWeight:700,color:"var(--fg)"}}>Home</span>
      </div>
      <div style={{maxWidth:900,margin:"0 auto",padding:"24px 28px 60px"}}>

        {/* Team Quote */}
        <div style={{marginBottom:20,padding:"28px 32px",background:"var(--card)",border:"1px solid var(--border)",borderRadius:12,textAlign:"center"}}>
          {isFounders?(
            <div>
              <textarea value={foundersData.teamQuote||""} onChange={e=>setFoundersData(p=>({...p,teamQuote:e.target.value}))} placeholder="Add an inspiring quote or message for the team..." rows={2} style={{width:"100%",textAlign:"center",fontSize:18,fontWeight:600,fontStyle:"italic",color:"var(--fg)",background:"transparent",border:"none",borderBottom:"1px dashed #3A4558",outline:"none",resize:"none",fontFamily:"'DM Sans',sans-serif",lineHeight:1.6}}/>
              <div style={{fontSize:10,color:"var(--muted)",marginTop:8}}>Only founders can edit this</div>
            </div>
          ):(
            foundersData.teamQuote?(
              <div style={{fontSize:18,fontWeight:600,fontStyle:"italic",color:"var(--fg)",lineHeight:1.6}}>"{foundersData.teamQuote}"</div>
            ):(
              <div style={{fontSize:14,color:"var(--muted)",fontStyle:"italic"}}>Welcome to Viewix Tools</div>
            )
          )}
        </div>

        {/* Next Team Lunch */}
        <div style={{background:"var(--card)",border:"1px solid var(--border)",borderRadius:12,padding:"24px",marginBottom:20}}>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
            <span style={{fontSize:24}}>🍕</span>
            <div>
              <div style={{fontSize:17,fontWeight:800,color:"var(--fg)"}}>Next Team Lunch</div>
              <div style={{fontSize:12,color:"var(--muted)"}}>Get together and celebrate wins</div>
            </div>
          </div>
          {teamLunch?(
            <div style={{padding:"16px 20px",background:"var(--bg)",borderRadius:10,border:"1px solid var(--border)"}}>
              <div style={{fontSize:20,fontWeight:800,color:"var(--accent)",fontFamily:"'JetBrains Mono',monospace",marginBottom:4}}>{teamLunch.date?new Date(teamLunch.date+"T00:00:00").toLocaleDateString("en-AU",{weekday:"long",day:"numeric",month:"long",year:"numeric"}):"Date TBC"}</div>
              {teamLunch.time&&<div style={{fontSize:14,color:"var(--fg)",marginBottom:4}}>{teamLunch.time}</div>}
              {teamLunch.location&&<div style={{fontSize:13,color:"var(--muted)"}}>📍 {teamLunch.location}</div>}
              {teamLunch.notes&&<div style={{fontSize:13,color:"var(--muted)",marginTop:8}}>{teamLunch.notes}</div>}
            </div>
          ):(
            <div style={{padding:40,textAlign:"center",color:"var(--muted)",background:"var(--bg)",borderRadius:10}}>
              <div style={{fontSize:16,fontWeight:600,marginBottom:4}}>No team lunch scheduled</div>
              <div style={{fontSize:12}}>Founders can set the next lunch from the Founders tab</div>
            </div>
          )}
        </div>

        {/* Google Reviews */}
        <a href="https://www.google.com/maps/place/?q=place_id:ChIJ87p3vJ9QRAIRRkX7FtSsJTo" target="_blank" rel="noopener noreferrer" style={{display:"block",marginBottom:20,padding:"20px 24px",background:"var(--card)",border:"1px solid var(--border)",borderRadius:12,textDecoration:"none",cursor:"pointer"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
            <div style={{display:"flex",alignItems:"center",gap:12}}>
              <span style={{fontSize:28}}>⭐</span>
              <div>
                <div style={{fontSize:15,fontWeight:700,color:"var(--fg)"}}>Google Reviews</div>
                <div style={{fontSize:12,color:"var(--muted)"}}>Viewix Video Production</div>
              </div>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:16}}>
              <div style={{textAlign:"center",padding:"8px 16px",background:"var(--bg)",borderRadius:8}}>
                <div style={{fontSize:32,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:"#F59E0B"}}>{googleReviewData?.rating||foundersData.googleRating||"5.0"}</div>
                <div style={{fontSize:10,color:"var(--muted)",fontWeight:600,marginTop:2}}>RATING</div>
              </div>
              <div style={{textAlign:"center",padding:"8px 16px",background:"var(--bg)",borderRadius:8}}>
                <div style={{fontSize:32,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:"var(--fg)"}}>{googleReviewData?.reviewCount||foundersData.googleReviews||57}</div>
                <div style={{fontSize:10,color:"var(--muted)",fontWeight:600,marginTop:2}}>REVIEWS</div>
              </div>
              <span style={{color:"var(--muted)",fontSize:14}}>↗</span>
            </div>
          </div>
        </a>

        {/* Quick Links */}
        <div style={{background:"var(--card)",border:"1px solid var(--border)",borderRadius:12,padding:"24px"}}>
          <div style={{fontSize:15,fontWeight:700,color:"var(--fg)",marginBottom:16}}>Quick Links</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
            {[
              {icon:"🎬",label:"Frame.io",url:"https://app.frame.io"},
              {icon:"📊",label:"Viewix Website",url:"https://viewix.com.au"},
              {icon:"📍",label:"Google Maps",url:"https://www.google.com/maps/place/?q=place_id:ChIJ87p3vJ9QRAIRRkX7FtSsJTo"},
            ].map(link=>(
              <a key={link.label} href={link.url} target="_blank" rel="noopener noreferrer" style={{padding:"14px 16px",background:"var(--bg)",border:"1px solid var(--border)",borderRadius:10,textDecoration:"none",display:"flex",alignItems:"center",gap:10,transition:"all 0.15s"}}>
                <span style={{fontSize:18}}>{link.icon}</span>
                <span style={{fontSize:13,fontWeight:600,color:"var(--fg)"}}>{link.label}</span>
                <span style={{marginLeft:"auto",color:"var(--muted)",fontSize:12}}>↗</span>
              </a>
            ))}
          </div>
        </div>
      </div>
    </>)}

    {/* ═══ FOUNDERS ═══ */}
    {tool==="founders"&&isFounders&&(()=>{
      const REVENUE_TARGET=foundersData.revenueTarget||3000000;
      const now=new Date();
      const dayOfYear=Math.floor((now-new Date(now.getFullYear(),0,0))/(1000*60*60*24));
      const daysInYear=365;
      const yearProgress=dayOfYear/daysInYear;

      const currentRevenue=foundersData.currentRevenue||0;
      const revenueProgress=REVENUE_TARGET>0?currentRevenue/REVENUE_TARGET:0;
      const onTrackRevenue=REVENUE_TARGET*yearProgress;
      const revenueDelta=currentRevenue-onTrackRevenue;



      const updateRevenue=val=>{setFoundersData(p=>({...p,currentRevenue:parseFloat(val)||0}));};
      const updateMetric=(key,val)=>{setFoundersData(p=>({...p,[key]:val}));};

      return(<>
        <div style={{padding:"12px 28px",borderBottom:"1px solid var(--border)",display:"flex",alignItems:"center",justifyContent:"space-between",background:"var(--card)"}}>
          <span style={{fontSize:15,fontWeight:700,color:"var(--fg)"}}>Founders Dashboard</span>
          <div style={{display:"flex",gap:3,background:"var(--bg)",borderRadius:8,padding:3}}>
            {[{key:"dashboard",label:"Dashboard"},{key:"data",label:"Data"},{key:"learnings",label:"AI Learnings"}].map(t=>(<button key={t.key} onClick={()=>setFoundersTab(t.key)} style={{padding:"7px 14px",borderRadius:6,border:"none",background:foundersTab===t.key?"var(--card)":"transparent",color:foundersTab===t.key?"var(--fg)":"var(--muted)",fontSize:12,fontWeight:600,cursor:"pointer"}}>{t.label}</button>))}
          </div>
        </div>
        <div style={{maxWidth:1200,margin:"0 auto",padding:"24px 28px 60px"}}>

          {foundersTab==="dashboard"&&(<>

          {/* Revenue Tracker */}
          <div style={{marginBottom:20,padding:"24px",background:"var(--card)",border:"1px solid var(--border)",borderRadius:12}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}}>
              <div>
                <div style={{fontSize:12,color:"var(--muted)",fontWeight:600,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:4}}>Revenue Target {now.getFullYear()}</div>
                <div style={{display:"flex",alignItems:"center",gap:4}}><span style={{fontSize:14,color:"var(--muted)"}}>$</span><input type="number" value={REVENUE_TARGET||""} onChange={e=>updateMetric("revenueTarget",parseFloat(e.target.value)||0)} style={{fontSize:32,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:"var(--fg)",background:"transparent",border:"none",borderBottom:"1px dashed #3A4558",outline:"none",width:260}}/></div>
              </div>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:12,color:"var(--muted)",fontWeight:600,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:4}}>Current Revenue (YTD)</div>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontSize:11,color:"var(--muted)"}}>$</span>
                  <input type="number" value={currentRevenue||""} onChange={e=>updateRevenue(e.target.value)} placeholder="0" style={{fontSize:28,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:"#10B981",background:"transparent",border:"none",borderBottom:"1px dashed #3A4558",outline:"none",width:200,textAlign:"right"}}/>
                </div>
              </div>
            </div>
            {/* Progress bar */}
            <div style={{marginBottom:12}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                <span style={{fontSize:11,color:"var(--muted)"}}>Progress: {pct(revenueProgress)}</span>
                <span style={{fontSize:11,color:"var(--muted)"}}>Year: {pct(yearProgress)} through</span>
              </div>
              <div style={{width:"100%",height:20,background:"var(--bar-bg)",borderRadius:10,overflow:"hidden",position:"relative"}}>
                <div style={{width:`${Math.min(revenueProgress*100,100)}%`,height:"100%",borderRadius:10,background:revenueProgress>=yearProgress?"#10B981":"#EF4444",transition:"width 0.4s"}}/>
                <div style={{position:"absolute",left:`${yearProgress*100}%`,top:0,bottom:0,width:2,background:"#F59E0B"}} title="Where you should be"/>
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12}}>
              <div style={{padding:"12px 16px",background:"var(--bg)",borderRadius:8}}>
                <div style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",marginBottom:4}}>On Track Amount</div>
                <div style={{fontSize:18,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:"var(--fg)"}}>{fmtCur(onTrackRevenue)}</div>
              </div>
              <div style={{padding:"12px 16px",background:"var(--bg)",borderRadius:8}}>
                <div style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",marginBottom:4}}>Delta</div>
                <div style={{fontSize:18,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:revenueDelta>=0?"#10B981":"#EF4444"}}>{revenueDelta>=0?"+":""}{fmtCur(revenueDelta)}</div>
              </div>
              <div style={{padding:"12px 16px",background:"var(--bg)",borderRadius:8}}>
                <div style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",marginBottom:4}}>Monthly Run Rate Needed</div>
                <div style={{fontSize:18,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:"var(--fg)"}}>{fmtCur(Math.max(0,(REVENUE_TARGET-currentRevenue)/(12-now.getMonth())))}</div>
              </div>
            </div>
          </div>

          {/* North Star Metrics */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))",gap:12,marginBottom:20}}>
            {[
              {key:"monthlyRevenue",label:"Monthly Revenue",prefix:"$"},
              {key:"activeClients",label:"Active Clients",prefix:""},
              {key:"avgRetainerValue",label:"Avg Retainer Value",prefix:"$"},
              {key:"clientChurnRate",label:"Client Churn Rate",suffix:"%"},
              {key:"leadPipelineValue",label:"Lead Pipeline Value",prefix:"$"},
              {key:"closingRate",label:"Close Rate (3mo)",suffix:"%"},
            ].map(m=>(
              <div key={m.key} style={{background:"var(--card)",border:"1px solid var(--border)",borderRadius:10,padding:"16px 20px"}}>
                <div style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.04em",marginBottom:6}}>{m.label}</div>
                <div style={{display:"flex",alignItems:"center",gap:4}}>
                  {m.prefix&&<span style={{fontSize:14,color:"var(--muted)"}}>{m.prefix}</span>}
                  <input type="number" value={foundersData[m.key]||""} onChange={e=>updateMetric(m.key,parseFloat(e.target.value)||0)} placeholder="0" style={{fontSize:24,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:"var(--fg)",background:"transparent",border:"none",borderBottom:"1px dashed #3A4558",outline:"none",width:"100%"}}/>
                  {m.suffix&&<span style={{fontSize:14,color:"var(--muted)"}}>{m.suffix}</span>}
                </div>
              </div>
            ))}
          </div>
          {attioDeals?.data&&<div style={{fontSize:11,color:"var(--accent)",marginTop:-12,marginBottom:16,padding:"0 4px"}}>✓ Auto-populated from Attio. Values are still editable.</div>}

          {/* Attio Monthly Revenue */}
          <div style={{marginBottom:20,padding:"20px 24px",background:"var(--card)",border:"1px solid var(--border)",borderRadius:12}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
              <div>
                <div style={{fontSize:13,fontWeight:700,color:"var(--fg)"}}>Monthly Revenue (Attio)</div>
                <div style={{fontSize:11,color:"var(--muted)",marginTop:2}}>
                  All time deal revenue by month
                  {attioDeals?.lastSyncedAt&&(()=>{
                    const ms=Date.now()-new Date(attioDeals.lastSyncedAt).getTime();
                    const mins=Math.floor(ms/60000);
                    const hrs=Math.floor(mins/60);
                    const days=Math.floor(hrs/24);
                    const label=days>0?`${days}d ago`:hrs>0?`${hrs}h ago`:mins>0?`${mins}m ago`:"just now";
                    return <span style={{marginLeft:8,color:"var(--accent)"}}>· Cached {label}</span>;
                  })()}
                </div>
              </div>
              <button onClick={()=>{
                setAttioLoading(true);
                fetch("/api/attio",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"all_deals"})})
                  .then(r=>r.json())
                  .then(data=>{
                    const lastSyncedAt=new Date().toISOString();
                    setAttioDeals({...data,lastSyncedAt});
                    // Persist the cache so the data stays across reloads and is updated
                    // by the deal-won webhook. Writing via fbSet hits the same /attioCache
                    // path the webhook uses (admin SDK).
                    if(data?.data){
                      fbSet("/attioCache",{data:data.data,total:data.total||data.data.length,lastSyncedAt,lastSyncTrigger:"manual"});
                    }
                    // Auto-calculate metrics from deals
                    if(data?.data){
                      const extractVal=d=>{const v=d.values;const candidates=[v?.deal_value,v?.amount,v?.value,v?.revenue,v?.contract_value];for(const c of candidates){if(c?.[0]!=null){const n=c[0].currency_value??c[0].value;if(n!=null)return typeof n==="number"?n:parseFloat(n)||0;}}return 0;};
                      const extractDate=d=>{const v=d.values;const candidates=[v?.close_date,v?.closed_at,v?.won_date,v?.created_at];for(const c of candidates){if(c?.[0]?.value){return c[0].value;}}return d.created_at||null;};
                      const extractStage=d=>{const v=d.values;const candidates=[v?.stage,v?.status,v?.deal_stage,v?.pipeline_stage];for(const c of candidates){const t=c?.[0]?.status?.title||c?.[0]?.value;if(t)return(typeof t==="string"?t:"").toLowerCase();}return "";};
                      const extractCompany=d=>{const v=d.values;const candidates=[v?.company,v?.client,v?.account,v?.organisation,v?.name,v?.deal_name];for(const c of candidates){const t=c?.[0]?.value;if(t){if(typeof t==="string")return t;if(t?.name)return t.name;}}return null;};

                      const thisYear=now.getFullYear();
                      const thisMonth=now.getMonth();
                      const wonKeywords=["won","closed won","closed","completed","signed"];
                      const lostKeywords=["lost","closed lost","rejected","cancelled"];

                      let ytdRevenue=0;
                      let currentMonthRevenue=0;
                      let activeCompanies=new Set();
                      let pipelineValue=0;
                      let wonCount=0;
                      let totalClosed=0;
                      let activeRetainerTotal=0;
                      let activeRetainerCount=0;
                      let recentWon=0;
                      let recentClosed=0;
                      const threeMonthsAgo=new Date();threeMonthsAgo.setMonth(threeMonthsAgo.getMonth()-3);

                      data.data.forEach(d=>{
                        const val=extractVal(d);
                        const dateStr=extractDate(d);
                        const stage=extractStage(d);
                        const company=extractCompany(d);
                        const isWon=wonKeywords.some(k=>stage.includes(k));
                        const isLost=lostKeywords.some(k=>stage.includes(k));
                        const isOpen=!isWon&&!isLost;

                        if(isWon||isLost)totalClosed++;
                        if(isWon)wonCount++;

                        if((isWon||isLost)&&dateStr){
                          const dt=new Date(dateStr);
                          if(!isNaN(dt)&&dt>=threeMonthsAgo){
                            recentClosed++;
                            if(isWon)recentWon++;
                          }
                        }

                        if(isWon&&dateStr){
                          const dt=new Date(dateStr);
                          if(!isNaN(dt)){
                            if(dt.getFullYear()===thisYear)ytdRevenue+=val;
                            if(dt.getFullYear()===thisYear&&dt.getMonth()===thisMonth)currentMonthRevenue+=val;
                          }
                        }
                        if(isOpen){
                          pipelineValue+=val;
                          if(company)activeCompanies.add(company);
                        }
                        if(isWon&&val>0){activeRetainerTotal+=val;activeRetainerCount++;}
                      });

                      const closingRate=recentClosed>0?Math.round((recentWon/recentClosed)*100):0;
                      const avgRetainer=activeRetainerCount>0?Math.round(activeRetainerTotal/activeRetainerCount):0;

                      setFoundersData(p=>({...p,
                        monthlyRevenue:currentMonthRevenue||p.monthlyRevenue,
                        activeClients:activeCompanies.size||p.activeClients,
                        avgRetainerValue:avgRetainer||p.avgRetainerValue,
                        leadPipelineValue:pipelineValue||p.leadPipelineValue,
                        closingRate:closingRate||p.closingRate,
                      }));
                      if(ytdRevenue>0)updateRevenue(ytdRevenue);
                    }
                    setAttioLoading(false);
                  })
                  .catch(e=>{console.error("Attio fetch error:",e);setAttioLoading(false);});
              }} style={{...BTN,background:"var(--accent)",color:"white",padding:"8px 16px"}}>{attioLoading?"Syncing...":"Sync from Attio"}</button>
            </div>
            {attioDeals?.data?(()=>{
              // Extract value and date from deals, trying multiple field name patterns
              const extractVal=d=>{const v=d.values;const candidates=[v?.deal_value,v?.amount,v?.value,v?.revenue,v?.contract_value];for(const c of candidates){if(c?.[0]!=null){const n=c[0].currency_value??c[0].value;if(n!=null)return typeof n==="number"?n:parseFloat(n)||0;}}return 0;};
              const extractDate=d=>{const v=d.values;const candidates=[v?.close_date,v?.closed_at,v?.won_date,v?.created_at];for(const c of candidates){if(c?.[0]?.value){return c[0].value;}}return d.created_at||null;};
              const extractStage2=d=>{const v=d.values;const candidates=[v?.stage,v?.status,v?.deal_stage,v?.pipeline_stage];for(const c of candidates){const t=c?.[0]?.status?.title||c?.[0]?.value;if(t)return(typeof t==="string"?t:"").toLowerCase();}return "";};
              const wonKw=["won","closed won","closed-won","completed","signed","active"];

              // Build monthly totals (won deals only)
              const monthly={};
              let allTimeTotal=0;
              let dealCount=0;
              attioDeals.data.forEach(d=>{
                const val=extractVal(d);
                const dateStr=extractDate(d);
                const stage=extractStage2(d);
                const isWon=wonKw.some(k=>stage.includes(k));
                if(val>0&&dateStr&&isWon){
                  const dt=new Date(dateStr);
                  if(!isNaN(dt)){
                    const key=`${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}`;
                    if(!monthly[key])monthly[key]={revenue:0,count:0,label:dt.toLocaleDateString("en-AU",{month:"short",year:"numeric"})};
                    monthly[key].revenue+=val;
                    monthly[key].count+=1;
                    allTimeTotal+=val;
                    dealCount+=1;
                  }
                }
              });
              const sorted=Object.entries(monthly).sort((a,b)=>b[0].localeCompare(a[0]));
              const maxRev=Math.max(...sorted.map(([_,m])=>m.revenue),1);

              return(<div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginBottom:20}}>
                  <div style={{padding:"12px 16px",background:"var(--bg)",borderRadius:8}}>
                    <div style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",marginBottom:4}}>All Time Revenue</div>
                    <div style={{fontSize:22,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:"#10B981"}}>{fmtCur(allTimeTotal)}</div>
                  </div>
                  <div style={{padding:"12px 16px",background:"var(--bg)",borderRadius:8}}>
                    <div style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",marginBottom:4}}>Total Deals</div>
                    <div style={{fontSize:22,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:"var(--fg)"}}>{dealCount}</div>
                  </div>
                  <div style={{padding:"12px 16px",background:"var(--bg)",borderRadius:8}}>
                    <div style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",marginBottom:4}}>Avg Deal Size</div>
                    <div style={{fontSize:22,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:"var(--fg)"}}>{dealCount>0?fmtCur(allTimeTotal/dealCount):"$0"}</div>
                  </div>
                </div>

                {/* Bar chart */}
                {sorted.length>0&&(<div style={{marginBottom:20}}>
                  <div style={{display:"flex",alignItems:"flex-end",gap:3,height:140,padding:"0 4px"}}>
                    {sorted.slice(0,24).reverse().map(([key,m])=>{
                      const h=Math.max((m.revenue/maxRev)*120,4);
                      const isCurrentMonth=key===`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;
                      return(<div key={key} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:2,minWidth:0}}>
                        <div style={{fontSize:8,fontWeight:700,color:"var(--muted)",fontFamily:"'JetBrains Mono',monospace",whiteSpace:"nowrap",overflow:"hidden"}}>{fmtCur(m.revenue).replace("$","")}</div>
                        <div style={{width:"80%",height:h,background:isCurrentMonth?"var(--accent)":"#10B981",borderRadius:"3px 3px 0 0",opacity:isCurrentMonth?1:0.7}} title={`${m.label}: ${fmtCur(m.revenue)} (${m.count} deals)`}/>
                        <div style={{fontSize:7,color:"var(--muted)",fontFamily:"'JetBrains Mono',monospace",whiteSpace:"nowrap"}}>{m.label.replace(" ","\\n").split(" ")[0]}</div>
                      </div>);
                    })}
                  </div>
                </div>)}

                {/* Monthly table */}
                <div style={{overflowX:"auto"}}>
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                    <thead><tr>
                      <th style={{padding:"8px 12px",fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",borderBottom:"2px solid var(--border)",textAlign:"left"}}>Month</th>
                      <th style={{padding:"8px 12px",fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",borderBottom:"2px solid var(--border)",textAlign:"right"}}>Revenue</th>
                      <th style={{padding:"8px 12px",fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",borderBottom:"2px solid var(--border)",textAlign:"center"}}>Deals</th>
                      <th style={{padding:"8px 12px",fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",borderBottom:"2px solid var(--border)",textAlign:"right"}}>Avg Deal</th>
                      <th style={{padding:"8px 12px",fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",borderBottom:"2px solid var(--border)",textAlign:"left",width:"40%"}}></th>
                    </tr></thead>
                    <tbody>{(revenueTableExpanded?sorted:sorted.slice(0,4)).map(([key,m])=>{
                      const barW=maxRev>0?Math.max((m.revenue/maxRev)*100,2):0;
                      return(<tr key={key}>
                        <td style={{padding:"8px 12px",borderBottom:"1px solid var(--border-light)",color:"var(--fg)",fontWeight:600}}>{m.label}</td>
                        <td style={{padding:"8px 12px",borderBottom:"1px solid var(--border-light)",textAlign:"right",fontFamily:"'JetBrains Mono',monospace",color:"#10B981",fontWeight:700}}>{fmtCur(m.revenue)}</td>
                        <td style={{padding:"8px 12px",borderBottom:"1px solid var(--border-light)",textAlign:"center",fontFamily:"'JetBrains Mono',monospace",color:"var(--fg)"}}>{m.count}</td>
                        <td style={{padding:"8px 12px",borderBottom:"1px solid var(--border-light)",textAlign:"right",fontFamily:"'JetBrains Mono',monospace",color:"var(--muted)"}}>{fmtCur(m.count>0?m.revenue/m.count:0)}</td>
                        <td style={{padding:"8px 12px",borderBottom:"1px solid var(--border-light)"}}><div style={{width:`${barW}%`,height:8,background:"#10B981",borderRadius:4,opacity:0.5}}/></td>
                      </tr>);
                    })}</tbody>
                  </table>
                  {sorted.length>4&&<button onClick={()=>setRevenueTableExpanded(!revenueTableExpanded)} style={{width:"100%",padding:"10px",background:"transparent",border:"none",color:"var(--accent)",fontSize:12,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>{revenueTableExpanded?`Show less ▴`:`Show all ${sorted.length} months ▾`}</button>}
                </div>
                {attioDeals.data.length>0&&sorted.length===0&&<div style={{padding:20,textAlign:"center",color:"var(--muted)",fontSize:12}}>Deals found but no revenue values detected. Field mapping may need adjusting.</div>}
              </div>);
            })()
            :attioDeals?.error?(
              <div style={{padding:"16px",background:"rgba(239,68,68,0.08)",borderRadius:8,border:"1px solid rgba(239,68,68,0.2)"}}>
                <div style={{fontSize:12,color:"#EF4444",fontWeight:600}}>Attio connection error</div>
                <div style={{fontSize:11,color:"var(--muted)",marginTop:4}}>{attioDeals.error}</div>
                <div style={{fontSize:11,color:"var(--muted)",marginTop:4}}>Check the api/attio.js serverless function</div>
              </div>
            ):(
              <div style={{padding:30,textAlign:"center",color:"var(--muted)",background:"var(--bg)",borderRadius:8}}>
                <div style={{fontSize:13}}>Click "Sync from Attio" to pull monthly revenue data</div>
              </div>
            )}
          </div>
          </>)}

          {/* Team Lunch Manager removed - now in Capacity tab */}

          {foundersTab==="data"&&(<FoundersData metrics={foundersMetrics} setMetrics={setFoundersMetrics}/>)}

          {foundersTab==="learnings"&&(()=>{
            const[feedbackLog,setFeedbackLog]=useState({});
            const[promptLearnings,setPromptLearnings]=useState({});
            const[newLearning,setNewLearning]=useState("");
            useEffect(()=>{
              let u1=()=>{},u2=()=>{};
              onFB(()=>{
                u1=fbListen("/preproduction/feedbackLog",d=>setFeedbackLog(d||{}));
                u2=fbListen("/preproduction/promptLearnings",d=>setPromptLearnings(d||{}));
              });
              return()=>{u1();u2();};
            },[]);
            const NB2={padding:"6px 10px",borderRadius:6,border:"1px solid var(--border)",background:"transparent",color:"var(--muted)",fontSize:12,cursor:"pointer",fontFamily:"inherit"};
            const inputSt2={padding:"8px 12px",borderRadius:6,border:"1px solid var(--border)",background:"var(--input-bg)",color:"var(--fg)",fontSize:13,fontFamily:"inherit",outline:"none",width:"100%",boxSizing:"border-box"};
            return(<div>
              <div style={{marginBottom:24}}>
                <h3 style={{fontSize:14,fontWeight:700,color:"var(--fg)",marginBottom:12}}>Active Prompt Learnings</h3>
                <div style={{fontSize:12,color:"var(--muted)",marginBottom:12}}>These rules are injected into every new script generation. They compound over time to improve output quality.</div>
                <div style={{display:"grid",gap:8,marginBottom:12}}>
                  {Object.entries(promptLearnings).filter(([,l])=>l&&l.active).map(([id,l])=>(
                    <div key={id} style={{padding:"10px 14px",background:"var(--card)",border:"1px solid var(--border)",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                      <span style={{fontSize:13,color:"var(--fg)"}}>{l.rule}</span>
                      <div style={{display:"flex",gap:6}}>
                        <button onClick={()=>fbSet(`/preproduction/promptLearnings/${id}/active`,false)} style={{...NB2,fontSize:10,padding:"3px 8px"}}>Disable</button>
                        <button onClick={()=>{if(window.confirm("Delete this learning?"))fbSet(`/preproduction/promptLearnings/${id}`,null);}} style={{background:"none",border:"none",color:"#5A6B85",cursor:"pointer",fontSize:12}}>x</button>
                      </div>
                    </div>
                  ))}
                  {Object.values(promptLearnings).filter(l=>l&&l.active).length===0&&(
                    <div style={{padding:20,textAlign:"center",color:"var(--muted)",fontSize:12}}>No active learnings yet.</div>
                  )}
                </div>
                <div style={{display:"flex",gap:8}}>
                  <input value={newLearning} onChange={e=>setNewLearning(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&newLearning.trim()){fbSet(`/preproduction/promptLearnings/pl_${Date.now()}`,{rule:newLearning.trim(),active:true,createdAt:new Date().toISOString()});setNewLearning("");}}} placeholder="Add a learning, e.g. 'For Refined brands, soften hook aggression'" style={{...inputSt2,flex:1}}/>
                  <button onClick={()=>{if(!newLearning.trim())return;fbSet(`/preproduction/promptLearnings/pl_${Date.now()}`,{rule:newLearning.trim(),active:true,createdAt:new Date().toISOString()});setNewLearning("");}} disabled={!newLearning.trim()} style={{padding:"8px 16px",borderRadius:6,border:"none",background:"var(--accent)",color:"#fff",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit",opacity:!newLearning.trim()?0.5:1}}>Add</button>
                </div>
                {Object.entries(promptLearnings).filter(([,l])=>l&&!l.active).length>0&&(
                  <details style={{marginTop:12}}>
                    <summary style={{fontSize:12,color:"var(--muted)",cursor:"pointer"}}>Disabled ({Object.entries(promptLearnings).filter(([,l])=>l&&!l.active).length})</summary>
                    <div style={{display:"grid",gap:6,marginTop:8}}>
                      {Object.entries(promptLearnings).filter(([,l])=>l&&!l.active).map(([id,l])=>(
                        <div key={id} style={{padding:"8px 12px",background:"var(--bg)",border:"1px solid var(--border)",borderRadius:6,display:"flex",alignItems:"center",justifyContent:"space-between",opacity:0.6}}>
                          <span style={{fontSize:12,color:"var(--muted)"}}>{l.rule}</span>
                          <button onClick={()=>fbSet(`/preproduction/promptLearnings/${id}/active`,true)} style={{...NB2,fontSize:10,padding:"3px 8px"}}>Re-enable</button>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
              <div>
                <h3 style={{fontSize:14,fontWeight:700,color:"var(--fg)",marginBottom:12}}>Feedback Log</h3>
                <div style={{fontSize:12,color:"var(--muted)",marginBottom:12}}>All client feedback and producer edits. Identify patterns and promote to learnings.</div>
                <div style={{display:"grid",gap:6}}>
                  {Object.entries(feedbackLog).sort(([,a],[,b])=>(b.timestamp||"").localeCompare(a.timestamp||"")).slice(0,50).map(([id,entry])=>{
                    const tc={clientFeedback:{bg:"rgba(245,158,11,0.1)",fg:"#F59E0B",label:"Client"},rewrite:{bg:"rgba(59,130,246,0.1)",fg:"#3B82F6",label:"AI Rewrite"},manualEdit:{bg:"rgba(139,92,246,0.1)",fg:"#8B5CF6",label:"Manual"}}[entry.type]||{bg:"rgba(139,92,246,0.1)",fg:"#8B5CF6",label:"Manual"};
                    return(
                      <div key={id} style={{padding:"10px 14px",background:"var(--card)",border:"1px solid var(--border)",borderRadius:8}}>
                        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                          <span style={{fontSize:10,fontWeight:700,padding:"2px 6px",borderRadius:3,background:tc.bg,color:tc.fg}}>{tc.label}</span>
                          <span style={{fontSize:11,color:"var(--fg)",fontWeight:600}}>{entry.companyName}</span>
                          <span style={{fontSize:10,color:"var(--muted)"}}>{entry.column}{entry.cellId?` / ${entry.cellId}`:""}</span>
                          <span style={{fontSize:10,color:"var(--muted)",marginLeft:"auto"}}>{entry.timestamp?new Date(entry.timestamp).toLocaleDateString("en-AU"):""}</span>
                        </div>
                        {entry.instruction&&<div style={{fontSize:12,color:"var(--fg)",marginBottom:4}}><strong>Instruction:</strong> {entry.instruction}</div>}
                        {entry.text&&<div style={{fontSize:12,color:"var(--fg)",marginBottom:4}}><strong>Feedback:</strong> {entry.text}</div>}
                        {entry.previousValue&&<div style={{fontSize:11,color:"var(--muted)"}}>Was: {entry.previousValue.substring(0,100)}{entry.previousValue.length>100?"...":""}</div>}
                        {entry.newValue&&<div style={{fontSize:11,color:"var(--accent)"}}>Now: {entry.newValue.substring(0,100)}{entry.newValue.length>100?"...":""}</div>}
                        <button onClick={()=>{const rule=window.prompt("Create a learning from this feedback:",entry.instruction||entry.text||"");if(rule)fbSet(`/preproduction/promptLearnings/pl_${Date.now()}`,{rule,active:true,createdAt:new Date().toISOString(),sourceLogId:id});}} style={{...NB2,fontSize:10,padding:"3px 8px",marginTop:6}}>Promote to Learning</button>
                      </div>
                    );
                  })}
                  {Object.keys(feedbackLog).length===0&&(
                    <div style={{padding:40,textAlign:"center",color:"var(--muted)",fontSize:12}}>No feedback logged yet.</div>
                  )}
                </div>
              </div>
            </div>);
          })()}
        </div>
      </>);
    })()}

    </div>
  </div>);
}
