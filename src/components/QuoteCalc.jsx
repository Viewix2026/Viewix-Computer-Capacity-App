import { useState } from "react";
import { QUOTE_SECTIONS, OUTPUT_PRESETS, FILMING_DEFAULTS, EDITING_DEFAULTS, NB, BTN, TH } from "../config";
import { fmtCur, pct } from "../utils";

export function newQuote(clientName){
  return {
    id:`q-${Date.now()}`,clientName:clientName||"New Quote",status:"draft",createdAt:new Date().toISOString(),
    items:QUOTE_SECTIONS.flatMap(s=>s.items.map(it=>({...it,section:s.id,sectionName:s.name,hours:0,rateOverride:null}))),
    customItems:[],margin:0.4,sellPrice:null,sellPriceMode:false,
    filmingBullets:[...FILMING_DEFAULTS],editingBullets:[...EDITING_DEFAULTS],
    outputs:[...OUTPUT_PRESETS],locked:false,
  };
}

export function QuoteCalc({quote,onUpdate,onBack,rateCards}){
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
    const patch={items:updated,clientName:rc.name};
    if(rc.zeroMargin){patch.margin=0;patch.sellPriceMode=false;patch.sellPrice=null;}
    setQ(patch);
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

  // Margin calc: two modes (markup style - matches Google Sheet)
  let sellExGST,margin;
  if(q.sellPriceMode&&q.sellPrice!=null){
    sellExGST=q.sellPrice;
    margin=totalCost>0?(sellExGST-totalCost)/totalCost:0;
  } else {
    margin=q.margin||0;
    sellExGST=totalCost>0?totalCost*(1+margin):0;
  }
  sellExGST+=totalCustomMarkup;
  const sellIncGST=sellExGST*1.1;
  const profit=sellExGST-totalCost;
  const profitAfterTax=profit*0.75;

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
      {(rateCards||[]).map(rc=>(<button key={rc.id} onClick={()=>applyRateCard(rc)} style={{...BTN,background:rc.zeroMargin?"rgba(16,185,129,0.12)":"var(--bg)",color:rc.zeroMargin?"#10B981":"var(--fg)",border:`1px solid ${rc.zeroMargin?"#10B981":"var(--border)"}`}}>{rc.name}{rc.zeroMargin?" ✓":""}</button>))}
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
        <div><div style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",marginBottom:4}}>After Tax (25%)</div><div style={{fontSize:18,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:"var(--fg)"}}>{fmtCur(profitAfterTax)}</div></div>
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
