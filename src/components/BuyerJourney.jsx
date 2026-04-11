import { useState } from "react";
import { BTN } from "../config";

export function BuyerJourney({data,onChange}){
  const[sel,setSel]=useState(null);
  const{grid,rows,cols}=data;
  const safeGrid=grid.length>0?grid:Array.from({length:rows},()=>Array.from({length:cols},()=>({})));
  const arrows="→←↑↓↘↗↙↖";
  const isArrowCell=c=>c&&c.a&&arrows.indexOf(c.a)>=0;
  const isTextCell=c=>c&&("t" in c);
  const updateGrid=(g)=>onChange({...data,grid:g});
  const setCell=(r,c,val)=>{const g=safeGrid.map(row=>[...row]);g[r][c]=val;updateGrid(g);};
  const addCol=()=>{const g=safeGrid.map(row=>[...row,{}]);onChange({...data,grid:g,cols:cols+1});};
  const addRow=()=>{const g=[...safeGrid,Array.from({length:cols},()=>({}))];onChange({...data,grid:g,rows:rows+1});};
  const remCol=()=>{if(cols<=2)return;const g=safeGrid.map(row=>row.slice(0,-1));onChange({...data,grid:g,cols:cols-1});};
  const remRow=()=>{if(rows<=2)return;const g=safeGrid.slice(0,-1);onChange({...data,grid:g,rows:rows-1});};
  const colHead=i=>String.fromCharCode(65+i);
  const isSel=(r,c)=>sel&&sel.r===r&&sel.c===c;
  const cellBorder=(r,c)=>isSel(r,c)?"2px solid var(--accent)":"1px solid var(--border)";
  const inputSt={width:"100%",background:"transparent",border:"none",outline:"none",fontFamily:"'DM Sans',sans-serif"};

  return(<>
    <div style={{padding:"12px 28px",borderBottom:"1px solid var(--border)",display:"flex",alignItems:"center",justifyContent:"space-between",background:"var(--card)"}}>
      <span style={{fontSize:15,fontWeight:700,color:"var(--fg)"}}>Buyer Journey</span>
      <div style={{display:"flex",gap:6}}>
        <button onClick={addCol} style={{...BTN,background:"transparent",color:"var(--muted)",border:"1px solid var(--border)"}}>+ Column</button>
        <button onClick={addRow} style={{...BTN,background:"transparent",color:"var(--muted)",border:"1px solid var(--border)"}}>+ Row</button>
        <button onClick={remCol} style={{...BTN,background:"transparent",color:"var(--muted)",border:"1px solid var(--border)"}}>- Column</button>
        <button onClick={remRow} style={{...BTN,background:"transparent",color:"var(--muted)",border:"1px solid var(--border)"}}>- Row</button>
      </div>
    </div>
    <div style={{padding:"16px 28px 60px",overflow:"auto"}}>
      <table style={{borderCollapse:"separate",borderSpacing:4,width:"max-content"}}>
        <thead><tr><td/>{Array.from({length:cols},(_,c)=>(<td key={c} style={{padding:"6px 8px",fontSize:10,fontWeight:700,color:"var(--muted)",textAlign:"center",letterSpacing:"0.05em",fontFamily:"'JetBrains Mono',monospace",minWidth:150}}>{colHead(c)}</td>))}</tr></thead>
        <tbody>{safeGrid.map((row,r)=>(<tr key={r}>
          <td style={{padding:"6px 8px",fontSize:10,fontWeight:700,color:"var(--muted)",textAlign:"center",fontFamily:"'JetBrains Mono',monospace"}}>{r+1}</td>
          {row.map((cell,c)=>{
            if(isArrowCell(cell)){
              return(<td key={c} onClick={()=>setSel({r,c})} style={{minWidth:150,minHeight:60,borderRadius:8,border:cellBorder(r,c),background:"transparent",cursor:"pointer",textAlign:"center",verticalAlign:"middle",padding:0}}>
                <div style={{fontSize:22,color:"var(--accent)",fontWeight:700,lineHeight:"60px"}}>{cell.a}</div>
              </td>);
            }
            if(isTextCell(cell)){
              return(<td key={c} onClick={()=>setSel({r,c})} style={{minWidth:150,minHeight:60,borderRadius:8,border:cellBorder(r,c),background:"var(--card)",cursor:"pointer",verticalAlign:"top",padding:0}}>
                <input value={cell.t||""} onChange={e=>setCell(r,c,{...cell,t:e.target.value})} onFocus={()=>setSel({r,c})} placeholder="Title" style={{...inputSt,padding:"8px 10px 2px",color:"var(--fg)",fontSize:13,fontWeight:700}}/>
                <textarea value={cell.d||""} onChange={e=>setCell(r,c,{...cell,d:e.target.value})} onFocus={()=>setSel({r,c})} placeholder="Description" rows={2} style={{...inputSt,padding:"2px 10px 8px",color:"var(--muted)",fontSize:11,resize:"none",lineHeight:1.4}}/>
              </td>);
            }
            return(<td key={c} onClick={()=>setSel({r,c})} style={{minWidth:150,minHeight:60,borderRadius:8,border:isSel(r,c)?"2px solid var(--accent)":"1px solid transparent",background:"transparent",cursor:"pointer",textAlign:"center",verticalAlign:"middle",padding:0}}>
              {isSel(r,c)&&<div style={{fontSize:11,color:"var(--muted)",padding:"20px 8px",userSelect:"none"}}>+</div>}
            </td>);
          })}
        </tr>))}</tbody>
      </table>
      {/* Toolbar */}
      <div style={{display:"flex",gap:6,marginTop:14,alignItems:"center",flexWrap:"wrap"}}>
        <span style={{fontSize:11,fontWeight:600,color:"var(--muted)"}}>Insert:</span>
        {arrows.split("").map(a=>(<button key={a} onClick={()=>{if(!sel)return;setCell(sel.r,sel.c,{a});}} style={{width:32,height:32,borderRadius:6,border:"1px solid var(--border)",background:"var(--card)",color:"var(--accent)",fontSize:16,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>{a}</button>))}
        <div style={{width:1,height:20,background:"var(--border)",margin:"0 4px"}}/>
        <button onClick={()=>{if(!sel)return;setCell(sel.r,sel.c,{t:"",d:""});}} style={{...BTN,background:"var(--card)",color:"var(--fg)",border:"1px solid var(--border)"}}>Text Cell</button>
        <button onClick={()=>{if(!sel)return;setCell(sel.r,sel.c,{});}} style={{...BTN,background:"transparent",color:"#EF4444",border:"1px solid rgba(239,68,68,0.3)"}}>Clear</button>
      </div>
    </div>
  </>);
}
