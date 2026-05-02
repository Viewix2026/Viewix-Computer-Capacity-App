import { useState, useEffect, useRef } from "react";
import { DEFAULT_MONDAY_EDITORS, BTN, NB, CAT_COLORS } from "../config";
import { todayKey, tomorrowKey, fmtSecs, fmtSecsShort, categorizeContent } from "../utils";
import { initFB, onFB, fbSet, fbListen } from "../firebase";
import { fetchMondayUsers, fetchEditorTasks, fetchItemUpdates } from "../monday";
import { Logo } from "./Logo";
import { EditorDashboardViewix } from "./EditorDashboardViewix";

export function EditorDashboard({ embedded, onLogout, projects = [], editors: viewixEditors = [], clients = [] }) {
  // Sub-tab between the original Monday.com-driven view and the new
  // Viewix Dashboard view (Firebase-backed, reads /editors + /projects
  // subtasks). Defaults to Viewix — that's where the Projects + Team
  // Board data lives; Monday.com stays one click away via the toggle
  // for legacy reference.
  const [subTab, setSubTab] = useState("viewix");
  const[editorId,setEditorId]=useState(null);
  const[tasks,setTasks]=useState([]);
  const[loading,setLoading]=useState(false);
  const[viewMode,setViewMode]=useState("tasks"); // "tasks" | "timeline"
  const[timers,setTimers]=useState({}); // {taskId: {running:bool, elapsed:secs, startedAt:timestamp}}
  const[timeLogs,setTimeLogs]=useState({}); // {taskId: totalSecs} from Firebase
  const[expanded,setExpanded]=useState({}); // {parentId: true/false}
  const[updates,setUpdates]=useState({}); // {parentId: [...updates]}
  const[loadingUpdates,setLoadingUpdates]=useState({});
  const[mondayEditors,setMondayEditors]=useState(DEFAULT_MONDAY_EDITORS);
  const[editorsLoading,setEditorsLoading]=useState(true);
  const[selectedTask,setSelectedTask]=useState(null);
  const[selectedTaskUpdates,setSelectedTaskUpdates]=useState(null);
  const[selectedTaskLoading,setSelectedTaskLoading]=useState(false);
  const[timerWarning,setTimerWarning]=useState(null); // {pendingTaskId, runningTaskId, runningTaskName}
  const[adjustingTask,setAdjustingTask]=useState(null); // taskId being adjusted
  const[adjustMins,setAdjustMins]=useState("");
  const intervalRef=useRef(null);
  const justStoppedRef=useRef({}); // guard: {taskId: timestamp} prevents listener from re-enabling stopped timers
  const today=todayKey();

  // Init Firebase and load editors. Cleanup on unmount so the /mondayEditors
  // listener doesn't stack when the producer switches in and out of the
  // Editors tab. The bug was: each mount attached a fresh listener without
  // ever calling off(), so over a long session listeners accumulated —
  // eventually contributing to memory pressure that other tabs inherited.
  useEffect(()=>{
    initFB();
    let unsub=()=>{};
    let cancelled=false;
    onFB(()=>{
      if(cancelled)return;
      unsub=fbListen("/mondayEditors",(data)=>{
        if(data&&Array.isArray(data)&&data.length>0){setMondayEditors(data);setEditorsLoading(false);}
        else{fetchMondayUsers().then(users=>{if(cancelled)return;if(users&&users.length>0){setMondayEditors(users);fbSet("/mondayEditors",users);}setEditorsLoading(false);}).catch(()=>{if(!cancelled)setEditorsLoading(false);});}
      });
    });
    return()=>{cancelled=true;unsub();};
  },[]);

  // Load tasks when editor selected
  useEffect(()=>{
    if(!editorId)return;
    setLoading(true);
    const ed=mondayEditors.find(e=>e.id===editorId);
    if(!ed){setLoading(false);return;}
    fetchEditorTasks(ed.name).then(items=>{setTasks(items);setLoading(false);}).catch(()=>setLoading(false));
  },[editorId]);

  // Listen to Firebase time logs for this editor + today, resume running timer.
  // `cancelled` guard prevents the onFB callback from attaching a fresh
  // listener AFTER the cleanup has already run — previously if the effect
  // re-fired (editorId change) before onFB resolved, the old listener leaked.
  useEffect(()=>{
    if(!editorId)return;
    const path=`/timeLogs/${editorId}/${today}`;
    let unsub=()=>{};
    let cancelled=false;
    onFB(()=>{if(cancelled)return;unsub=fbListen(path,(data)=>{
      if(data){
        const{_running,...logs}=data;
        setTimeLogs(logs);
        if(_running&&_running.taskId&&_running.startedAt){
          // Guard: don't re-enable a timer that was just stopped (within last 3 seconds)
          const stoppedAt=justStoppedRef.current[_running.taskId];
          if(stoppedAt&&(Date.now()-stoppedAt)<3000)return;
          setTimers(prev=>{
            if(prev[_running.taskId]?.running)return prev;
            return{...prev,[_running.taskId]:{running:true,elapsed:Math.floor((Date.now()-_running.startedAt)/1000),startedAt:_running.startedAt}};
          });
        }
      }else{setTimeLogs({});}
    });});
    return()=>{cancelled=true;unsub();};
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

  const getRunningTaskId=()=>{
    for(const tid of Object.keys(timers)){if(timers[tid]?.running)return tid;}
    return null;
  };

  const startTimer=(taskId)=>{
    const runningId=getRunningTaskId();
    if(runningId&&runningId!==taskId){
      const runningTask=tasks.find(t=>t.id===runningId);
      setTimerWarning({pendingTaskId:taskId,runningTaskId:runningId,runningTaskName:runningTask?.name||"another task"});
      return;
    }
    doStartTimer(taskId);
  };

  const doStartTimer=(taskId)=>{
    const now=Date.now();
    setTimers(prev=>({...prev,[taskId]:{running:true,elapsed:0,startedAt:now}}));
    fbSet(`/timeLogs/${editorId}/${today}/_running`,{taskId,startedAt:now});
  };

  const confirmTimerSwitch=()=>{
    if(!timerWarning)return;
    stopTimer(timerWarning.runningTaskId);
    doStartTimer(timerWarning.pendingTaskId);
    setTimerWarning(null);
  };

  const stopTimer=(taskId)=>{
    const t=timers[taskId];
    if(!t||!t.running)return;
    // Set guard immediately to prevent listener from re-enabling this timer
    justStoppedRef.current[taskId]=Date.now();
    const elapsed=Math.floor((Date.now()-t.startedAt)/1000);
    setTimers(prev=>({...prev,[taskId]:{running:false,elapsed:0,startedAt:null}}));
    // Clear _running FIRST to prevent listener race condition
    fbSet(`/timeLogs/${editorId}/${today}/_running`,null);
    const prevLog=timeLogs[taskId]||{};
    const prevSecs=typeof prevLog==="number"?prevLog:(prevLog.secs||0);
    const newTotal=prevSecs+elapsed;
    const task=tasks.find(t2=>t2.id===taskId);
    const category=categorizeContent(task?.parentName,task?.parentInfo?.type);
    const logData={secs:newTotal,name:task?.name||"",parentName:task?.parentName||"",stage:task?.stage||"",type:task?.parentInfo?.type||"",category:category};
    fbSet(`/timeLogs/${editorId}/${today}/${taskId}`,logData);
    setTimeLogs(p=>({...p,[taskId]:logData}));
  };

  const resetTimer=(taskId)=>{
    const path=`/timeLogs/${editorId}/${today}/${taskId}`;
    fbSet(path,null);
    fbSet(`/timeLogs/${editorId}/${today}/_running`,null);
    setTimeLogs(p=>{const n={...p};delete n[taskId];return n;});
    setTimers(prev=>({...prev,[taskId]:{running:false,elapsed:0,startedAt:null}}));
  };

  const adjustTime=(taskId,minutes)=>{
    const secs=Math.round(minutes*60);
    const prevLog=timeLogs[taskId]||{};
    const prevSecs=typeof prevLog==="number"?prevLog:(prevLog.secs||0);
    const newTotal=Math.max(0,prevSecs+secs);
    const task=tasks.find(t2=>t2.id===taskId);
    const category=categorizeContent(task?.parentName,task?.parentInfo?.type);
    const logData={secs:newTotal,name:task?.name||"",parentName:task?.parentName||"",stage:task?.stage||"",type:task?.parentInfo?.type||"",category:category};
    fbSet(`/timeLogs/${editorId}/${today}/${taskId}`,logData);
    setTimeLogs(p=>({...p,[taskId]:logData}));
    setAdjustingTask(null);
    setAdjustMins("");
  };

  const isRunning=(taskId)=>timers[taskId]?.running;
  const currentElapsed=(taskId)=>timers[taskId]?.elapsed||0;
  const loggedTime=(taskId)=>{const v=timeLogs[taskId];if(!v)return 0;if(typeof v==="number")return v;return v.secs||0;};
  const totalToday=Object.values(timeLogs).reduce((a,v)=>{const s=typeof v==="number"?v:(v?.secs||0);return a+s;},0);

  const editorName=mondayEditors.find(e=>e.id===editorId)?.name||"";

  const toggleExpand=async(parentId)=>{
    if(expanded[parentId]){setExpanded(p=>({...p,[parentId]:false}));return;}
    setExpanded(p=>({...p,[parentId]:true}));
    if(!updates[parentId]){
      setLoadingUpdates(p=>({...p,[parentId]:true}));
      const u=await fetchItemUpdates(parentId);
      setUpdates(p=>({...p,[parentId]:u}));
      setLoadingUpdates(p=>({...p,[parentId]:false}));
    }
  };

  // Filter tasks into today and tomorrow
  const tomorrow=tomorrowKey();
  const isOnDay=(task,day)=>{
    if(task.startDate&&task.endDate)return day>=task.startDate&&day<=task.endDate;
    if(!task.startDate&&!task.endDate)return false;
    return false;
  };
  const todayTasks=tasks.filter(t=>isOnDay(t,today));
  const overdueTasks=tasks.filter(t=>t.endDate&&t.endDate<today&&t.status!=="DONE"&&!isOnDay(t,today));
  const tomorrowTasks=tasks.filter(t=>isOnDay(t,tomorrow)&&!isOnDay(t,today));

  // Sub-tab toggle bar — rendered above whichever sub-tab is active
  // so producers can flip between Monday.com and the Viewix Dashboard
  // without leaving the Editors tab.
  const subTabBar = (
    <div style={{
      padding: "12px 28px", borderBottom: "1px solid var(--border)",
      background: "var(--card)",
      display: "flex", alignItems: "center", gap: 12, flexShrink: 0,
    }}>
      <span style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)" }}>Editors</span>
      <div style={{ display: "flex", gap: 3, background: "var(--bg)", borderRadius: 8, padding: 3, marginLeft: 4 }}>
        <button onClick={() => setSubTab("monday")}
          style={{ padding: "6px 14px", borderRadius: 6, border: "none", background: subTab === "monday" ? "var(--card)" : "transparent", color: subTab === "monday" ? "var(--fg)" : "var(--muted)", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
          Monday.com
        </button>
        <button onClick={() => setSubTab("viewix")}
          style={{ padding: "6px 14px", borderRadius: 6, border: "none", background: subTab === "viewix" ? "var(--card)" : "transparent", color: subTab === "viewix" ? "var(--fg)" : "var(--muted)", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
          Viewix Dashboard
        </button>
      </div>
    </div>
  );

  // Viewix sub-tab — entirely separate component to keep the Monday
  // code path untouched and avoid bloating this file with two parallel
  // dashboards' state and side-effects.
  if (subTab === "viewix") {
    return (
      <div style={{ fontFamily: "'DM Sans',-apple-system,sans-serif", background: embedded ? "transparent" : "var(--bg)", color: "var(--fg)", minHeight: embedded ? "auto" : "100vh" }}>
        {subTabBar}
        <EditorDashboardViewix projects={projects} editors={viewixEditors} clients={clients} />
      </div>
    );
  }

  if(!editorId){
    return(<div style={{minHeight:embedded?"auto":"100vh",background:embedded?"transparent":"var(--bg)",fontFamily:"'DM Sans',-apple-system,sans-serif"}}>
      {subTabBar}
      <div style={{display:"flex",alignItems:embedded?"flex-start":"center",justifyContent:"center",padding:embedded?"24px 28px":0}}>
      <div style={{width:420,padding:"48px 40px",background:"var(--card)",borderRadius:16,border:"1px solid var(--border)",textAlign:"center"}}>
        {!embedded&&<div style={{marginBottom:32,display:"flex",justifyContent:"center"}}><Logo h={36}/></div>}
        <div style={{fontSize:18,fontWeight:700,color:"var(--fg)",marginBottom:6}}>Editor Dashboard</div>
        <div style={{fontSize:13,color:"var(--muted)",marginBottom:28}}>Select your name to see today's tasks</div>
        <div style={{display:"grid",gap:10}}>
          {mondayEditors.map(ed=>(
            <button key={ed.id} onClick={()=>setEditorId(ed.id)}
              style={{padding:"14px 20px",borderRadius:10,border:"1px solid var(--border)",background:"var(--bg)",color:"var(--fg)",fontSize:15,fontWeight:600,cursor:"pointer",transition:"all 0.15s",textAlign:"left",display:"flex",alignItems:"center",gap:12}}>
              <span style={{width:36,height:36,borderRadius:"50%",background:"var(--accent-soft)",color:"var(--accent)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:800}}>{ed.name.split(" ").map(n=>n[0]).join("")}</span>
              {ed.name}
            </button>
          ))}
        </div>
        <button onClick={()=>{setEditorsLoading(true);fetchMondayUsers().then(users=>{if(users&&users.length>0){setMondayEditors(users);fbSet("/mondayEditors",users);}setEditorsLoading(false);}).catch(()=>setEditorsLoading(false));}} style={{marginTop:16,padding:"8px 16px",borderRadius:8,border:"1px solid var(--border)",background:"transparent",color:"var(--muted)",fontSize:11,fontWeight:600,cursor:"pointer",width:"100%"}}>{editorsLoading?"Syncing...":"Sync from Monday.com"}</button>
      </div>
      </div>
    </div>);
  }

  return(<div style={{fontFamily:"'DM Sans',-apple-system,sans-serif",background:embedded?"transparent":"var(--bg)",color:"var(--fg)",minHeight:embedded?"auto":"100vh"}}>
    {subTabBar}
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
        <div style={{display:"flex",gap:3,background:"var(--bg)",borderRadius:8,padding:3}}>
          <button onClick={()=>setViewMode("tasks")} style={{padding:"6px 12px",borderRadius:6,border:"none",background:viewMode==="tasks"?"var(--card)":"transparent",color:viewMode==="tasks"?"var(--fg)":"var(--muted)",fontSize:12,fontWeight:600,cursor:"pointer"}}>Tasks</button>
          <button onClick={()=>setViewMode("timeline")} style={{padding:"6px 12px",borderRadius:6,border:"none",background:viewMode==="timeline"?"var(--card)":"transparent",color:viewMode==="timeline"?"var(--fg)":"var(--muted)",fontSize:12,fontWeight:600,cursor:"pointer"}}>Timeline</button>
        </div>
        <div style={{padding:"8px 16px",borderRadius:8,background:totalToday>0?"rgba(16,185,129,0.12)":"var(--bg)",border:"1px solid var(--border)",minWidth:180}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
            <span style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.05em"}}>Today </span>
            <span style={{fontSize:14,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:totalToday>0?"#10B981":"var(--fg)"}}>{fmtSecsShort(totalToday)} / 8h</span>
          </div>
          <div style={{width:"100%",height:6,background:"var(--bg)",borderRadius:3,overflow:"hidden"}}>
            <div style={{width:`${Math.min((totalToday/(8*3600))*100,100)}%`,height:"100%",background:totalToday>=8*3600?"#F59E0B":"#10B981",borderRadius:3,transition:"width 0.3s"}}/>
          </div>
        </div>
        <button onClick={()=>{setLoading(true);const ed=mondayEditors.find(e=>e.id===editorId);if(ed)fetchEditorTasks(ed.name).then(items=>{setTasks(items);setLoading(false);}).catch(()=>setLoading(false));}} style={{padding:"8px 14px",borderRadius:8,border:"1px solid var(--border)",background:"transparent",color:"var(--muted)",fontSize:12,fontWeight:600,cursor:"pointer"}}>Refresh</button>
        <button onClick={()=>setEditorId(null)} style={{padding:"8px 14px",borderRadius:8,border:"1px solid var(--border)",background:"transparent",color:"var(--muted)",fontSize:12,fontWeight:600,cursor:"pointer"}}>Switch Editor</button>
      </div>
    </div>

    {/* Content */}
    <div style={{maxWidth:viewMode==="timeline"?1200:900,margin:"0 auto",padding:"24px 28px 60px"}}>

    {viewMode==="timeline"&&(()=>{
      const DK2=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
      const getWeekMonday=(d)=>{const x=new Date(d);const day=x.getDay();x.setDate(x.getDate()-day+(day===0?-6:1));x.setHours(0,0,0,0);return x;};
      const startMon=getWeekMonday(new Date());
      const weeks=[];
      for(let w=0;w<4;w++){
        const mon=new Date(startMon);mon.setDate(mon.getDate()+w*7);
        const days=[];
        for(let d=0;d<7;d++){const dt=new Date(mon);dt.setDate(dt.getDate()+d);days.push(dt);}
        weeks.push({mon,days});
      }
      const fmtKey=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
      const fmtShort=d=>d.toLocaleDateString("en-AU",{day:"numeric",month:"short"});
      const todayStr=fmtKey(new Date());

      const stageColors={"Edit":"#0082FA","Shoot":"#F87700","Pre Production":"#8B5CF6","Revisions":"#EF4444","Delivery":"#10B981"};

      return(<div>
        <div style={{fontSize:13,fontWeight:700,color:"var(--fg)",marginBottom:16}}>4 Week Timeline</div>
        {weeks.map((week,wi)=>(
          <div key={wi} style={{marginBottom:16}}>
            <div style={{fontSize:11,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:8}}>Week of {fmtShort(week.mon)}</div>
            <div style={{overflowX:"auto"}}><div style={{display:"grid",gridTemplateColumns:"repeat(7,minmax(140px,1fr))",gap:6,minWidth:1000,alignItems:"start"}}>
              {week.days.map((day,di)=>{
                const key=fmtKey(day);
                const isToday=key===todayStr;
                const isWeekend=di>=5;
                const dayTasks=tasks.filter(t=>{
                  if(!t.startDate&&!t.endDate)return false;
                  if(t.startDate&&t.endDate)return key>=t.startDate&&key<=t.endDate;
                  return false;
                });
                return(
                  <div key={di} style={{background:isToday?"rgba(0,130,250,0.08)":isWeekend?"var(--bg)":"var(--card)",border:`1px solid ${isToday?"var(--accent)":"var(--border)"}`,borderRadius:8,padding:"8px",minHeight:80,overflow:"hidden"}}>
                    <div style={{fontSize:10,fontWeight:700,color:isToday?"var(--accent)":"var(--muted)",marginBottom:6}}>
                      {DK2[di]} {day.getDate()}
                    </div>
                    <div style={{display:"grid",gap:4}}>
                      {dayTasks.map(t=>{
                        const col=stageColors[t.stage]||"var(--accent)";
                        return(
                          <div key={t.id} onClick={()=>{setSelectedTask(t);setSelectedTaskUpdates(null);setSelectedTaskLoading(true);fetchItemUpdates(t.parentInfo?.id||t.id).then(u=>{setSelectedTaskUpdates(u);setSelectedTaskLoading(false);}).catch(()=>setSelectedTaskLoading(false));}} style={{padding:"4px 6px",borderRadius:4,background:`${col}15`,borderLeft:`3px solid ${col}`,fontSize:10,cursor:"pointer",overflow:"hidden"}}>
                            <div style={{fontWeight:600,color:"var(--fg)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.parentName}</div>
                            <div style={{color:"var(--muted)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.name}</div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div></div>
          </div>
        ))}
        {tasks.length===0&&!loading&&<div style={{textAlign:"center",padding:40,color:"var(--muted)"}}>No scheduled tasks found for {editorName}</div>}
      </div>);
    })()}

    {viewMode==="tasks"&&(<>
      <div style={{fontSize:11,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:16}}>
        {new Date().toLocaleDateString("en-AU",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}
      </div>

      {loading?(<div style={{textAlign:"center",padding:60,color:"var(--muted)"}}>Loading tasks from Monday.com...</div>)
      :todayTasks.length===0&&tomorrowTasks.length===0&&overdueTasks.length===0?(<div style={{textAlign:"center",padding:60,color:"var(--muted)"}}><div style={{fontSize:40,marginBottom:12}}>🎬</div><div style={{fontSize:16,fontWeight:600,marginBottom:8}}>No tasks assigned</div><div style={{fontSize:13}}>No tasks found for {editorName} today or tomorrow</div></div>)
      :(<>
        {/* Today's tasks */}
        {todayTasks.length>0&&(<div style={{marginBottom:24}}>
          <div style={{fontSize:13,fontWeight:700,color:"var(--fg)",marginBottom:12}}>Today</div>
          <div style={{display:"grid",gap:12}}>
        {todayTasks.map(task=>{
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
                </div>
              </div>

              {/* Timer */}
              <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:8,minWidth:180}}>
                {running&&(<div style={{fontSize:28,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:"var(--accent)",lineHeight:1}}>{fmtSecs(elapsed)}</div>)}
                {logged>0&&(<div style={{fontSize:12,color:"var(--muted)"}}>Logged today: <span style={{fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:"#10B981"}}>{fmtSecsShort(logged)}</span></div>)}
                <div style={{display:"flex",gap:6}}>
                  {!running?(<button onClick={()=>startTimer(task.id)} style={{padding:"10px 20px",borderRadius:8,border:"none",background:"#10B981",color:"white",fontSize:13,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",gap:6}}>▶ Start</button>)
                  :(<button onClick={()=>stopTimer(task.id)} style={{padding:"10px 20px",borderRadius:8,border:"none",background:"#EF4444",color:"white",fontSize:13,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",gap:6}}>■ Stop</button>)}
                  {logged>0&&!running&&(<button onClick={()=>resetTimer(task.id)} style={{padding:"10px 14px",borderRadius:8,border:"1px solid var(--border)",background:"transparent",color:"var(--muted)",fontSize:11,fontWeight:600,cursor:"pointer"}}>Reset</button>)}
                  {!running&&(<button onClick={()=>{setAdjustingTask(adjustingTask===task.id?null:task.id);setAdjustMins("");}} style={{padding:"10px 14px",borderRadius:8,border:"1px solid var(--border)",background:adjustingTask===task.id?"var(--accent-soft)":"transparent",color:adjustingTask===task.id?"var(--accent)":"var(--muted)",fontSize:11,fontWeight:600,cursor:"pointer"}}>+/- Time</button>)}
                </div>
                {adjustingTask===task.id&&!running&&(<div style={{display:"flex",alignItems:"center",gap:6,marginTop:8}}>
                  <input type="number" value={adjustMins} onChange={e=>setAdjustMins(e.target.value)} placeholder="mins" style={{width:70,padding:"6px 8px",borderRadius:6,border:"1px solid var(--border)",background:"var(--input-bg)",color:"var(--fg)",fontSize:12,outline:"none",fontFamily:"'DM Sans',sans-serif",textAlign:"center"}}/>
                  <button onClick={()=>{const m=parseFloat(adjustMins);if(!isNaN(m)&&m!==0)adjustTime(task.id,m);}} style={{padding:"6px 12px",borderRadius:6,border:"none",background:"#10B981",color:"white",fontSize:11,fontWeight:700,cursor:"pointer"}}>Add</button>
                  <button onClick={()=>{const m=parseFloat(adjustMins);if(!isNaN(m)&&m>0)adjustTime(task.id,-m);}} style={{padding:"6px 12px",borderRadius:6,border:"none",background:"#EF4444",color:"white",fontSize:11,fontWeight:700,cursor:"pointer"}}>Remove</button>
                  <span style={{fontSize:10,color:"var(--muted)"}}>minutes</span>
                </div>)}
              </div>
            </div>
            {/* More Info button */}
            <div style={{marginTop:12,borderTop:"1px solid var(--border)",paddingTop:10,display:"flex",justifyContent:"flex-start"}}>
              <button onClick={()=>toggleExpand(task.parentInfo.id)} style={{fontSize:11,fontWeight:600,color:"var(--accent)",background:"transparent",border:"none",cursor:"pointer",padding:"4px 0",display:"flex",alignItems:"center",gap:4}}>
                {expanded[task.parentInfo.id]?"▾ Hide Info":"▸ More Info"}
              </button>
            </div>
            {/* Expanded info */}
            {expanded[task.parentInfo.id]&&(<div style={{marginTop:8,padding:"16px",background:"var(--bg)",borderRadius:8,fontSize:12}}>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:16}}>
                {task.parentInfo.status&&<div><span style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.04em"}}>Project Status</span><div style={{color:"var(--fg)",fontWeight:600,marginTop:2}}>{task.parentInfo.status}</div></div>}
                {task.parentInfo.stage&&<div><span style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.04em"}}>Project Stage</span><div style={{color:"var(--fg)",fontWeight:600,marginTop:2}}>{task.parentInfo.stage}</div></div>}
                {task.parentInfo.projectDueDate&&<div><span style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.04em"}}>Project Due Date</span><div style={{color:"var(--fg)",fontWeight:600,marginTop:2}}>{task.parentInfo.projectDueDate}</div></div>}
                {task.parentInfo.type&&<div><span style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.04em"}}>Type</span><div style={{color:"var(--fg)",fontWeight:600,marginTop:2}}>{task.parentInfo.type}</div></div>}
              </div>
              {task.parentInfo.taskContent&&(<div style={{marginBottom:16}}>
                <span style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.04em"}}>Task Content</span>
                <div style={{color:"var(--fg)",marginTop:4,lineHeight:1.5,whiteSpace:"pre-wrap"}}>{task.parentInfo.taskContent}</div>
              </div>)}
              {/* Comments/Updates */}
              <div>
                <span style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.04em"}}>Comments</span>
                {loadingUpdates[task.parentInfo.id]?(<div style={{color:"var(--muted)",marginTop:8}}>Loading comments...</div>)
                :updates[task.parentInfo.id]?.length>0?(<div style={{marginTop:8,display:"grid",gap:8}}>
                  {updates[task.parentInfo.id].map(u=>(
                    <div key={u.id} style={{padding:"10px 12px",background:"var(--card)",borderRadius:6,border:"1px solid var(--border)"}}>
                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                        <span style={{fontSize:11,fontWeight:700,color:"var(--accent)"}}>{u.creator?.name||"Unknown"}</span>
                        <span style={{fontSize:10,color:"var(--muted)"}}>{new Date(u.created_at).toLocaleDateString("en-AU",{day:"numeric",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"})}</span>
                      </div>
                      <div style={{fontSize:12,color:"var(--fg)",lineHeight:1.4,whiteSpace:"pre-wrap"}}>{u.text_body||""}</div>
                    </div>
                  ))}
                </div>)
                :(<div style={{color:"var(--muted)",marginTop:8,fontSize:11}}>No comments on this project</div>)}
              </div>
            </div>)}
          </div>);
        })}
          </div>
        </div>)}

        {todayTasks.length===0&&(<div style={{marginBottom:24,padding:"32px 20px",textAlign:"center",color:"var(--muted)",background:"var(--card)",borderRadius:12,border:"1px solid var(--border)"}}><div style={{fontSize:13,fontWeight:600}}>No tasks scheduled for today</div></div>)}

        {/* Tomorrow's tasks */}
        {tomorrowTasks.length>0&&(<div style={{marginBottom:24}}>
          <div style={{fontSize:13,fontWeight:700,color:"var(--muted)",marginBottom:12}}>Tomorrow</div>
          <div style={{display:"grid",gap:8}}>
            {tomorrowTasks.map(task=>{
              const stageColors={"Edit":"#0082FA","Shoot":"#F87700","Pre Production":"#8B5CF6","Revisions":"#EF4444","Delivery":"#10B981"};
              const stageCol=stageColors[task.stage]||"var(--accent)";
              return(<div key={task.id} style={{background:"var(--card)",border:"1px solid var(--border)",borderRadius:10,padding:"14px 20px",opacity:0.7}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div>
                    <div style={{fontSize:10,fontWeight:700,color:"var(--muted)",marginBottom:2,textTransform:"uppercase",letterSpacing:"0.04em"}}>{task.parentName}</div>
                    <div style={{fontSize:13,fontWeight:600,color:"var(--fg)"}}>{task.name}</div>
                  </div>
                  <div style={{display:"flex",gap:6}}>
                    {task.stage&&<span style={{fontSize:10,fontWeight:700,padding:"3px 10px",borderRadius:4,background:`${stageCol}20`,color:stageCol,textTransform:"uppercase"}}>{task.stage}</span>}
                    {task.status&&<span style={{fontSize:10,fontWeight:700,padding:"3px 10px",borderRadius:4,background:"var(--bg)",color:"var(--muted)",textTransform:"uppercase"}}>{task.status}</span>}
                  </div>
                </div>
              </div>);
            })}
          </div>
        </div>)}

        {/* Overdue tasks */}
        {overdueTasks.length>0&&(<div style={{marginBottom:24}}>
          <div style={{fontSize:13,fontWeight:700,color:"#EF4444",marginBottom:12}}>Overdue ({overdueTasks.length})</div>
          <div style={{display:"grid",gap:8}}>
            {overdueTasks.map(task=>{
              const stageColors={"Edit":"#0082FA","Shoot":"#F87700","Pre Production":"#8B5CF6","Revisions":"#EF4444","Delivery":"#10B981"};
              const stageCol=stageColors[task.stage]||"var(--accent)";
              return(<div key={task.id} style={{background:"var(--card)",border:"1px solid rgba(239,68,68,0.3)",borderRadius:10,padding:"14px 20px",opacity:0.7}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div>
                    <div style={{fontSize:10,fontWeight:700,color:"var(--muted)",marginBottom:2,textTransform:"uppercase",letterSpacing:"0.04em"}}>{task.parentName}</div>
                    <div style={{fontSize:13,fontWeight:600,color:"var(--fg)"}}>{task.name}</div>
                  </div>
                  <div style={{display:"flex",gap:6}}>
                    {task.stage&&<span style={{fontSize:10,fontWeight:700,padding:"3px 10px",borderRadius:4,background:`${stageCol}20`,color:stageCol,textTransform:"uppercase"}}>{task.stage}</span>}
                    {task.status&&<span style={{fontSize:10,fontWeight:700,padding:"3px 10px",borderRadius:4,background:"rgba(239,68,68,0.12)",color:"#EF4444",textTransform:"uppercase"}}>{task.status}</span>}
                    {task.timeline&&<span style={{fontSize:10,fontWeight:600,padding:"3px 10px",borderRadius:4,background:"var(--bg)",color:"var(--muted)"}}>{task.timeline}</span>}
                  </div>
                </div>
              </div>);
            })}
          </div>
        </div>)}
      </>)}

      {/* Daily Summary */}
      {totalToday>0&&(<div style={{marginTop:24,background:"var(--card)",border:"1px solid var(--border)",borderRadius:12,padding:"20px 24px"}}>
        <div style={{fontSize:13,fontWeight:700,color:"var(--fg)",marginBottom:12}}>Today's Summary</div>
        <div style={{display:"grid",gap:6}}>
          {todayTasks.filter(t=>loggedTime(t.id)>0).map(t=>(
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
    </>)}

    {/* Task Detail Modal */}
    {selectedTask&&(
      <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.6)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200}} onClick={()=>setSelectedTask(null)}>
        <div onClick={e=>e.stopPropagation()} style={{background:"var(--card)",border:"1px solid var(--border)",borderRadius:16,padding:"28px",width:560,maxHeight:"80vh",overflow:"auto",boxShadow:"0 20px 60px rgba(0,0,0,0.5)"}}>
          {/* Header */}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20}}>
            <div>
              <div style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:4}}>{selectedTask.parentName}</div>
              <div style={{fontSize:18,fontWeight:800,color:"var(--fg)"}}>{selectedTask.name}</div>
            </div>
            <button onClick={()=>setSelectedTask(null)} style={{background:"none",border:"none",color:"var(--muted)",fontSize:20,cursor:"pointer",padding:"4px 8px"}}>x</button>
          </div>

          {/* Subtask Details */}
          <div style={{marginBottom:20}}>
            <div style={{fontSize:11,fontWeight:700,color:"var(--accent)",textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:10}}>Subtask Details</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
              {[
                {l:"Status",v:selectedTask.status||"N/A"},
                {l:"Stage",v:selectedTask.stage||"N/A"},
                {l:"Timeline",v:selectedTask.timeline||"N/A"},
                {l:"Assigned To",v:selectedTask.people||"N/A"},
                {l:"Start Date",v:selectedTask.startDate||"N/A"},
                {l:"End Date",v:selectedTask.endDate||"N/A"},
                {l:"Start Time",v:selectedTask.startTime||"N/A"},
                {l:"End Time",v:selectedTask.endTime||"N/A"},
              ].filter(f=>f.v&&f.v!=="N/A"&&f.v!=="").map((f,i)=>(
                <div key={i} style={{padding:"8px 12px",background:"var(--bg)",borderRadius:8}}>
                  <div style={{fontSize:9,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",marginBottom:3}}>{f.l}</div>
                  <div style={{fontSize:13,fontWeight:600,color:"var(--fg)"}}>{f.v}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Parent Task Details */}
          {selectedTask.parentInfo&&(
            <div style={{marginBottom:20}}>
              <div style={{fontSize:11,fontWeight:700,color:"#F87700",textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:10}}>Parent Task</div>
              {selectedTask.parentInfo.taskContent&&(
                <div style={{marginBottom:10,padding:"12px 14px",background:"var(--bg)",borderRadius:8,border:"1px solid var(--border)"}}>
                  <div style={{fontSize:9,fontWeight:700,color:"#F87700",textTransform:"uppercase",marginBottom:4}}>Task Content</div>
                  <div style={{fontSize:13,color:"var(--fg)",lineHeight:1.6}}>{selectedTask.parentInfo.taskContent}</div>
                </div>
              )}
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                {[
                  {l:"Project",v:selectedTask.parentName||"N/A"},
                  {l:"Type",v:selectedTask.parentInfo.type||"N/A"},
                  {l:"Project Status",v:selectedTask.parentInfo.status||"N/A"},
                  {l:"Stage",v:selectedTask.parentInfo.stage||"N/A"},
                  {l:"Due Date",v:selectedTask.parentInfo.dueDate||"N/A"},
                  {l:"Project Due Date",v:selectedTask.parentInfo.projectDueDate||"N/A"},
                ].filter(f=>f.v&&f.v!=="N/A"&&f.v!=="").map((f,i)=>(
                  <div key={i} style={{padding:"8px 12px",background:"var(--bg)",borderRadius:8}}>
                    <div style={{fontSize:9,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",marginBottom:3}}>{f.l}</div>
                    <div style={{fontSize:13,fontWeight:600,color:"var(--fg)"}}>{f.v}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Updates/Comments */}
          <div>
            <div style={{fontSize:11,fontWeight:700,color:"#10B981",textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:10}}>Recent Updates</div>
            {selectedTaskLoading?<div style={{padding:16,textAlign:"center",color:"var(--muted)",fontSize:12}}>Loading updates...</div>
            :selectedTaskUpdates&&selectedTaskUpdates.length>0?(
              <div style={{display:"grid",gap:8}}>
                {selectedTaskUpdates.slice(0,5).map((u,i)=>(
                  <div key={u.id||i} style={{padding:"10px 12px",background:"var(--bg)",borderRadius:8}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                      <span style={{fontSize:11,fontWeight:700,color:"var(--fg)"}}>{u.creator?.name||"Unknown"}</span>
                      <span style={{fontSize:10,color:"var(--muted)"}}>{u.created_at?new Date(u.created_at).toLocaleDateString("en-AU",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}):""}</span>
                    </div>
                    <div style={{fontSize:12,color:"var(--muted)",lineHeight:1.5}}>{u.text_body||u.body||""}</div>
                  </div>
                ))}
              </div>
            ):<div style={{padding:16,textAlign:"center",color:"var(--muted)",fontSize:12,background:"var(--bg)",borderRadius:8}}>No updates found</div>}
          </div>
        </div>
      </div>
    )}

    {/* Timer Switch Warning Modal */}
    {timerWarning&&(
      <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.6)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:300}} onClick={()=>setTimerWarning(null)}>
        <div onClick={e=>e.stopPropagation()} style={{background:"var(--card)",border:"1px solid var(--border)",borderRadius:16,padding:"28px",width:420,boxShadow:"0 20px 60px rgba(0,0,0,0.5)"}}>
          <div style={{fontSize:16,fontWeight:800,color:"var(--fg)",marginBottom:12}}>Timer Already Running</div>
          <div style={{fontSize:13,color:"var(--muted)",marginBottom:20,lineHeight:1.5}}>
            You have a timer running on <span style={{fontWeight:700,color:"var(--fg)"}}>{timerWarning.runningTaskName}</span>. Do you want to stop it and start the new timer?
          </div>
          <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
            <button onClick={()=>setTimerWarning(null)} style={{padding:"10px 20px",borderRadius:8,border:"1px solid var(--border)",background:"transparent",color:"var(--muted)",fontSize:13,fontWeight:600,cursor:"pointer"}}>Cancel</button>
            <button onClick={confirmTimerSwitch} style={{padding:"10px 20px",borderRadius:8,border:"none",background:"#0082FA",color:"white",fontSize:13,fontWeight:700,cursor:"pointer"}}>Stop & Start</button>
          </div>
        </div>
      </div>
    )}
    </div>
  </div>);
}
