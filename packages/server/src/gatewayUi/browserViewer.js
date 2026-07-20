function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** Render the credential-free stationary browser viewer. */
export function renderBrowserViewer(sessionId, query = {}) {
  const theme = query.get("theme");
  const hostOrigin = query.get("hostOrigin") || "";
  const embed = query.get("embed") || "";
  return `<!doctype html><html lang="en" data-theme="${escapeHtml(theme === "dark" ? "dark" : theme === "light" ? "light" : "system")}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Browser viewer</title><style>html,body{margin:0;width:100%;height:100%;background:#111;color:#eee;font:14px system-ui}body{display:grid;grid-template-rows:1fr auto}main{display:grid;place-items:center;overflow:hidden}canvas{max-width:100%;max-height:100%;object-fit:contain;background:#222}footer{display:flex;gap:6px;padding:8px;background:#181818}button{color:inherit;background:#333;border:1px solid #555;border-radius:4px;padding:5px 9px}</style></head><body><main><canvas tabindex="0"></canvas></main><footer><button data-action="back">Back</button><button data-action="forward">Forward</button><button data-action="reload">Reload</button><button data-action="stop">Stop</button></footer><script>
const sessionId=${JSON.stringify(sessionId)}, hostOrigin=${JSON.stringify(hostOrigin)}, embed=${JSON.stringify(embed)};
const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d'),socket=new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//'+location.host);
let revision=0,seq=0;
function request(method,params){return new Promise((resolve,reject)=>{const id=Math.random().toString(36).slice(2);const on=(event)=>{const frame=JSON.parse(event.data);if(frame.type==='res'&&frame.id===id){socket.removeEventListener('message',on);frame.ok?resolve(frame.result):reject(frame.error)}};socket.addEventListener('message',on);socket.send(JSON.stringify({type:'req',id,method,params}))})}
function act(action){return request('browserAct',{sessionId,actionId:'viewer-'+Date.now()+'-'+Math.random().toString(36).slice(2),expectedRevision:revision,action}).then((result)=>{revision=result.revision}).catch(()=>{})}
socket.addEventListener('open',()=>request('connect',{minProtocol:1,maxProtocol:1,client:{id:'browser-viewer',version:'1',platform:'browser'},subscribe:['browser:'+sessionId]}).then(()=>canvas.focus()).catch(()=>{}));
socket.addEventListener('message',(event)=>{const frame=JSON.parse(event.data);if(frame.type!=='event'||frame.event!=='browser.frame'||frame.payload.sessionId!==sessionId||frame.payload.seq<=seq)return;seq=frame.payload.seq;const image=new Image();image.onload=()=>{canvas.width=image.width;canvas.height=image.height;ctx.drawImage(image,0,0)};image.src='data:image/jpeg;base64,'+frame.payload.jpegBase64});
canvas.addEventListener('pointerdown',(event)=>{const r=canvas.getBoundingClientRect();act({kind:'click',point:{x:(event.clientX-r.left)*canvas.width/r.width,y:(event.clientY-r.top)*canvas.height/r.height}})});
canvas.addEventListener('keydown',(event)=>{if(event.key==='Tab'||event.key==='Enter'||event.key==='Escape'||event.key.startsWith('Arrow')){event.preventDefault();act({kind:'press',key:event.key,modifiers:[...(event.ctrlKey?['Control']:[]),...(event.shiftKey?['Shift']:[]),...(event.altKey?['Alt']:[])]})}});
document.querySelectorAll('[data-action]').forEach((button)=>button.addEventListener('click',()=>act({kind:button.dataset.action})));
window.addEventListener('beforeunload',()=>socket.close());
</script></body></html>`;
}
