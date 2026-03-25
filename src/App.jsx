import { useState, useMemo, useEffect, useRef } from "react";

// ─── Firebase ───
const FB_CFG = {
  apiKey: "AIzaSyDhv_5W36_2Q2eVBvopg98Bwgq-D66-b2s",
  authDomain: "viewix-capacity-tracker.firebaseapp.com",
  databaseURL: "https://viewix-capacity-tracker-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "viewix-capacity-tracker",
  storageBucket: "viewix-capacity-tracker.firebasestorage.app",
  messagingSenderId: "1039857514551",
  appId: "1:1039857514551:web:afe099ade6fdaf6cf1e7b2"
};
let db=null,fbReady=false;const fbCbs=[];
function initFB(){if(fbReady||document.getElementById("fb-s"))return;const s1=document.createElement("script");s1.id="fb-s";s1.src="https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js";s1.onload=()=>{const s2=document.createElement("script");s2.src="https://www.gstatic.com/firebasejs/10.12.2/firebase-database-compat.js";s2.onload=()=>{window.firebase.initializeApp(FB_CFG);db=window.firebase.database();fbReady=true;fbCbs.forEach(c=>c());fbCbs.length=0;};document.head.appendChild(s2);};document.head.appendChild(s1);}
function onFB(cb){if(fbReady)cb();else fbCbs.push(cb);}
function fbSet(p,v){if(db)db.ref(p).set(v);}
function fbListen(p,cb){if(!db)return()=>{};const r=db.ref(p);r.on("value",s=>cb(s.val()));return()=>r.off("value");}

// ─── Monday.com ───
const MONDAY_API="https://api.monday.com/v2";
const MONDAY_TOKEN="eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOjM5NzQ3MTI3OSwiYWFpIjoxMSwidWlkIjo2MjY3NDg4NSwiaWFkIjoiMjAyNC0wOC0xNVQwNjo0MjoxMC4wMDBaIiwicGVyIjoibWU6d3JpdGUiLCJhY3RpZCI6MjQxMzg2NTksInJnbiI6ImFwc2UyIn0.-YhtvI8VFze2Tv971jezS8BAaABF3nQG7vjBS0xXq_E";
const MONDAY_BOARD_ID="1884080816";
const MONDAY_IN_PROGRESS_GROUP="new_group__1";
const MONDAY_EDITORS=[
  {id:"66265733",name:"Angus Roche"},
  {id:"96885430",name:"Billy White"},
  {id:"68480795",name:"David Esdaile"},
  {id:"94902565",name:"Felipe Fuhr"},
  {id:"97138079",name:"Jude Palmer Rowlands"},
  {id:"100235454",name:"Luke Genovese-Kollar"},
  {id:"97345986",name:"Matt Healey"},
  {id:"85363605",name:"Mia Wolczak"},
  {id:"90227304",name:"Vish Peiris"},
  {id:"99188387",name:"Farah"},
];

async function mondayQuery(q){
  try{
    console.log("Monday API query:",q);
    const r=await fetch(MONDAY_API,{method:"POST",headers:{"Content-Type":"application/json","Authorization":MONDAY_TOKEN},body:JSON.stringify({query:q})});
    const data=await r.json();
    if(data.errors)console.error("Monday API errors:",data.errors);
    return data;
  }catch(e){console.error("Monday API error:",e);return null;}
}

async function fetchEditorTasks(editorName){
  // Get all items with subitems from the board
  const q=`query { boards(ids: ${MONDAY_BOARD_ID}) { items_page(limit: 200) { items { id name group { id title } subitems { id name column_values(ids: ["people","status8","stage","timeline","due_date","numeric_mkyg3qb1"]) { id text } } } } } }`;
  const res=await mondayQuery(q);
  console.log("Monday API response:",res);
  if(!res?.data?.boards?.[0]?.items_page?.items)return[];
  const items=res.data.boards[0].items_page.items;
  // Filter to In Progress group only
  const inProgress=items.filter(it=>it.group?.id===MONDAY_IN_PROGRESS_GROUP);
  console.log("In Progress items:",inProgress.length,"Total items:",items.length);
  console.log("Looking for editor:",editorName);
  const today=todayKey();
  const tasks=[];
  inProgress.forEach(parent=>{
    (parent.subitems||[]).forEach(sub=>{
      const peopleCol=sub.column_values?.find(v=>v.id==="people");
      const people=peopleCol?.text||"";
      if(!people.toLowerCase().includes(editorName.toLowerCase()))return;
      const getCol=(id)=>sub.column_values?.find(v=>v.id===id)?.text||"";
      const timeline=getCol("timeline");
      const status=getCol("status8");
      // Check if today falls within timeline range
      let showTask=false;
      if(timeline){
        const parts=timeline.split(" - ");
        if(parts.length===2){
          const start=parts[0].trim();
          const end=parts[1].trim();
          showTask=(today>=start&&today<=end);
        } else if(parts.length===1){
          // Single date
          showTask=(parts[0].trim()===today);
        }
      }
      // Also show tasks with no timeline that are IN PROGRESS, STUCK, or SCHEDULED
      if(!timeline&&(status==="IN PROGRESS"||status==="STUCK"||status==="SCHEDULED"))showTask=true;
      // Also show overdue tasks (end date passed but not DONE)
      if(timeline&&!showTask&&status!=="DONE"){
        const parts=timeline.split(" - ");
        const endDate=parts.length===2?parts[1].trim():parts[0]?.trim();
        if(endDate&&endDate<today)showTask=true;
      }
      if(!showTask)return;
      tasks.push({
        id:sub.id,
        name:sub.name,
        parentName:parent.name,
        status:status,
        stage:getCol("stage"),
        timeline:timeline,
        dueDate:getCol("due_date"),
        people:people,
        estimatedHours:getCol("numeric_mkyg3qb1"),
        overdue:timeline?(timeline.split(" - ").pop()?.trim()||"")<today:false,
      });
    });
  });
  console.log("Found tasks for",editorName,":",tasks.length,tasks);
  return tasks;
}

function todayKey(){const d=new Date();return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;}
function fmtSecs(s){const h=Math.floor(s/3600);const m=Math.floor((s%3600)/60);const sec=s%60;return`${h>0?h+"h ":""}${m>0?m+"m ":""}${sec}s`;}
function fmtSecsShort(s){const h=Math.floor(s/3600);const m=Math.floor((s%3600)/60);if(h>0)return`${h}h ${m}m`;if(m>0)return`${m}m`;return`${s}s`;}

// ─── Constants ───
const DK=["mon","tue","wed","thu","fri"],DL=["Mon","Tue","Wed","Thu","Fri"];
const QT=[{util:0.5,wait:"1x"},{util:0.7,wait:"2.3x"},{util:0.75,wait:"3x"},{util:0.8,wait:"4x"},{util:0.85,wait:"5.7x"},{util:0.9,wait:"9x"},{util:0.95,wait:"19x"},{util:0.99,wait:"99x"}];

function getMonday(d){const x=new Date(d);const day=x.getDay();x.setDate(x.getDate()-day+(day===0?-6:1));x.setHours(0,0,0,0);return x;}
function wKey(m){const d=new Date(m);return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;}
function fmtD(d){return new Date(d).toLocaleDateString("en-AU",{day:"numeric",month:"short"});}
function fmtRange(m){const a=new Date(m),b=new Date(a);b.setDate(b.getDate()+4);return`${fmtD(a)} - ${fmtD(b)}`;}
function fmtLabel(m){return new Date(m).toLocaleDateString("en-AU",{day:"numeric",month:"short",year:"numeric"});}
function dayDates(m){return DK.map((_,i)=>{const d=new Date(m);d.setDate(d.getDate()+i);return d;});}
function addW(d,n){const x=new Date(d);x.setDate(x.getDate()+n*7);return x;}
const ORIGIN=new Date(2026,2,23);

const DEF_EDS=[
  {id:"ed-1",name:"Angus",defaultDays:{mon:true,tue:true,wed:true,thu:false,fri:true}},
  {id:"ed-2",name:"David",defaultDays:{mon:true,tue:true,wed:true,thu:true,fri:true}},
  {id:"ed-3",name:"Billy",defaultDays:{mon:true,tue:false,wed:true,thu:true,fri:true}},
  {id:"ed-4",name:"Jude",defaultDays:{mon:true,tue:true,wed:false,thu:true,fri:true}},
  {id:"ed-5",name:"Mia",defaultDays:{mon:true,tue:true,wed:true,thu:false,fri:false}},
  {id:"ed-6",name:"Matt",defaultDays:{mon:true,tue:true,wed:true,thu:true,fri:false}},
  {id:"ed-7",name:"Luke",defaultDays:{mon:true,tue:true,wed:true,thu:true,fri:true}},
];
const DEF_IN={totalSuites:7,hoursPerSuitePerDay:8,avgEditHoursPerProject:4.5,newProjectsPerWeek:6,avgProjectDuration:12,targetUtilisation:0.75,currentActiveProjects:42};

// Quote template
const QUOTE_SECTIONS=[
  {id:"preprod",name:"Pre-Production",items:[
    {id:"pp1",role:"Pre Production",rate:42},{id:"pp2",role:"Crewing",rate:34},{id:"pp3",role:"Site Recce",rate:34},{id:"pp4",role:"Scriptwriting",rate:34}
  ]},
  {id:"prod",name:"Production",items:[
    {id:"pr1",role:"Producer",rate:66},{id:"pr2",role:"Cinematographer",rate:66},{id:"pr3",role:"Shooter/Editor",rate:42.31},
    {id:"pr4",role:"Second Shooter",rate:100},{id:"pr5",role:"PA/Runner",rate:85},{id:"pr6",role:"AC",rate:100}
  ]},
  {id:"postprod",name:"Post-Production",items:[
    {id:"po1",role:"Editor (Internal)",rate:42},{id:"po2",role:"VFX/Graphics",rate:187.5},{id:"po3",role:"External Editor",rate:75},{id:"po4",role:"Producer",rate:125}
  ]},
  {id:"anim",name:"Animation",items:[
    {id:"an1",role:"Scripting",rate:100},{id:"an2",role:"Storyboarding",rate:150},{id:"an3",role:"Animator",rate:150}
  ]},
  {id:"photo",name:"Photography",items:[
    {id:"ph1",role:"Photographer",rate:0}
  ]},
  {id:"addl",name:"Additional Costs",items:[
    {id:"ad1",role:"Music",rate:80},{id:"ad2",role:"Travel (p/km)",rate:0.72},{id:"ad3",role:"VO Artist",rate:350},
    {id:"ad4",role:"Misc",rate:1},{id:"ad5",role:"Overheads",rate:38},{id:"ad6",role:"Data Storage (1TB)",rate:63.5}
  ]}
];

const OUTPUT_PRESETS=[
  "1 x 15 sec Social Media Cutdown",
  "1 x 25 sec Social Media Cutdown (16:9, 9:16, 1:1)",
  "1 x 30 sec Social Media Cutdown",
  "1 x 60 sec Hype Video",
];

const FILMING_DEFAULTS=[
  "3 Hours Filming","2 Videographers","2 x Cameras","Full Lighting Kit","Microphones"
];
const EDITING_DEFAULTS=[
  "1 Day Editing","Color Grade","Music Licencing","Graphic Supers (lower thirds text)","Logo Animation","2 x Rounds of Revisions"
];

const DEFAULT_RATE_CARDS=[
  {id:"rc-zoo",name:"Sydney Zoo",rates:{"Scheduling":100,"Crewing":100,"Site Recce":100,"Scriptwriting":100,"Cinematographer":125,"Producer":125,"PA/Runner":85,"AC":100,"Second Shooter":100,"Shooter/Editor":100,"Editor (Internal)":75,"VFX/Graphics":187.5,"External Editor":75,"Scripting":100,"Storyboarding":150,"Animator":150,"Music":80,"Travel (p/km)":0.72,"VO Artist":350,"Overheads":38,"Data Storage (1TB)":63.5}},
  {id:"rc-wsa",name:"Western Sydney Airport",rates:{"Scheduling":140.8,"Crewing":140.8,"Site Recce":140.8,"Scriptwriting":140.8,"Cinematographer":140.8,"Producer":140.8,"PA/Runner":140.8,"AC":140.8,"Second Shooter":140.8,"Shooter/Editor":140.8,"Editor (Internal)":140.8,"VFX/Graphics":140.8,"External Editor":140.8,"Scripting":140.8,"Storyboarding":140.8,"Animator":140.8,"Photographer":168.96,"Music":80,"Travel (p/km)":0.72,"VO Artist":415,"Overheads":38,"Data Storage (1TB)":63.5}},
  {id:"rc-tg",name:"Transgrid",rates:{"Scheduling":34,"Crewing":34,"Site Recce":34,"Scriptwriting":34,"Cinematographer":100,"Producer":100,"Shooter/Editor":42.31,"Editor (Internal)":42,"VFX/Graphics":187.5,"External Editor":75,"Scripting":100,"Storyboarding":150,"Animator":150,"Music":80,"Travel (p/km)":0.72,"VO Artist":350,"Overheads":38,"Data Storage (1TB)":63.5}},
  {id:"rc-bmd",name:"BMD",rates:{"Scheduling":34,"Crewing":34,"Site Recce":34,"Scriptwriting":34,"Cinematographer":100,"Producer":100,"Shooter/Editor":42.31,"Editor (Internal)":42,"VFX/Graphics":187.5,"External Editor":75,"Scripting":100,"Storyboarding":150,"Animator":150,"Music":80,"Travel (p/km)":0.72,"VO Artist":350,"Overheads":38,"Data Storage (1TB)":63.5}},
  {id:"rc-thnsw",name:"THNSW",rates:{"Scheduling":150,"Crewing":150,"Site Recce":150,"Scriptwriting":150,"Cinematographer":150,"Producer":150,"PA/Runner":150,"AC":150,"Second Shooter":150,"Shooter/Editor":150,"Editor (Internal)":150,"VFX/Graphics":150,"External Editor":150,"Scripting":150,"Storyboarding":150,"Animator":150,"Music":80,"Travel (p/km)":0.72,"VO Artist":350,"Overheads":38,"Data Storage (1TB)":63.5}},
  {id:"rc-snowy",name:"Snowy Hydro",rates:{"Scheduling":150,"Crewing":150,"Site Recce":150,"Scriptwriting":150,"Cinematographer":150,"Producer":150,"PA/Runner":150,"AC":150,"Shooter/Editor":150,"Editor (Internal)":150,"VFX/Graphics":150,"External Editor":150,"Scripting":150,"Storyboarding":150,"Animator":150,"Music":80,"Travel (p/km)":0.72,"VO Artist":350,"Overheads":38,"Data Storage (1TB)":63.5}},
  {id:"rc-pnsw",name:"Property NSW",rates:{"Scheduling":133,"Crewing":133,"Site Recce":133,"Scriptwriting":133,"Cinematographer":133,"Producer":133,"PA/Runner":133,"AC":133,"Second Shooter":133,"Shooter/Editor":133,"Editor (Internal)":133,"VFX/Graphics":133,"External Editor":133,"Scripting":133,"Storyboarding":133,"Animator":133,"Music":80,"Travel (p/km)":0.72,"VO Artist":350,"Overheads":38,"Data Storage (1TB)":63.5}},
  {id:"rc-d2c",name:"D2C",rates:{"Scheduling":100,"Crewing":100,"Site Recce":100,"Scriptwriting":100,"Cinematographer":80,"Producer":80,"PA/Runner":80,"AC":80,"Second Shooter":80,"Shooter/Editor":80,"Editor (Internal)":50,"VFX/Graphics":187.5,"External Editor":75,"Scripting":100,"Storyboarding":150,"Animator":150,"Music":80,"Travel (p/km)":0.72,"VO Artist":350,"Overheads":38,"Data Storage (1TB)":63.5}},
];


function doCalc(inp,occ){
  const mxSD=inp.totalSuites*5,rCap=occ*inp.hoursPerSuitePerDay,mCap=mxSD*inp.hoursPerSuitePerDay;
  const wl=inp.currentActiveProjects*inp.avgEditHoursPerProject;
  const rU=rCap>0?wl/rCap:0,fU=mCap>0?wl/mCap:0;
  const sp=Math.max(0,rCap-wl),emSD=mxSD-occ,edN=Math.ceil(emSD/5);
  const fc=[];let p=inp.currentActiveProjects;
  for(let w=0;w<=12;w++){const fw=p*inp.avgEditHoursPerProject,fr=rCap>0?fw/rCap:0,ff=mCap>0?fw/mCap:0;const sn=Math.ceil(fw/(5*inp.hoursPerSuitePerDay*inp.targetUtilisation));fc.push({week:w,projects:Math.round(p),workload:Math.round(fw*10)/10,realUtil:fr,filledUtil:ff,suitesNeeded:sn});p=p-p/inp.avgProjectDuration+inp.newProjectsPerWeek;}
  return{occupiedSuiteDays:occ,maxSuiteDays:mxSD,realCapacity:rCap,maxCapacity:mCap,workload:wl,realUtil:rU,filledUtil:fU,spareHours:sp,emptySuiteDays:emSD,editorsNeeded:edN,forecast:fc};
}

const pct=v=>`${Math.round(v*100)}%`;
const fmtCur=v=>v.toLocaleString("en-AU",{style:"currency",currency:"AUD",minimumFractionDigits:0,maximumFractionDigits:0});
function sCol(u){if(u>=0.95)return{bg:"#FEE2E2",text:"#991B1B",label:"MAXED",border:"#FECACA"};if(u>=0.85)return{bg:"#FEF3C7",text:"#92400E",label:"DANGER",border:"#FDE68A"};if(u>=0.7)return{bg:"#FEF9C3",text:"#854D0E",label:"TIGHT",border:"#FEF08A"};return{bg:"#D1FAE5",text:"#065F46",label:"OK",border:"#A7F3D0"};}
function gSC(u){if(u>=0.95)return{bg:"#991B1B",text:"#FEE2E2",label:"MAXED OUT",glow:"0 0 40px rgba(220,38,38,0.3)"};if(u>=0.85)return{bg:"#92400E",text:"#FEF3C7",label:"DANGER",glow:"0 0 40px rgba(245,158,11,0.3)"};if(u>=0.7)return{bg:"#854D0E",text:"#FEF9C3",label:"TIGHT",glow:"0 0 40px rgba(234,179,8,0.3)"};return{bg:"#065F46",text:"#D1FAE5",label:"HEALTHY",glow:"0 0 40px rgba(16,185,129,0.3)"};}

const TH={padding:"8px 10px",fontSize:10,fontWeight:700,color:"var(--muted)",letterSpacing:"0.06em",textTransform:"uppercase",borderBottom:"2px solid var(--border)",background:"var(--card)"};
const TD={padding:"6px 10px",borderBottom:"1px solid var(--border-light)"};
const NB={height:36,borderRadius:8,border:"1px solid var(--border)",background:"var(--bg)",color:"var(--fg)",fontSize:14,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",padding:"0 12px"};
const BTN={padding:"6px 14px",borderRadius:6,border:"none",fontSize:11,fontWeight:700,cursor:"pointer"};


function Logo({h=30}){
  const src="data:image/png;base64,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";
  return(<img src={src} alt="Viewix" height={h} style={{display:"block"}}/>);
}

// Logo component will be injected during assembly

function Badge({util,large}){const s=large?gSC(util):sCol(util);return(<span style={{display:"inline-flex",alignItems:"center",gap:6,padding:large?"8px 20px":"3px 10px",borderRadius:6,fontSize:large?15:11,fontWeight:700,letterSpacing:"0.05em",background:s.bg,color:s.text,border:large?"none":`1px solid ${s.border}`,boxShadow:large?s.glow:"none",fontFamily:"'JetBrains Mono',monospace"}}><span style={{width:large?10:7,height:large?10:7,borderRadius:"50%",background:s.text,opacity:0.7}}/>{s.label}</span>);}
function Metric({label,value,sub,accent}){return(<div style={{background:"var(--card)",border:"1px solid var(--border)",borderRadius:10,padding:"16px 20px"}}><div style={{fontSize:11,color:"var(--muted)",fontWeight:600,letterSpacing:"0.04em",textTransform:"uppercase",marginBottom:6}}>{label}</div><div style={{fontSize:28,fontWeight:800,color:accent||"var(--fg)",fontFamily:"'JetBrains Mono',monospace",lineHeight:1}}>{value}</div>{sub&&<div style={{fontSize:12,color:"var(--muted)",marginTop:4}}>{sub}</div>}</div>);}
function NumIn({label,value,onChange,step,min,max,suffix}){return(<div style={{display:"flex",flexDirection:"column",gap:4}}><label style={{fontSize:11,fontWeight:600,color:"var(--muted)",letterSpacing:"0.03em",textTransform:"uppercase"}}>{label}</label><div style={{display:"flex",alignItems:"center",gap:6}}><input type="number" value={value} onChange={e=>onChange(parseFloat(e.target.value)||0)} step={step} min={min} max={max} style={{width:"100%",padding:"8px 12px",borderRadius:8,border:"1px solid var(--border)",background:"var(--input-bg)",color:"var(--fg)",fontSize:15,fontWeight:600,fontFamily:"'JetBrains Mono',monospace",outline:"none"}}/>{suffix&&<span style={{fontSize:12,color:"var(--muted)",fontWeight:600,whiteSpace:"nowrap"}}>{suffix}</span>}</div></div>);}
function UBar({value,height=16}){const w=Math.min((Math.min(value,1.5)/1.2)*100,100);return(<div style={{width:"100%",height,background:"var(--bar-bg)",borderRadius:height/2,overflow:"hidden"}}><div style={{width:`${w}%`,height:"100%",borderRadius:height/2,transition:"width 0.4s",background:value>=0.95?"#EF4444":value>=0.85?"#F59E0B":value>=0.7?"#EAB308":"#10B981"}}/></div>);}
function FChart({forecast}){const mx=Math.max(...forecast.map(f=>f.workload),1);const H=200;return(<div style={{height:H+50,width:"100%"}}><div style={{display:"flex",alignItems:"flex-end",height:H,gap:2,padding:"0 4px"}}>{forecast.map((f,i)=>{const h=(f.workload/(mx*1.15))*H;const c=f.realUtil>=0.95?"#EF4444":f.realUtil>=0.85?"#F59E0B":f.realUtil>=0.7?"#EAB308":"#10B981";return(<div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:2}}><span style={{fontSize:9,fontWeight:700,color:"var(--muted)",fontFamily:"'JetBrains Mono',monospace"}}>{Math.round(f.workload)}h</span><div style={{width:"70%",height:h,background:c,borderRadius:"4px 4px 0 0",opacity:0.7+(i/forecast.length)*0.3}} title={`W${f.week}: ${f.projects}p, ${f.workload}h, ${pct(f.realUtil)}`}/></div>);})}</div><div style={{display:"flex",padding:"6px 4px 0",gap:2}}>{forecast.map((f,i)=><div key={i} style={{flex:1,textAlign:"center",fontSize:10,fontWeight:600,color:"var(--muted)",fontFamily:"'JetBrains Mono',monospace"}}>W{f.week}</div>)}</div></div>);}

// ─── Capacity Grid ───
// Day values: true/"in" = editing (uses suite), "shoot" = working but no suite, false/undefined = off
function dayVal(v){if(v===true||v==="in")return"in";if(v==="shoot")return"shoot";return"off";}
function nextState(v){const cur=dayVal(v);if(cur==="in")return"shoot";if(cur==="shoot")return false;return"in";}

function Grid({wk,weekData,onUpdate,masterEds,inputs,onUpdateSuites}){
  const md=new Date(wk+"T00:00:00");const dd=dayDates(md);const data=weekData[wk]||{};
  // Migrate legacy boolean days to new format
  const eds=(data.editors||masterEds.map(e=>({...e,days:{...e.defaultDays},notes:{}}))).map(e=>({...e,notes:e.notes||{}}));
  const[newName,setNewName]=useState("");const[adding,setAdding]=useState(false);
  const[editingId,setEditingId]=useState(null);const[editName,setEditName]=useState("");
  const[noteEdit,setNoteEdit]=useState(null); // {editorId, day}
  const[noteText,setNoteText]=useState("");
  const addRef=useRef(null);const editRef=useRef(null);const noteRef=useRef(null);
  const sv=patch=>onUpdate(wk,{editors:eds,...data,...patch});
  const tog=(eid,day)=>sv({editors:eds.map(e=>e.id===eid?{...e,days:{...e.days,[day]:nextState(e.days[day])}}:e)});
  const doAdd=()=>{if(!newName.trim())return;sv({editors:[...eds,{id:`ed-${Date.now()}`,name:newName.trim(),days:{mon:"in",tue:"in",wed:"in",thu:"in",fri:"in"},notes:{}}]});setNewName("");setAdding(false);};
  const rmEd=id=>sv({editors:eds.filter(e=>e.id!==id)});
  const startEdit=ed=>{setEditingId(ed.id);setEditName(ed.name);};
  const doRename=()=>{if(!editName.trim()){setEditingId(null);return;}sv({editors:eds.map(e=>e.id===editingId?{...e,name:editName.trim()}:e)});setEditingId(null);};
  const openNote=(edId,day)=>{const ed=eds.find(e=>e.id===edId);setNoteEdit({editorId:edId,day});setNoteText(ed?.notes?.[day]||"");};
  const saveNote=()=>{if(!noteEdit)return;sv({editors:eds.map(e=>e.id===noteEdit.editorId?{...e,notes:{...e.notes,[noteEdit.day]:noteText.trim()||undefined}}:e)});setNoteEdit(null);setNoteText("");};

  // Only "in" counts as occupying a suite. "shoot" = working but no suite.
  const occPerDay=DK.map(d=>eds.filter(e=>dayVal(e.days[d])==="in").length);
  const avPerDay=occPerDay.map(o=>inputs.totalSuites-o);
  const totalOcc=occPerDay.reduce((a,b)=>a+b,0);const totalAv=avPerDay.reduce((a,b)=>a+b,0);const maxSD=inputs.totalSuites*5;
  const occCol=o=>{if(o>inputs.totalSuites)return"#F472B6";const r=o/inputs.totalSuites;if(r>=1)return"#10B981";if(r>=0.7)return"#EAB308";if(r>=0.5)return"#F59E0B";return"#EF4444";};
  useEffect(()=>{if(adding&&addRef.current)addRef.current.focus();},[adding]);
  useEffect(()=>{if(editingId&&editRef.current)editRef.current.focus();},[editingId]);
  useEffect(()=>{if(noteEdit&&noteRef.current)noteRef.current.focus();},[noteEdit]);

  const cellStyle=(ed,day)=>{
    const v=dayVal(ed.days[day]);const hasNote=ed.notes?.[day];
    if(v==="in")return{background:hasNote?"rgba(0,130,250,0.22)":"var(--accent-soft)",color:"var(--accent)"};
    if(v==="shoot")return{background:hasNote?"rgba(248,119,0,0.22)":"rgba(248,119,0,0.12)",color:"#F87700"};
    return{background:"transparent",color:"#3A4558"};
  };
  const cellLabel=v=>{if(v==="in")return"IN";if(v==="shoot")return"SHOOT";return"-";};

  return(<div><div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"separate",borderSpacing:0,fontSize:13}}>
    <thead><tr><th style={{...TH,width:150,textAlign:"left"}}>Editor</th>{DK.map((_,i)=>(<th key={i} style={{...TH,textAlign:"center",minWidth:90}}><div>{DL[i]}</div><div style={{fontSize:11,fontWeight:600,color:"var(--accent)",marginTop:2}}>{fmtD(dd[i])}</div></th>))}<th style={{...TH,width:55,textAlign:"center"}}>Days</th><th style={{...TH,width:40}}></th></tr></thead>
    <tbody>{eds.map(ed=>{const dn=DK.filter(d=>dayVal(ed.days[d])!=="off").length;const isE=editingId===ed.id;return(<tr key={ed.id}>
      <td style={{...TD,fontWeight:700,color:"var(--fg)",cursor:"pointer"}} onClick={()=>{if(!isE)startEdit(ed);}}>{isE?(<input ref={editRef} type="text" value={editName} onChange={e=>setEditName(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")doRename();if(e.key==="Escape")setEditingId(null);}} onBlur={doRename} style={{width:"100%",padding:"3px 6px",borderRadius:4,border:"1px solid var(--accent)",background:"var(--input-bg)",color:"var(--fg)",fontSize:13,fontWeight:700,outline:"none"}}/>):(<span style={{borderBottom:"1px dashed #3A4558"}} title="Click to rename">{ed.name}</span>)}</td>
      {DK.map(day=>{const v=dayVal(ed.days[day]);const cs=cellStyle(ed,day);const hasNote=ed.notes?.[day];return(
        <td key={day} onClick={()=>tog(ed.id,day)} onContextMenu={e=>{e.preventDefault();openNote(ed.id,day);}}
          style={{...TD,textAlign:"center",cursor:"pointer",userSelect:"none",transition:"all 0.15s",position:"relative",...cs,fontWeight:700}}
          title={hasNote?`Note: ${hasNote}`:"Right-click to add note"}>
          <div>{cellLabel(v)}</div>
          {hasNote&&<div style={{fontSize:8,color:v==="shoot"?"#F87700":"var(--accent)",marginTop:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:80,margin:"0 auto"}}>📝 {hasNote}</div>}
        </td>);})}
      <td style={{...TD,textAlign:"center",fontWeight:700,fontFamily:"'JetBrains Mono',monospace"}}>{dn}</td>
      <td style={{...TD,textAlign:"center"}}><button onClick={()=>rmEd(ed.id)} style={{background:"none",border:"none",cursor:"pointer",color:"#5A6B85",fontSize:16,padding:"2px 6px",borderRadius:4}}>x</button></td>
    </tr>);})}
    {adding&&(<tr><td style={TD}><input ref={addRef} type="text" value={newName} onChange={e=>setNewName(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")doAdd();if(e.key==="Escape"){setAdding(false);setNewName("");}}} placeholder="Editor name..." style={{width:"100%",padding:"5px 8px",borderRadius:6,border:"1px solid var(--accent)",background:"var(--input-bg)",color:"var(--fg)",fontSize:13,fontWeight:600,outline:"none"}}/></td><td style={TD} colSpan={5}></td><td style={{...TD,textAlign:"center"}}><button onClick={doAdd} style={{...BTN,background:"var(--accent)",color:"white"}}>Add</button></td><td style={{...TD,textAlign:"center"}}><button onClick={()=>{setAdding(false);setNewName("");}} style={{background:"none",border:"none",cursor:"pointer",color:"#5A6B85",fontSize:16}}>x</button></td></tr>)}</tbody>
    <tfoot><tr><td style={{...TD,fontWeight:700,color:"var(--fg)",borderTop:"2px solid var(--border)"}}>Suites Occupied</td>{occPerDay.map((o,i)=>(<td key={i} style={{...TD,textAlign:"center",fontWeight:800,fontFamily:"'JetBrains Mono',monospace",fontSize:16,borderTop:"2px solid var(--border)",color:occCol(o)}}>{o}</td>))}<td style={{...TD,textAlign:"center",fontWeight:800,fontFamily:"'JetBrains Mono',monospace",fontSize:14,borderTop:"2px solid var(--border)",color:"var(--fg)"}}>{totalOcc}</td><td style={{...TD,borderTop:"2px solid var(--border)"}}></td></tr>
    <tr><td style={{...TD,fontWeight:700,color:"var(--fg)"}}>Suites Available</td>{avPerDay.map((a,i)=>(<td key={i} style={{...TD,textAlign:"center",fontWeight:800,fontFamily:"'JetBrains Mono',monospace",fontSize:16,color:a<0?"#F472B6":a===0?"#10B981":a<=1?"#EAB308":a<=2?"#F59E0B":"#EF4444"}}>{a}</td>))}<td style={{...TD,textAlign:"center",fontWeight:800,fontFamily:"'JetBrains Mono',monospace",fontSize:14,color:"var(--fg)"}}>{totalAv}</td><td style={TD}></td></tr></tfoot>
  </table></div>
  {/* Note editor popup */}
  {noteEdit&&(<div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200}} onClick={()=>{saveNote();}}>
    <div onClick={e=>e.stopPropagation()} style={{background:"var(--card)",border:"1px solid var(--border)",borderRadius:12,padding:20,width:340,boxShadow:"0 12px 40px rgba(0,0,0,0.5)"}}>
      <div style={{fontSize:13,fontWeight:700,color:"var(--fg)",marginBottom:4}}>Add Note</div>
      <div style={{fontSize:11,color:"var(--muted)",marginBottom:12}}>{eds.find(e=>e.id===noteEdit.editorId)?.name} - {DL[DK.indexOf(noteEdit.day)]}</div>
      <input ref={noteRef} type="text" value={noteText} onChange={e=>setNoteText(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")saveNote();if(e.key==="Escape"){setNoteEdit(null);}}} placeholder="e.g. Starts late 10am, Leaves 3pm..." style={{width:"100%",padding:"10px 12px",borderRadius:8,border:"1px solid var(--border)",background:"var(--input-bg)",color:"var(--fg)",fontSize:14,outline:"none",marginBottom:12}}/>
      <div style={{display:"flex",gap:8}}>
        <button onClick={saveNote} style={{...BTN,background:"var(--accent)",color:"white",flex:1}}>Save</button>
        <button onClick={()=>{if(!noteEdit)return;sv({editors:eds.map(e=>e.id===noteEdit.editorId?{...e,notes:{...e.notes,[noteEdit.day]:undefined}}:e)});setNoteEdit(null);setNoteText("");}} style={{...BTN,background:"#374151",color:"#EF4444"}}>Clear Note</button>
        <button onClick={()=>setNoteEdit(null)} style={{...BTN,background:"#374151",color:"#9CA3AF"}}>Cancel</button>
      </div>
    </div>
  </div>)}
  <div style={{display:"flex",gap:8,marginTop:12,alignItems:"center",flexWrap:"wrap"}}>
    {!adding&&<button onClick={()=>setAdding(true)} style={{padding:"8px 16px",borderRadius:8,border:"1px dashed var(--border)",background:"transparent",color:"var(--muted)",fontSize:12,fontWeight:600,cursor:"pointer"}}>+ Add Editor</button>}
    <div style={{marginLeft:"auto",display:"flex",gap:12,fontSize:11,color:"var(--muted)"}}>
      <span><span style={{display:"inline-block",width:10,height:10,borderRadius:2,background:"var(--accent-soft)",marginRight:4,verticalAlign:"middle"}}/>IN = editing (uses suite)</span>
      <span><span style={{display:"inline-block",width:10,height:10,borderRadius:2,background:"rgba(248,119,0,0.12)",marginRight:4,verticalAlign:"middle"}}/>SHOOT = on shoot (no suite)</span>
      <span>Right-click cell = add note</span>
    </div>
  </div>
  <div style={{marginTop:16,padding:"14px 16px",background:"var(--bg)",borderRadius:8,border:"1px solid var(--border)"}}><div style={{display:"flex",alignItems:"center",gap:20,flexWrap:"wrap"}}><div><div style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:4}}>Edit Suites</div><div style={{display:"flex",alignItems:"center",gap:8}}><button onClick={()=>{if(inputs.totalSuites>1)onUpdateSuites(inputs.totalSuites-1);}} style={{width:28,height:28,borderRadius:6,border:"1px solid var(--border)",background:"var(--card)",color:"var(--fg)",fontSize:16,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>-</button><span style={{fontSize:24,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:"var(--fg)",minWidth:30,textAlign:"center"}}>{inputs.totalSuites}</span><button onClick={()=>onUpdateSuites(inputs.totalSuites+1)} style={{width:28,height:28,borderRadius:6,border:"1px solid var(--border)",background:"var(--card)",color:"var(--fg)",fontSize:16,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>+</button></div></div><div style={{flex:1}}><div style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:4}}>Occupancy this week</div><div style={{display:"flex",alignItems:"center",gap:10}}><span style={{fontSize:18,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:"var(--fg)"}}>{totalOcc}/{maxSD}</span><span style={{fontSize:12,color:"var(--muted)"}}>suite-days</span><div style={{flex:1}}><UBar value={totalOcc/maxSD} height={10}/></div></div></div></div></div></div>);
}


// ─── Quote Calculator ───
function newQuote(clientName){
  return {
    id:`q-${Date.now()}`,clientName:clientName||"New Quote",status:"draft",createdAt:new Date().toISOString(),
    items:QUOTE_SECTIONS.flatMap(s=>s.items.map(it=>({...it,section:s.id,sectionName:s.name,hours:0,rateOverride:null}))),
    customItems:[],margin:0.4,sellPrice:null,sellPriceMode:false,
    filmingBullets:[...FILMING_DEFAULTS],editingBullets:[...EDITING_DEFAULTS],
    outputs:[...OUTPUT_PRESETS],locked:false,
  };
}

function QuoteCalc({quote,onUpdate,onBack,rateCards}){
  const q=quote;const locked=q.locked;
  const setQ=patch=>onUpdate({...q,...patch});

  const updateItem=(id,patch)=>{
    setQ({items:q.items.map(it=>it.id===id?{...it,...patch}:it)});
  };
  const updateCustom=(id,patch)=>{
    setQ({customItems:(q.customItems||[]).map(it=>it.id===id?{...it,...patch}:it)});
  };
  const addCustomItem=()=>{
    setQ({customItems:[...(q.customItems||[]),{id:`ci-${Date.now()}`,role:"Custom Item",rate:0,hours:0,margin:0,section:"custom",sectionName:"Custom"}]});
  };
  const rmCustom=id=>setQ({customItems:(q.customItems||[]).filter(it=>it.id!==id)});

  // Apply rate card
  const applyRateCard=(rc)=>{
    const updated=q.items.map(it=>{
      const match=rc.rates[it.role];
      if(match!=null)return{...it,rateOverride:match};
      return it;
    });
    setQ({items:updated,clientName:rc.name});
  };

  // Calculate totals
  const itemCosts=q.items.map(it=>({...it,cost:(it.rateOverride??it.rate)*(it.hours||0)}));
  const customCosts=(q.customItems||[]).map(it=>{
    const baseCost=it.rate*(it.hours||0);
    const marginAmt=baseCost*(it.margin||0);
    return{...it,baseCost,sellCost:baseCost+marginAmt};
  });
  const totalCost=itemCosts.reduce((s,it)=>s+it.cost,0)+customCosts.reduce((s,it)=>s+it.baseCost,0);
  const totalCustomMarkup=customCosts.reduce((s,it)=>s+it.sellCost-it.baseCost,0);

  // Margin calc: two modes
  let sellExGST,margin;
  if(q.sellPriceMode&&q.sellPrice!=null){
    sellExGST=q.sellPrice;
    margin=totalCost>0?(sellExGST-totalCost)/sellExGST:0;
  } else {
    margin=q.margin||0;
    sellExGST=totalCost>0?totalCost/(1-margin):0;
  }
  sellExGST+=totalCustomMarkup;
  const sellIncGST=sellExGST*1.1;
  const profit=sellExGST-totalCost;
  const profitAfterTax=profit*0.8;

  // Group items by section
  const sections=QUOTE_SECTIONS.map(s=>({
    ...s,
    items:itemCosts.filter(it=>it.section===s.id),
    subtotal:itemCosts.filter(it=>it.section===s.id).reduce((sum,it)=>sum+it.cost,0)
  }));

  // Email generation
  const genEmail=()=>{
    let txt="";
    // Pre-Production section
    const preprodItems=itemCosts.filter(it=>it.section==="preprod"&&it.cost>0);
    if(preprodItems.length>0){
      txt+="Pre-Production:\n";
      preprodItems.forEach(it=>{txt+=`- ${it.role}\n`;});
    }
    // Filming section
    const prodItems=itemCosts.filter(it=>it.section==="prod"&&it.cost>0);
    if(prodItems.length>0){
      if(txt)txt+="\n";
      txt+="Filming:\n";
      const shootHours=Math.max(...prodItems.map(it=>it.hours||0),0);
      if(shootHours>0)txt+=`- ${shootHours} Hours Filming\n`;
      prodItems.forEach(it=>{txt+=`- ${it.role}\n`;});
      const shooters=prodItems.filter(it=>{const r=it.role.toLowerCase();return r.includes("cinematograph")||r.includes("shooter")||r.includes("videograph");});
      if(shooters.length>0)txt+=`- ${shooters.length} x Camera${shooters.length>1?"s":""}\n`;
      if(prodItems.some(it=>it.role.toLowerCase().includes("gaffer")||it.role.toLowerCase().includes("light")))txt+=`- Full Lighting Kit\n`;
      txt+="- Microphones\n";
    }
    // Editing section: pull from Post-Production + Animation items
    const postItems=itemCosts.filter(it=>(it.section==="postprod"||it.section==="anim")&&it.cost>0);
    const hasEditing=postItems.length>0;
    if(hasEditing){
      txt+="\nEditing:\n";
      const totalEditHours=postItems.filter(it=>it.role.toLowerCase().includes("editor")).reduce((s,it)=>s+(it.hours||0),0);
      if(totalEditHours>0){
        const editDays=totalEditHours>=8?`${Math.round(totalEditHours/8)} Day${Math.round(totalEditHours/8)>1?"s":""} Editing`:`${totalEditHours} Hours Editing`;
        txt+=`- ${editDays}\n`;
      }
      txt+="- Color Grade\n";
      // Check for music in additional costs
      const hasMusic=itemCosts.some(it=>it.role.toLowerCase().includes("music")&&it.cost>0);
      if(hasMusic)txt+="- Music Licencing\n";
      const hasVFX=postItems.some(it=>it.role.toLowerCase().includes("vfx")||it.role.toLowerCase().includes("graphic"));
      if(hasVFX)txt+="- Graphic Supers (lower thirds text)\n- Logo Animation\n";
      const hasAnim=postItems.some(it=>it.role.toLowerCase().includes("animat")||it.role.toLowerCase().includes("storyboard"));
      if(hasAnim)txt+="- Animation\n";
      txt+="- 2 x Rounds of Revisions\n";
    }
    // Outputs
    if(q.outputs&&q.outputs.length>0){
      txt+="\nOutputs\n";
      q.outputs.forEach(b=>{txt+=`- ${b}\n`;});
    }
    // Custom items
    const customs=(q.customItems||[]).filter(it=>it.rate*(it.hours||0)>0);
    if(customs.length>0){
      txt+="\nAdditional:\n";
      customs.forEach(it=>{txt+=`- ${it.role}\n`;});
    }
    txt+=`\nThe total investment comes to ${fmtCur(sellExGST)} ex GST.`;
    return txt;
  };

  const[emailText,setEmailText]=useState(null);
  const[copied,setCopied]=useState(false);

  const inputStyle={padding:"6px 8px",borderRadius:6,border:"1px solid var(--border)",background:locked?"transparent":"var(--input-bg)",color:"var(--fg)",fontSize:13,fontFamily:"'JetBrains Mono',monospace",outline:"none",width:"100%",textAlign:"right"};

  return(<div>
    {/* Header */}
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16,flexWrap:"wrap",gap:12}}>
      <div style={{display:"flex",alignItems:"center",gap:12}}>
        <button onClick={onBack} style={{...NB,fontSize:12}}>&larr; Back</button>
        <div>
          <input value={q.clientName} onChange={e=>!locked&&setQ({clientName:e.target.value})} disabled={locked}
            style={{fontSize:20,fontWeight:800,color:"var(--fg)",background:"transparent",border:"none",outline:"none",borderBottom:locked?"none":"1px dashed #3A4558",padding:"2px 0"}}/>
          <div style={{fontSize:11,color:"var(--muted)",marginTop:2}}>
            {q.status==="draft"?"Draft":"Locked"} · Created {new Date(q.createdAt).toLocaleDateString("en-AU")}
          </div>
        </div>
      </div>
      <div style={{display:"flex",gap:8}}>
        {!locked&&<button onClick={()=>setQ({locked:true})} style={{...BTN,background:"#F59E0B",color:"#1A1510"}}>Lock Quote</button>}
        {locked&&<button onClick={()=>setQ({locked:false})} style={{...BTN,background:"#374151",color:"#9CA3AF"}}>Unlock</button>}
      </div>
    </div>

    {/* Rate Card Selector */}
    {!locked&&(<div style={{marginBottom:16,padding:"12px 16px",background:"var(--card)",border:"1px solid var(--border)",borderRadius:10,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
      <span style={{fontSize:11,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.05em"}}>Apply Rate Card:</span>
      {(rateCards||[]).map(rc=>(<button key={rc.id} onClick={()=>applyRateCard(rc)} style={{...BTN,background:"var(--bg)",color:"var(--fg)",border:"1px solid var(--border)"}}>{rc.name}</button>))}
      <button onClick={()=>{const items=q.items.map(it=>({...it,rateOverride:null}));setQ({items});}} style={{...BTN,background:"#374151",color:"#9CA3AF"}}>Reset to Default</button>
    </div>)}

    {/* Line items by section */}
    {sections.map(sec=>{
      const hasHours=sec.items.some(it=>it.hours>0);
      return(<div key={sec.id} style={{marginBottom:16,background:"var(--card)",border:"1px solid var(--border)",borderRadius:10,overflow:"hidden"}}>
        <div style={{padding:"10px 16px",borderBottom:"1px solid var(--border)",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span style={{fontSize:12,fontWeight:700,color:"var(--fg)",textTransform:"uppercase",letterSpacing:"0.05em"}}>{sec.name}</span>
          {hasHours&&<span style={{fontSize:12,fontWeight:700,color:"var(--accent)",fontFamily:"'JetBrains Mono',monospace"}}>{fmtCur(sec.subtotal)}</span>}
        </div>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
          <thead><tr>
            <th style={{...TH,textAlign:"left",padding:"6px 16px"}}>Role</th>
            <th style={{...TH,textAlign:"right",padding:"6px 12px",width:90}}>Rate/h</th>
            <th style={{...TH,textAlign:"right",padding:"6px 12px",width:70}}>Hours</th>
            <th style={{...TH,textAlign:"right",padding:"6px 16px",width:100}}>Cost</th>
          </tr></thead>
          <tbody>{sec.items.map(it=>(<tr key={it.id}>
            <td style={{padding:"5px 16px",color:"var(--fg)",fontWeight:500}}>{it.role}</td>
            <td style={{padding:"5px 12px",textAlign:"right"}}>
              <input type="number" value={it.rateOverride??it.rate} onChange={e=>!locked&&updateItem(it.id,{rateOverride:parseFloat(e.target.value)||0})} disabled={locked} step={0.5}
                style={{...inputStyle,width:80,background:it.rateOverride!=null&&!locked?"#1A1A10":"var(--input-bg)"}}/>
            </td>
            <td style={{padding:"5px 12px",textAlign:"right"}}>
              <input type="number" value={it.hours||""} onChange={e=>!locked&&updateItem(it.id,{hours:parseFloat(e.target.value)||0})} disabled={locked} min={0} step={0.5} placeholder="0"
                style={{...inputStyle,width:60}}/>
            </td>
            <td style={{padding:"5px 16px",textAlign:"right",fontFamily:"'JetBrains Mono',monospace",fontWeight:600,color:it.cost>0?"var(--fg)":"var(--muted)"}}>{it.cost>0?fmtCur(it.cost):"-"}</td>
          </tr>))}</tbody>
        </table>
      </div>);
    })}

    {/* Custom items */}
    {(q.customItems||[]).length>0&&(<div style={{marginBottom:16,background:"var(--card)",border:"1px solid var(--border)",borderRadius:10,overflow:"hidden"}}>
      <div style={{padding:"10px 16px",borderBottom:"1px solid var(--border)"}}><span style={{fontSize:12,fontWeight:700,color:"var(--fg)",textTransform:"uppercase",letterSpacing:"0.05em"}}>Custom Items</span></div>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
        <thead><tr><th style={{...TH,textAlign:"left",padding:"6px 16px"}}>Item</th><th style={{...TH,textAlign:"right",padding:"6px 8px",width:80}}>Rate</th><th style={{...TH,textAlign:"right",padding:"6px 8px",width:60}}>Hrs</th><th style={{...TH,textAlign:"right",padding:"6px 8px",width:60}}>Margin</th><th style={{...TH,textAlign:"right",padding:"6px 12px",width:90}}>Sell</th><th style={{...TH,width:30}}></th></tr></thead>
        <tbody>{(q.customItems||[]).map(it=>{const bc=it.rate*(it.hours||0);const sc=bc+bc*(it.margin||0);return(<tr key={it.id}>
          <td style={{padding:"5px 16px"}}><input value={it.role} onChange={e=>!locked&&updateCustom(it.id,{role:e.target.value})} disabled={locked} style={{...inputStyle,textAlign:"left",fontWeight:500}}/></td>
          <td style={{padding:"5px 8px"}}><input type="number" value={it.rate} onChange={e=>!locked&&updateCustom(it.id,{rate:parseFloat(e.target.value)||0})} disabled={locked} style={{...inputStyle,width:70}}/></td>
          <td style={{padding:"5px 8px"}}><input type="number" value={it.hours||""} onChange={e=>!locked&&updateCustom(it.id,{hours:parseFloat(e.target.value)||0})} disabled={locked} min={0} placeholder="0" style={{...inputStyle,width:50}}/></td>
          <td style={{padding:"5px 8px"}}><input type="number" value={Math.round((it.margin||0)*100)||""} onChange={e=>!locked&&updateCustom(it.id,{margin:(parseFloat(e.target.value)||0)/100})} disabled={locked} min={0} placeholder="0" style={{...inputStyle,width:50}} title="Margin % on this item"/></td>
          <td style={{padding:"5px 12px",textAlign:"right",fontFamily:"'JetBrains Mono',monospace",fontWeight:600,color:sc>0?"#10B981":"var(--muted)"}}>{sc>0?fmtCur(sc):"-"}</td>
          <td style={{padding:"5px 8px"}}>{!locked&&<button onClick={()=>rmCustom(it.id)} style={{background:"none",border:"none",color:"#5A6B85",cursor:"pointer",fontSize:14}}>x</button>}</td>
        </tr>);})}</tbody>
      </table>
    </div>)}
    {!locked&&<button onClick={addCustomItem} style={{marginBottom:20,padding:"8px 16px",borderRadius:8,border:"1px dashed var(--border)",background:"transparent",color:"var(--muted)",fontSize:12,fontWeight:600,cursor:"pointer"}}>+ Add Custom Line Item</button>}

    {/* Totals + Margin */}
    <div style={{background:"var(--card)",border:"1px solid var(--border)",borderRadius:10,padding:"20px",marginBottom:20}}>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:16,marginBottom:16}}>
        <div><div style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",marginBottom:4}}>Total Cost</div><div style={{fontSize:24,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:"var(--fg)"}}>{fmtCur(totalCost)}</div></div>
        <div><div style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",marginBottom:4}}>Sell Price (ex GST)</div><div style={{fontSize:24,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:"#10B981"}}>{fmtCur(sellExGST)}</div></div>
        <div><div style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",marginBottom:4}}>Sell Price (inc GST)</div><div style={{fontSize:24,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:"var(--fg)"}}>{fmtCur(sellIncGST)}</div></div>
      </div>
      <div style={{display:"flex",gap:16,alignItems:"center",flexWrap:"wrap",marginBottom:12}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <label style={{fontSize:11,fontWeight:600,color:"var(--muted)"}}>Set Margin %</label>
          <input type="number" value={q.sellPriceMode?"":Math.round((q.margin||0)*100)} onChange={e=>{const v=parseFloat(e.target.value);if(!isNaN(v))setQ({margin:v/100,sellPriceMode:false,sellPrice:null});}} disabled={locked||q.sellPriceMode} min={0} max={90}
            style={{...inputStyle,width:60,textAlign:"center",opacity:q.sellPriceMode?0.4:1}}/>
        </div>
        <span style={{color:"var(--muted)",fontSize:12}}>or</span>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <label style={{fontSize:11,fontWeight:600,color:"var(--muted)"}}>Set Sell Price $</label>
          <input type="number" value={q.sellPriceMode?(q.sellPrice||""):""} onChange={e=>{const v=parseFloat(e.target.value);if(!isNaN(v))setQ({sellPrice:v,sellPriceMode:true});}} disabled={locked} min={0}
            style={{...inputStyle,width:100,textAlign:"center",opacity:!q.sellPriceMode?0.4:1}}/>
          {q.sellPriceMode&&<button onClick={()=>setQ({sellPriceMode:false,sellPrice:null})} style={{...BTN,background:"#374151",color:"#9CA3AF",fontSize:10}}>Clear</button>}
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:16}}>
        <div><div style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",marginBottom:4}}>Margin</div><div style={{fontSize:18,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:margin>=0.3?"#10B981":margin>=0.15?"#EAB308":"#EF4444"}}>{pct(margin)}</div></div>
        <div><div style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",marginBottom:4}}>Net Profit</div><div style={{fontSize:18,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:"var(--fg)"}}>{fmtCur(profit)}</div></div>
        <div><div style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",marginBottom:4}}>After Tax (20%)</div><div style={{fontSize:18,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:"var(--fg)"}}>{fmtCur(profitAfterTax)}</div></div>
      </div>
    </div>

    {/* Email Generator */}
    <div style={{background:"var(--card)",border:"1px solid var(--border)",borderRadius:10,padding:"20px"}}>
      <div style={{fontSize:13,fontWeight:700,color:"var(--fg)",marginBottom:12}}>Client Email Format</div>
      {!emailText?(<button onClick={()=>setEmailText(genEmail())} style={{...BTN,background:"var(--accent)",color:"white"}}>Generate Email Text</button>):(
        <div>
          <textarea value={emailText} onChange={e=>setEmailText(e.target.value)} rows={14}
            style={{width:"100%",padding:12,borderRadius:8,border:"1px solid var(--border)",background:"var(--input-bg)",color:"var(--fg)",fontSize:13,fontFamily:"'DM Sans',sans-serif",lineHeight:1.6,outline:"none",resize:"vertical"}}/>
          <div style={{display:"flex",gap:8,marginTop:8}}>
            <button onClick={()=>{navigator.clipboard?.writeText(emailText);setCopied(true);setTimeout(()=>setCopied(false),2000);}} style={{...BTN,background:"#10B981",color:"white"}}>{copied?"Copied!":"Copy to Clipboard"}</button>
            <button onClick={()=>setEmailText(genEmail())} style={{...BTN,background:"#374151",color:"#9CA3AF"}}>Regenerate</button>
            <button onClick={()=>setEmailText(null)} style={{...BTN,background:"#374151",color:"#9CA3AF"}}>Close</button>
          </div>
        </div>
      )}
    </div>
  </div>);
}


// ─── Editor Dashboard ───
function EditorDashboard({embedded,onLogout}){
  const[editorId,setEditorId]=useState(null);
  const[tasks,setTasks]=useState([]);
  const[loading,setLoading]=useState(false);
  const[timers,setTimers]=useState({}); // {taskId: {running:bool, elapsed:secs, startedAt:timestamp}}
  const[timeLogs,setTimeLogs]=useState({}); // {taskId: totalSecs} from Firebase
  const intervalRef=useRef(null);
  const today=todayKey();

  // Init Firebase
  useEffect(()=>{initFB();},[]);

  // Load tasks when editor selected
  useEffect(()=>{
    if(!editorId)return;
    setLoading(true);
    const ed=MONDAY_EDITORS.find(e=>e.id===editorId);
    if(!ed){setLoading(false);return;}
    fetchEditorTasks(ed.name).then(items=>{setTasks(items);setLoading(false);}).catch(()=>setLoading(false));
  },[editorId]);

  // Listen to Firebase time logs for this editor + today
  useEffect(()=>{
    if(!editorId)return;
    const path=`/timeLogs/${editorId}/${today}`;
    let unsub=()=>{};
    onFB(()=>{unsub=fbListen(path,(data)=>{if(data)setTimeLogs(data);else setTimeLogs({});});});
    return()=>unsub();
  },[editorId,today]);

  // Timer tick
  useEffect(()=>{
    intervalRef.current=setInterval(()=>{
      setTimers(prev=>{
        const next={...prev};
        let changed=false;
        Object.keys(next).forEach(tid=>{
          if(next[tid].running){
            const elapsed=Math.floor((Date.now()-next[tid].startedAt)/1000);
            if(elapsed!==next[tid].elapsed){next[tid]={...next[tid],elapsed};changed=true;}
          }
        });
        return changed?next:prev;
      });
    },1000);
    return()=>clearInterval(intervalRef.current);
  },[]);

  const startTimer=(taskId)=>{
    setTimers(prev=>({...prev,[taskId]:{running:true,elapsed:0,startedAt:Date.now()}}));
  };

  const stopTimer=(taskId)=>{
    const t=timers[taskId];
    if(!t||!t.running)return;
    const elapsed=Math.floor((Date.now()-t.startedAt)/1000);
    setTimers(prev=>({...prev,[taskId]:{running:false,elapsed:0,startedAt:null}}));
    // Save to Firebase
    const prev=timeLogs[taskId]||0;
    const newTotal=prev+elapsed;
    const path=`/timeLogs/${editorId}/${today}/${taskId}`;
    fbSet(path,newTotal);
    setTimeLogs(p=>({...p,[taskId]:newTotal}));
  };

  const resetTimer=(taskId)=>{
    const path=`/timeLogs/${editorId}/${today}/${taskId}`;
    fbSet(path,0);
    setTimeLogs(p=>({...p,[taskId]:0}));
    setTimers(prev=>({...prev,[taskId]:{running:false,elapsed:0,startedAt:null}}));
  };

  const isRunning=(taskId)=>timers[taskId]?.running;
  const currentElapsed=(taskId)=>timers[taskId]?.elapsed||0;
  const loggedTime=(taskId)=>timeLogs[taskId]||0;
  const totalToday=Object.values(timeLogs).reduce((a,b)=>a+b,0);

  const editorName=MONDAY_EDITORS.find(e=>e.id===editorId)?.name||"";

  if(!editorId){
    return(<div style={{minHeight:embedded?"auto":"100vh",display:"flex",alignItems:embedded?"flex-start":"center",justifyContent:"center",background:embedded?"transparent":"var(--bg)",fontFamily:"'DM Sans',-apple-system,sans-serif",padding:embedded?"24px 28px":0}}>
      <div style={{width:420,padding:"48px 40px",background:"var(--card)",borderRadius:16,border:"1px solid var(--border)",textAlign:"center"}}>
        {!embedded&&<div style={{marginBottom:32,display:"flex",justifyContent:"center"}}><Logo h={36}/></div>}
        <div style={{fontSize:18,fontWeight:700,color:"var(--fg)",marginBottom:6}}>Editor Dashboard</div>
        <div style={{fontSize:13,color:"var(--muted)",marginBottom:28}}>Select your name to see today's tasks</div>
        <div style={{display:"grid",gap:10}}>
          {MONDAY_EDITORS.map(ed=>(
            <button key={ed.id} onClick={()=>setEditorId(ed.id)}
              style={{padding:"14px 20px",borderRadius:10,border:"1px solid var(--border)",background:"var(--bg)",color:"var(--fg)",fontSize:15,fontWeight:600,cursor:"pointer",transition:"all 0.15s",textAlign:"left",display:"flex",alignItems:"center",gap:12}}>
              <span style={{width:36,height:36,borderRadius:"50%",background:"var(--accent-soft)",color:"var(--accent)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:800}}>{ed.name.split(" ").map(n=>n[0]).join("")}</span>
              {ed.name}
            </button>
          ))}
        </div>
      </div>
    </div>);
  }

  return(<div style={{fontFamily:"'DM Sans',-apple-system,sans-serif",background:embedded?"transparent":"var(--bg)",color:"var(--fg)",minHeight:embedded?"auto":"100vh"}}>
    {/* Header */}
    <div style={{padding:"16px 28px",borderBottom:"1px solid var(--border)",background:"var(--card)",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
      <div style={{display:"flex",alignItems:"center",gap:16}}>
        {!embedded&&<Logo h={22}/>}
        <div>
          <div style={{fontSize:15,fontWeight:700,color:"var(--fg)"}}>Editor Dashboard</div>
          <div style={{fontSize:12,color:"var(--muted)"}}>{editorName}</div>
        </div>
      </div>
      <div style={{display:"flex",alignItems:"center",gap:16}}>
        <div style={{padding:"8px 16px",borderRadius:8,background:totalToday>0?"rgba(16,185,129,0.12)":"var(--bg)",border:"1px solid var(--border)"}}>
          <span style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.05em"}}>Today's Total </span>
          <span style={{fontSize:18,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:totalToday>0?"#10B981":"var(--fg)",marginLeft:8}}>{fmtSecsShort(totalToday)}</span>
        </div>
        <button onClick={()=>{setLoading(true);const ed=MONDAY_EDITORS.find(e=>e.id===editorId);if(ed)fetchEditorTasks(ed.name).then(items=>{setTasks(items);setLoading(false);}).catch(()=>setLoading(false));}} style={{padding:"8px 14px",borderRadius:8,border:"1px solid var(--border)",background:"transparent",color:"var(--muted)",fontSize:12,fontWeight:600,cursor:"pointer"}}>Refresh</button>
        <button onClick={()=>setEditorId(null)} style={{padding:"8px 14px",borderRadius:8,border:"1px solid var(--border)",background:"transparent",color:"var(--muted)",fontSize:12,fontWeight:600,cursor:"pointer"}}>Switch Editor</button>
      </div>
    </div>

    {/* Task List */}
    <div style={{maxWidth:900,margin:"0 auto",padding:"24px 28px 60px"}}>
      <div style={{fontSize:11,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:16}}>
        {new Date().toLocaleDateString("en-AU",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}
      </div>

      {loading?(<div style={{textAlign:"center",padding:60,color:"var(--muted)"}}>Loading tasks from Monday.com...</div>)
      :tasks.length===0?(<div style={{textAlign:"center",padding:60,color:"var(--muted)"}}><div style={{fontSize:40,marginBottom:12}}>🎬</div><div style={{fontSize:16,fontWeight:600,marginBottom:8}}>No tasks assigned</div><div style={{fontSize:13}}>No "In Progress" tasks found for {editorName} on Monday.com</div></div>)
      :(<div style={{display:"grid",gap:12}}>
        {tasks.map(task=>{
          const running=isRunning(task.id);
          const elapsed=currentElapsed(task.id);
          const logged=loggedTime(task.id);
          const stageColors={"Edit":"#0082FA","Shoot":"#F87700","Pre Production":"#8B5CF6","Revisions":"#EF4444","Delivery":"#10B981"};
          const stageCol=stageColors[task.stage]||"var(--accent)";

          return(<div key={task.id} style={{background:"var(--card)",border:`1px solid ${running?"var(--accent)":"var(--border)"}`,borderRadius:12,padding:"20px 24px",transition:"all 0.2s",boxShadow:running?"0 0 30px rgba(0,130,250,0.1)":"none"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:16}}>
              <div style={{flex:1}}>
                <div style={{fontSize:11,fontWeight:700,color:"var(--muted)",marginBottom:4,textTransform:"uppercase",letterSpacing:"0.04em"}}>{task.parentName}</div>
                <div style={{fontSize:15,fontWeight:700,color:"var(--fg)",marginBottom:8,lineHeight:1.3}}>{task.name}</div>
                <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                  {task.stage&&<span style={{fontSize:10,fontWeight:700,padding:"3px 10px",borderRadius:4,background:`${stageCol}20`,color:stageCol,textTransform:"uppercase",letterSpacing:"0.04em"}}>{task.stage}</span>}
                  {task.status&&<span style={{fontSize:10,fontWeight:700,padding:"3px 10px",borderRadius:4,background:task.status==="IN PROGRESS"?"rgba(16,185,129,0.12)":task.status==="STUCK"?"rgba(239,68,68,0.12)":"var(--accent-soft)",color:task.status==="IN PROGRESS"?"#10B981":task.status==="STUCK"?"#EF4444":"var(--accent)",textTransform:"uppercase",letterSpacing:"0.04em"}}>{task.status}</span>}
                  {task.timeline&&<span style={{fontSize:10,fontWeight:600,padding:"3px 10px",borderRadius:4,background:"var(--bg)",color:"var(--muted)"}}>{task.timeline}</span>}
                  {task.overdue&&<span style={{fontSize:10,fontWeight:700,padding:"3px 10px",borderRadius:4,background:"rgba(239,68,68,0.12)",color:"#EF4444",textTransform:"uppercase",letterSpacing:"0.04em"}}>Overdue</span>}
                </div>
              </div>

              {/* Timer */}
              <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:8,minWidth:180}}>
                {/* Current timer */}
                {running&&(
                  <div style={{fontSize:28,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:"var(--accent)",lineHeight:1}}>
                    {fmtSecs(elapsed)}
                  </div>
                )}
                {/* Logged today */}
                {logged>0&&(
                  <div style={{fontSize:12,color:"var(--muted)"}}>
                    Logged today: <span style={{fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:"#10B981"}}>{fmtSecsShort(logged)}</span>
                  </div>
                )}
                {/* Buttons */}
                <div style={{display:"flex",gap:6}}>
                  {!running?(
                    <button onClick={()=>startTimer(task.id)}
                      style={{padding:"10px 20px",borderRadius:8,border:"none",background:"#10B981",color:"white",fontSize:13,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",gap:6}}>
                      ▶ Start
                    </button>
                  ):(
                    <button onClick={()=>stopTimer(task.id)}
                      style={{padding:"10px 20px",borderRadius:8,border:"none",background:"#EF4444",color:"white",fontSize:13,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",gap:6}}>
                      ■ Stop
                    </button>
                  )}
                  {logged>0&&!running&&(
                    <button onClick={()=>resetTimer(task.id)}
                      style={{padding:"10px 14px",borderRadius:8,border:"1px solid var(--border)",background:"transparent",color:"var(--muted)",fontSize:11,fontWeight:600,cursor:"pointer"}}>
                      Reset
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>);
        })}
      </div>)}

      {/* Daily Summary */}
      {totalToday>0&&(<div style={{marginTop:24,background:"var(--card)",border:"1px solid var(--border)",borderRadius:12,padding:"20px 24px"}}>
        <div style={{fontSize:13,fontWeight:700,color:"var(--fg)",marginBottom:12}}>Today's Summary</div>
        <div style={{display:"grid",gap:6}}>
          {tasks.filter(t=>loggedTime(t.id)>0).map(t=>(
            <div key={t.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 12px",background:"var(--bg)",borderRadius:8}}>
              <div><span style={{fontSize:11,color:"var(--muted)"}}>{t.parentName}</span><br/><span style={{fontSize:13,color:"var(--fg)",fontWeight:500}}>{t.name}</span></div>
              <span style={{fontSize:14,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:"#10B981"}}>{fmtSecsShort(loggedTime(t.id))}</span>
            </div>
          ))}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 12px",borderTop:"2px solid var(--border)",marginTop:4}}>
            <span style={{fontSize:13,fontWeight:700,color:"var(--fg)"}}>Total</span>
            <span style={{fontSize:18,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:"#10B981"}}>{fmtSecsShort(totalToday)}</span>
          </div>
        </div>
      </div>)}
    </div>
  </div>);
}


// ─── Login ───
function Login({onLogin}){
  const[pw,setPw]=useState("");const[err,setErr]=useState(false);const[shake,setShake]=useState(false);
  const ref=useRef(null);useEffect(()=>{ref.current?.focus();},[]);
  const go=()=>{if(onLogin(pw)){setErr(false);}else{setErr(true);setShake(true);setTimeout(()=>setShake(false),500);setPw("");}};
  return(<div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"var(--bg)",fontFamily:"'DM Sans',-apple-system,sans-serif"}}><div style={{width:380,padding:"48px 40px",background:"var(--card)",borderRadius:16,border:"1px solid var(--border)",textAlign:"center",animation:shake?"shake 0.5s ease":"none"}}><div style={{marginBottom:32,display:"flex",justifyContent:"center"}}><Logo h={36}/></div><div style={{fontSize:18,fontWeight:700,color:"var(--fg)",marginBottom:6}}>Viewix Tools</div><div style={{fontSize:13,color:"var(--muted)",marginBottom:28}}>Enter password to continue</div><div><input ref={ref} type="password" value={pw} onChange={e=>{setPw(e.target.value);setErr(false);}} onKeyDown={e=>{if(e.key==="Enter")go();}} placeholder="Password" style={{width:"100%",padding:"12px 16px",borderRadius:10,border:`1px solid ${err?"#EF4444":"var(--border)"}`,background:"var(--input-bg)",color:"var(--fg)",fontSize:15,outline:"none",marginBottom:12,textAlign:"center",letterSpacing:"0.15em"}}/>{err&&<div style={{fontSize:12,color:"#EF4444",marginBottom:10}}>Wrong password</div>}<button onClick={go} style={{width:"100%",padding:"12px",borderRadius:10,border:"none",background:"#0082FA",color:"white",fontSize:14,fontWeight:700,cursor:"pointer"}}>Sign In</button></div></div></div>);
}

// ─── Sidebar Icon ───
function SideIcon({icon,label,active,onClick}){
  return(<button onClick={onClick} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:4,padding:"12px 8px",borderRadius:8,border:"none",background:active?"var(--accent-soft)":"transparent",color:active?"var(--accent)":"var(--muted)",cursor:"pointer",width:"100%",transition:"all 0.15s"}} title={label}>
    <span style={{fontSize:20}}>{icon}</span>
    <span style={{fontSize:9,fontWeight:700,letterSpacing:"0.03em",textTransform:"uppercase"}}>{label}</span>
  </button>);
}

// ─── Main App ───
export default function App(){
  const[role,setRole]=useState(null); // "founder" | "closer"
  const[loading,setLoading]=useState(true);
  const[tool,setTool]=useState("capacity"); // "capacity" | "quoting"
  const[capTab,setCapTab]=useState("dashboard");

  // Capacity state
  const[inputs,setInputs]=useState(DEF_IN);
  const[editors,setEditors]=useState(DEF_EDS);
  const[weekData,setWeekData]=useState({});
  const[curW,setCurW]=useState(wKey(ORIGIN));
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

  // Merge default + custom rate cards, filtering out hidden defaults
  const rcArr=Array.isArray(clientRateCards)?clientRateCards:[];
  const hiddenIds=rcArr.filter(c=>c&&c.deleted).map(c=>c.id.replace("del-",""));
  const visibleDefaults=DEFAULT_RATE_CARDS.filter(d=>!hiddenIds.includes(d.id));
  const customOnly=rcArr.filter(c=>c&&!c.deleted&&!c.archived);
  const archivedCards=rcArr.filter(c=>c&&c.archived);
  const allRateCards=[...visibleDefaults,...customOnly];

  const skipWrite=useRef(true);

  // Firebase
  useEffect(()=>{
    initFB();
    const fallback=setTimeout(()=>{setLoading(false);skipWrite.current=false;},3000);
    onFB(()=>{
      clearTimeout(fallback);
      fbListen("/",(data)=>{
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
          }
        }catch(e){console.error("Firebase data parse error:",e);}
        setLoading(false);
        setTimeout(()=>{skipWrite.current=false;},500);
      });
    });
  },[]);

  const wt=useRef(null);
  useEffect(()=>{if(skipWrite.current)return;if(wt.current)clearTimeout(wt.current);wt.current=setTimeout(()=>{try{fbSet("/inputs",inputs);fbSet("/editors",editors);fbSet("/weekData",weekData);const qObj={};quotes.forEach(q=>{if(q&&q.id)qObj[q.id]=q;});fbSet("/quotes",qObj);const rcObj={};rcArr.forEach(r=>{if(r&&r.id)rcObj[r.id]=r;});fbSet("/clientRateCards",rcObj);}catch(e){console.error("Firebase write error:",e);}},400);},[inputs,editors,weekData,quotes,clientRateCards]);

  useEffect(()=>{if(rosterAdding&&rosterAddRef.current)rosterAddRef.current.focus();},[rosterAdding]);
  useEffect(()=>{if(rosterEditId&&rosterEditRef.current)rosterEditRef.current.focus();},[rosterEditId]);

  const login=pw=>{if(pw==="Push"){setRole("founder");return true;}if(pw==="Close"){setRole("closer");setTool("quoting");return true;}if(pw==="Letsgo"){setRole("editor");return true;}return false;};
  const logout=()=>{setRole(null);};

  // Capacity helpers
  const goW=dir=>setCurW(wKey(addW(new Date(curW+"T00:00:00"),dir)));
  const goToday=()=>setCurW(wKey(ORIGIN));
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

  if(!role)return(<><style>{CSS}</style><Login onLogin={login}/></>);
  if(role==="editor")return(<><style>{CSS}</style><EditorDashboard/></>);
  if(loading)return(<div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#0B0F1A"}}><style>{CSS}</style><div style={{textAlign:"center"}}><Logo h={36}/><div style={{marginTop:16,color:"#5A6B85",fontSize:14}}>Loading...</div></div></div>);

  const isFounder=role==="founder";

  return(<div style={{fontFamily:"'DM Sans',-apple-system,sans-serif",background:"var(--bg)",color:"var(--fg)",minHeight:"100vh",display:"flex"}}><style>{CSS}</style>

    {/* Sidebar */}
    <div style={{width:72,background:"var(--card)",borderRight:"1px solid var(--border)",display:"flex",flexDirection:"column",alignItems:"center",padding:"16px 8px",gap:4,flexShrink:0}}>
      <div style={{marginBottom:12}}><Logo h={20}/></div>
      {isFounder&&<SideIcon icon="📊" label="Capacity" active={tool==="capacity"} onClick={()=>setTool("capacity")}/>}
      <SideIcon icon="💰" label="Quoting" active={tool==="quoting"} onClick={()=>setTool("quoting")}/>
      {isFounder&&<SideIcon icon="🎬" label="Editors" active={tool==="editors"} onClick={()=>setTool("editors")}/>}
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
          {[{key:"dashboard",label:"Dashboard"},{key:"roster",label:"Team Roster"},{key:"schedule",label:"Weekly Schedule"},{key:"forecast",label:"Forecast"}].map(t=>(<button key={t.key} onClick={()=>setCapTab(t.key)} style={{padding:"7px 14px",borderRadius:6,border:"none",background:capTab===t.key?"var(--card)":"transparent",color:capTab===t.key?"var(--fg)":"var(--muted)",fontSize:12,fontWeight:600,cursor:"pointer"}}>{t.label}</button>))}
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
                const sell=q.sellPriceMode&&q.sellPrice?q.sellPrice:cost>0?cost/(1-(q.margin||0.4)):0;
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

    {/* ═══ EDITOR DASHBOARD ═══ */}
    {tool==="editors"&&isFounder&&(<EditorDashboard embedded/>)}

    </div>
  </div>);
}

const CSS=`
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,100..1000;1,9..40,100..1000&family=JetBrains+Mono:wght@400;600;700;800&display=swap');
:root{--bg:#0B0F1A;--fg:#E8ECF4;--card:#131825;--border:#1E2A3A;--border-light:#161D2C;--muted:#5A6B85;--accent:#0082FA;--accent-soft:rgba(0,130,250,0.12);--bar-bg:#1A2030;--input-bg:#0F1520;}
*{box-sizing:border-box;margin:0;padding:0;}
input[type="number"]::-webkit-inner-spin-button,input[type="number"]::-webkit-outer-spin-button{-webkit-appearance:none;}
input[type="number"]{-moz-appearance:textfield;}
::-webkit-scrollbar{width:6px;height:6px;}
::-webkit-scrollbar-track{background:var(--bg);}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px;}
@keyframes shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-8px)}40%{transform:translateX(8px)}60%{transform:translateX(-4px)}80%{transform:translateX(4px)}}
`;

