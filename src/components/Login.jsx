import { useState, useEffect, useRef } from "react";
import { Logo } from "./Logo";

export function Login({onLogin}){
  const[pw,setPw]=useState("");const[err,setErr]=useState(false);const[shake,setShake]=useState(false);
  const ref=useRef(null);useEffect(()=>{ref.current?.focus();},[]);
  const go=()=>{if(onLogin(pw)){setErr(false);}else{setErr(true);setShake(true);setTimeout(()=>setShake(false),500);setPw("");}};
  return(<div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"var(--bg)",fontFamily:"'DM Sans',-apple-system,sans-serif"}}><div style={{width:380,padding:"48px 40px",background:"var(--card)",borderRadius:16,border:"1px solid var(--border)",textAlign:"center",animation:shake?"shake 0.5s ease":"none"}}><div style={{marginBottom:32,display:"flex",justifyContent:"center"}}><Logo h={36}/></div><div style={{fontSize:18,fontWeight:700,color:"var(--fg)",marginBottom:6}}>Viewix Tools</div><div style={{fontSize:13,color:"var(--muted)",marginBottom:28}}>Enter password to continue</div><div><input ref={ref} type="password" value={pw} onChange={e=>{setPw(e.target.value);setErr(false);}} onKeyDown={e=>{if(e.key==="Enter")go();}} placeholder="Password" style={{width:"100%",padding:"12px 16px",borderRadius:10,border:`1px solid ${err?"#EF4444":"var(--border)"}`,background:"var(--input-bg)",color:"var(--fg)",fontSize:15,outline:"none",marginBottom:12,textAlign:"center",letterSpacing:"0.15em"}}/>{err&&<div style={{fontSize:12,color:"#EF4444",marginBottom:10}}>Wrong password</div>}<button onClick={go} style={{width:"100%",padding:"12px",borderRadius:10,border:"none",background:"#0082FA",color:"white",fontSize:14,fontWeight:700,cursor:"pointer"}}>Sign In</button></div></div></div>);
}
