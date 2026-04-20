import { useState, useEffect, useRef } from "react";
import { VIEWIX_STATUSES, VIEWIX_STATUS_COLORS, CLIENT_REVISION_OPTIONS, CLIENT_REVISION_COLORS } from "../config";
import { initFB, onFB, fbSet, fbListen, signInAnonymouslyForPublic } from "../firebase";
import { StatusSelect } from "./UIComponents";
import { Logo } from "./Logo";
import { logoBg } from "../utils";

export function DeliveryPublicView(){
  const[delivery,setDelivery]=useState(null);
  const[loading,setLoading]=useState(true);
  const[saving,setSaving]=useState(false);
  const[showInstructions,setShowInstructions]=useState(true);
  const[accountLogo,setAccountLogo]=useState(null);
  const[accountLogoBg,setAccountLogoBg]=useState("white");
  // Support both pretty paths (/d/HASH/slug) and legacy ?d=ID
  const deliveryId=new URLSearchParams(window.location.search).get("d");
  const prettyMatch=window.location.pathname.match(/^\/d\/([a-z0-9]{4,12})/i);
  const shortId=prettyMatch?prettyMatch[1].toLowerCase():null;
  const pendingChanges=useRef([]);
  const batchTimer=useRef(null);

  const[notFoundReason,setNotFoundReason]=useState(null);
  useEffect(()=>{
    if(!deliveryId&&!shortId)return;
    document.title="Viewix Dashboard";
    initFB();
    let unsub=()=>{};
    onFB(async()=>{
      try{await signInAnonymouslyForPublic();}
      catch(e){console.warn("Anonymous auth failed, continuing:",e.message);}
      if(deliveryId){
        unsub=fbListen(`/deliveries/${deliveryId}`,(data)=>{
          if(data){setDelivery(data);setNotFoundReason(null);}
          else{setNotFoundReason(`No delivery record at /deliveries/${deliveryId}. It may have been deleted or renamed.`);}
          setLoading(false);
        });
      }else if(shortId){
        unsub=fbListen("/deliveries",(allDeliveries)=>{
          if(!allDeliveries){
            setNotFoundReason(`The /deliveries collection came back empty — Firebase security rules may be blocking anonymous reads, or there are simply no deliveries yet.`);
            setLoading(false);
            return;
          }
          const match=Object.values(allDeliveries).find(d=>d&&d.shortId&&d.shortId.toLowerCase()===shortId);
          if(match){setDelivery(match);setNotFoundReason(null);}
          else{
            const total=Object.values(allDeliveries).filter(d=>d&&d.id).length;
            setNotFoundReason(`Checked ${total} deliveries — none have shortId "${shortId}". The link may be stale or the record was deleted.`);
          }
          setLoading(false);
        });
      }
    });
    return ()=>unsub();
  },[deliveryId,shortId]);

  // Resolve account logo when delivery or accounts change. Same cleanup
  // pattern — leaving this listener attached on clientName change would
  // stack N listeners across the life of the page.
  useEffect(()=>{
    if(!delivery?.clientName)return;
    let unsub=()=>{};
    onFB(()=>{
      unsub=fbListen("/accounts",(acctData)=>{
        if(!acctData)return;
        const nameLC=delivery.clientName.toLowerCase();
        const match=Object.values(acctData).find(a=>a&&(a.companyName||"").toLowerCase()===nameLC);
        setAccountLogo(match?.logoUrl||null);
        setAccountLogoBg(match?.logoBg||"white");
      });
    });
    return ()=>unsub();
  },[delivery?.clientName]);

  const flushNotifications=()=>{
    if(pendingChanges.current.length===0)return;
    const changes=[...pendingChanges.current];
    pendingChanges.current=[];
    const clientName=delivery?.clientName||"Unknown Client";
    fetch("/api/notify-revision",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({clientName,deliveryId:delivery?.id||deliveryId,changes})}).catch(e=>console.error("Notification error:",e));
  };

  const updateField=(videoId,field,value)=>{
    if(!delivery)return;
    const video=delivery.videos.find(v=>v.id===videoId);
    const updated={...delivery,videos:delivery.videos.map(v=>v.id===videoId?{...v,[field]:value}:v)};
    setDelivery(updated);
    setSaving(true);
    fbSet(`/deliveries/${delivery.id}`,updated);
    setTimeout(()=>setSaving(false),800);
    if(field==="revision1"||field==="revision2"){
      pendingChanges.current.push({videoName:video?.name||"Video",field,oldValue:video?.[field]||"",newValue:value});
      if(batchTimer.current)clearTimeout(batchTimer.current);
      batchTimer.current=setTimeout(flushNotifications,120000);
    }
  };

  if(loading)return(<div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#0B0F1A",fontFamily:"'DM Sans',-apple-system,sans-serif"}}><div style={{color:"#5A6B85",fontSize:14}}>Loading...</div></div>);
  if(!delivery)return(
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#0B0F1A",fontFamily:"'DM Sans',-apple-system,sans-serif",padding:20}}>
      <div style={{maxWidth:480,textAlign:"center"}}>
        <div style={{fontSize:48,marginBottom:16}}>🔗</div>
        <div style={{color:"#E8ECF4",fontSize:18,fontWeight:700,marginBottom:10}}>This delivery link is broken</div>
        {notFoundReason&&<div style={{color:"#5A6B85",fontSize:13,lineHeight:1.6,marginBottom:20}}>{notFoundReason}</div>}
        <div style={{color:"#5A6B85",fontSize:12,lineHeight:1.6}}>
          Please ask Viewix for a fresh link, or have a producer copy the new share URL from the Projects → Deliveries tab.
        </div>
      </div>
    </div>
  );

  const readyCount=delivery.videos.filter(v=>v.viewixStatus==="Ready for Review"||v.viewixStatus==="Completed").length;
  const totalCount=delivery.videos.length;
  const editableBorder="1px solid #0082FA";
  const editableBg="rgba(0,130,250,0.06)";

  return(<div style={{minHeight:"100vh",background:"#0B0F1A",fontFamily:"'DM Sans',-apple-system,sans-serif",color:"#E8ECF4"}}>
    <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,100..1000;1,9..40,100..1000&family=JetBrains+Mono:wght@400;600;700;800&display=swap');*{box-sizing:border-box;margin:0;padding:0;}::-webkit-scrollbar{width:6px;height:6px;}::-webkit-scrollbar-track{background:#0B0F1A;}::-webkit-scrollbar-thumb{background:#1E2A3A;border-radius:3px;}`}</style>
    {/* Header */}
    <div style={{padding:"24px 40px",borderBottom:"1px solid #1E2A3A",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
      <div style={{display:"flex",alignItems:"center",gap:16}}>
        {(()=>{const s=accountLogo||delivery.logoUrl;const bg=logoBg(accountLogoBg);return s?<img key={s+bg} src={s} alt="" onError={e=>{e.target.style.display="none";}} style={{height:40,borderRadius:6,objectFit:"contain",background:bg,padding:4}}/>:null;})()}
        <div>
          <div style={{fontSize:18,fontWeight:800,color:"#E8ECF4"}}>{delivery.projectName}</div>
          <div style={{fontSize:13,color:"#5A6B85"}}>{delivery.clientName}</div>
        </div>
      </div>
      <div style={{display:"flex",alignItems:"center",gap:12}}>
        {saving&&<span style={{fontSize:11,color:"#10B981",fontWeight:600}}>Saved</span>}
        <div style={{fontSize:12,color:"#5A6B85"}}>{readyCount}/{totalCount} ready</div>
        <Logo h={20}/>
      </div>
    </div>

    {/* Content */}
    <div style={{maxWidth:1100,margin:"0 auto",padding:"32px 40px"}}>

      {/* Instructions */}
      <div style={{marginBottom:24,background:"#131825",border:"1px solid #1E2A3A",borderRadius:12,overflow:"hidden"}}>
        <button onClick={()=>setShowInstructions(!showInstructions)} style={{width:"100%",padding:"14px 20px",background:"transparent",border:"none",color:"#E8ECF4",fontSize:13,fontWeight:700,cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span>How to use this page</span>
          <span style={{color:"#5A6B85"}}>{showInstructions?"▾":"▸"}</span>
        </button>
        {showInstructions&&(<div style={{padding:"0 20px 20px",fontSize:13,color:"#8899AB",lineHeight:1.7}}>
          <div style={{display:"grid",gap:12}}>
            <div style={{display:"flex",gap:10}}><span style={{color:"#0082FA",fontWeight:800,fontSize:14,minWidth:20}}>1.</span><span>Every time a new video is ready for review, it will be added into this table and the Viewix Status will change to <span style={{color:"#0082FA",fontWeight:600}}>"Ready for Review"</span>.</span></div>
            <div style={{display:"flex",gap:10}}><span style={{color:"#0082FA",fontWeight:800,fontSize:14,minWidth:20}}>2.</span><span>Once you have reviewed the video, please update the relevant <span style={{color:"#0082FA",fontWeight:600}}>Revision Round Status</span> to either <span style={{color:"#10B981",fontWeight:600}}>"Approved"</span> or <span style={{color:"#EF4444",fontWeight:600}}>"Needs Revisions"</span>.</span></div>
            <div style={{display:"flex",gap:10}}><span style={{color:"#0082FA",fontWeight:800,fontSize:14,minWidth:20}}>3.</span><span>If a video needs revision, the Viewix Status will change to "Need Revisions". Once our changes are implemented, the status will update to "Ready for Review".</span></div>
            <div style={{display:"flex",gap:10}}><span style={{color:"#0082FA",fontWeight:800,fontSize:14,minWidth:20}}>4.</span><span>Please add all notes and feedback directly into <span style={{color:"#0082FA",fontWeight:600}}>Frame.io</span>. This keeps a clear audit trail for all changes. To add comments, simply add a note into the comment box and the system will automatically time stamp it.</span></div>
          </div>
          <div style={{marginTop:16,padding:"10px 14px",background:"rgba(0,130,250,0.08)",borderRadius:8,border:"1px solid rgba(0,130,250,0.2)",fontSize:12,color:"#0082FA",fontWeight:600}}>There are 2 rounds of included revisions for every video.</div>
        </div>)}
      </div>

      {/* Editable fields legend */}
      <div style={{marginBottom:16,display:"flex",alignItems:"center",gap:8}}>
        <div style={{width:12,height:12,borderRadius:3,border:editableBorder,background:editableBg}}/>
        <span style={{fontSize:11,color:"#5A6B85"}}>Fields with a blue border can be edited by you</span>
      </div>

      {/* Video table */}
      {delivery.videos.length===0?(<div style={{textAlign:"center",padding:60,color:"#5A6B85"}}><div style={{fontSize:16,fontWeight:600}}>No videos yet</div></div>)
      :(<div style={{overflowX:"auto",background:"#131825",borderRadius:12,border:"1px solid #1E2A3A"}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
        <thead><tr>
          <th style={{padding:"12px 14px",fontSize:10,fontWeight:700,color:"#5A6B85",letterSpacing:"0.06em",textTransform:"uppercase",borderBottom:"2px solid #1E2A3A",textAlign:"left"}}>Video Name</th>
          <th style={{padding:"12px 14px",fontSize:10,fontWeight:700,color:"#5A6B85",letterSpacing:"0.06em",textTransform:"uppercase",borderBottom:"2px solid #1E2A3A",textAlign:"left"}}>Link</th>
          <th style={{padding:"12px 14px",fontSize:10,fontWeight:700,color:"#5A6B85",letterSpacing:"0.06em",textTransform:"uppercase",borderBottom:"2px solid #1E2A3A",textAlign:"center",minWidth:130}}>Viewix Status</th>
          <th style={{padding:"12px 14px",fontSize:10,fontWeight:700,color:"#0082FA",letterSpacing:"0.06em",textTransform:"uppercase",borderBottom:"2px solid #1E2A3A",textAlign:"center",background:"rgba(0,130,250,0.04)"}}>Revision Round 1 ✎</th>
          <th style={{padding:"12px 14px",fontSize:10,fontWeight:700,color:"#0082FA",letterSpacing:"0.06em",textTransform:"uppercase",borderBottom:"2px solid #1E2A3A",textAlign:"center",background:"rgba(0,130,250,0.04)"}}>Revision Round 2 ✎</th>
        </tr></thead>
        <tbody>{delivery.videos.map(v=>{
          const sc=VIEWIX_STATUS_COLORS[v.viewixStatus]||"#5A6B85";
          return(<tr key={v.id}>
            <td style={{padding:"12px 14px",borderBottom:"1px solid #1E2A3A",fontWeight:600,color:"#E8ECF4"}}>{v.name}</td>
            <td style={{padding:"12px 14px",borderBottom:"1px solid #1E2A3A"}}>{v.link?<a href={v.link} target="_blank" rel="noopener noreferrer" style={{color:"#0082FA",textDecoration:"none",fontWeight:600}}>View ↗</a>:<span style={{color:"#5A6B85"}}>—</span>}</td>
            <td style={{padding:"12px 14px",borderBottom:"1px solid #1E2A3A",textAlign:"center"}}><span style={{padding:"5px 12px",borderRadius:4,background:`${sc}20`,color:sc,fontSize:11,fontWeight:700,textTransform:"uppercase",whiteSpace:"nowrap"}}>{v.viewixStatus}</span></td>
            <td style={{padding:"8px 10px",borderBottom:"1px solid #1E2A3A",textAlign:"center",background:"rgba(0,130,250,0.04)"}}><div style={{border:editableBorder,borderRadius:6,padding:"4px",background:editableBg}}><StatusSelect value={v.revision1} options={CLIENT_REVISION_OPTIONS} colors={CLIENT_REVISION_COLORS} onChange={val=>updateField(v.id,"revision1",val)}/></div></td>
            <td style={{padding:"8px 10px",borderBottom:"1px solid #1E2A3A",textAlign:"center",background:"rgba(0,130,250,0.04)"}}><div style={{border:editableBorder,borderRadius:6,padding:"4px",background:editableBg}}><StatusSelect value={v.revision2} options={CLIENT_REVISION_OPTIONS} colors={CLIENT_REVISION_COLORS} onChange={val=>updateField(v.id,"revision2",val)}/></div></td>
          </tr>);})}
        </tbody>
      </table></div>)}

      <div style={{marginTop:40,textAlign:"center",color:"#3A4558",fontSize:11}}>
        Powered by <span style={{color:"#0082FA",fontWeight:700}}>Viewix</span>
      </div>
    </div>
  </div>);
}
