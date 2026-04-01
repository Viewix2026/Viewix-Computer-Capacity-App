import { useState, useEffect, useRef } from "react";
import { DK, DL, TH, TD, BTN } from "../config";
import { fmtD, dayDates, dayVal, nextState } from "../utils";
import { fbSet } from "../firebase";
import { UBar } from "./UIComponents";

export function Grid({wk,weekData,onUpdate,masterEds,inputs,onUpdateSuites}){
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
  const saveNote=()=>{if(!noteEdit)return;const txt=noteText.trim();const updated=eds.map(e=>{if(e.id!==noteEdit.editorId)return e;const newNotes={...e.notes};if(txt){newNotes[noteEdit.day]=txt;}else{newNotes[noteEdit.day]=null;}return{...e,notes:newNotes};});sv({editors:updated});fbSet(`/weekData/${wk}`,{...data,editors:updated});setNoteEdit(null);setNoteText("");};
  const clearNote=()=>{if(!noteEdit)return;const updated=eds.map(e=>{if(e.id!==noteEdit.editorId)return e;const newNotes={...e.notes};newNotes[noteEdit.day]=null;return{...e,notes:newNotes};});sv({editors:updated});fbSet(`/weekData/${wk}`,{...data,editors:updated});setNoteEdit(null);setNoteText("");};

  // Only "in" counts as occupying a suite. "shoot" = working but no suite.
  const occPerDay=DK.map(d=>eds.filter(e=>dayVal(e.days[d])==="in").length);
  const avPerDay=occPerDay.map(o=>inputs.totalSuites-o);
  const totalOcc=occPerDay.reduce((a,b)=>a+b,0);const totalAv=avPerDay.reduce((a,b)=>a+b,0);const maxSD=inputs.totalSuites*5;
  const occCol=o=>{if(o>inputs.totalSuites)return"#F472B6";const r=o/inputs.totalSuites;if(r>=1)return"#10B981";if(r>=0.7)return"#EAB308";if(r>=0.5)return"#F59E0B";return"#EF4444";};
  useEffect(()=>{if(adding&&addRef.current)addRef.current.focus();},[adding]);
  useEffect(()=>{if(editingId&&editRef.current)editRef.current.focus();},[editingId]);
  useEffect(()=>{if(noteEdit&&noteRef.current)noteRef.current.focus();},[noteEdit]);

  const cellStyle=(ed,day)=>{
    const v=dayVal(ed.days[day]);const hasNote=ed.notes?.[day]!=null&&ed.notes[day]!=="";
    if(v==="in")return{background:hasNote?"rgba(0,130,250,0.22)":"var(--accent-soft)",color:"var(--accent)"};
    if(v==="shoot")return{background:hasNote?"rgba(248,119,0,0.22)":"rgba(248,119,0,0.12)",color:"#F87700"};
    return{background:"transparent",color:"#3A4558"};
  };
  const cellLabel=v=>{if(v==="in")return"IN";if(v==="shoot")return"SHOOT";return"-";};

  return(<div><div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"separate",borderSpacing:0,fontSize:13}}>
    <thead><tr><th style={{...TH,width:150,textAlign:"left"}}>Editor</th>{DK.map((_,i)=>(<th key={i} style={{...TH,textAlign:"center",minWidth:90}}><div>{DL[i]}</div><div style={{fontSize:11,fontWeight:600,color:"var(--accent)",marginTop:2}}>{fmtD(dd[i])}</div></th>))}<th style={{...TH,width:55,textAlign:"center"}}>Days</th><th style={{...TH,width:40}}></th></tr></thead>
    <tbody>{eds.map(ed=>{const dn=DK.filter(d=>dayVal(ed.days[d])!=="off").length;const isE=editingId===ed.id;return(<tr key={ed.id}>
      <td style={{...TD,fontWeight:700,color:"var(--fg)",cursor:"pointer"}} onClick={()=>{if(!isE)startEdit(ed);}}>{isE?(<input ref={editRef} type="text" value={editName} onChange={e=>setEditName(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")doRename();if(e.key==="Escape")setEditingId(null);}} onBlur={doRename} style={{width:"100%",padding:"3px 6px",borderRadius:4,border:"1px solid var(--accent)",background:"var(--input-bg)",color:"var(--fg)",fontSize:13,fontWeight:700,outline:"none"}}/>):(<span style={{borderBottom:"1px dashed #3A4558"}} title="Click to rename">{ed.name}</span>)}</td>
      {DK.map(day=>{const v=dayVal(ed.days[day]);const cs=cellStyle(ed,day);const hasNote=ed.notes?.[day]!=null&&ed.notes[day]!=="";return(
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
        <button onClick={clearNote} style={{...BTN,background:"#374151",color:"#EF4444"}}>Clear Note</button>
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


