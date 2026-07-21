function safeJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
}

function validOrigin(value) {
  if (!value) return "";
  try { const url = new URL(value); return url.origin === value ? value : ""; } catch { return ""; }
}

/** Render the credential-free stationary browser viewer. */
export function renderBrowserViewer(sessionId, query = new URLSearchParams()) {
  const theme = query.get("theme") === "light" ? "light" : query.get("theme") === "dark" ? "dark" : "system";
  const hostOrigin = validOrigin(query.get("hostOrigin") || "");
  const embed = query.get("embed") === "1" || query.get("embed") === "true";
  return `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Browser viewer</title><style>:root{color-scheme:light;background:#f7f7f8;color:#171717}html[data-theme=dark]{color-scheme:dark;background:#111;color:#eee}@media(prefers-color-scheme:dark){html[data-theme=system]{color-scheme:dark;background:#111;color:#eee}}html,body{margin:0;width:100%;height:100%;font:14px system-ui}body{display:grid;grid-template-rows:1fr auto}main{display:grid;place-items:center;overflow:hidden}canvas{max-width:100%;max-height:100%;object-fit:contain;background:#ddd;touch-action:none}footer{display:flex;gap:6px;padding:8px;background:color-mix(in srgb,currentColor 8%,transparent)}button{color:inherit;background:color-mix(in srgb,currentColor 12%,transparent);border:1px solid color-mix(in srgb,currentColor 35%,transparent);border-radius:4px;padding:5px 9px}body[data-embed=true] footer{display:none}</style></head><body data-embed="${embed}"><main><canvas tabindex="0"></canvas></main><footer><button data-action="back">Back</button><button data-action="forward">Forward</button><button data-action="reload">Reload</button><button data-action="stop">Stop</button></footer><script>
const sessionId=${safeJson(sessionId)},hostOrigin=${safeJson(hostOrigin)};const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');let socket,revision=0,seq=0;
function request(method,params){return new Promise((resolve,reject)=>{const id=crypto.randomUUID();const on=e=>{let frame;try{frame=JSON.parse(e.data)}catch{return}if(frame.type==='res'&&frame.id===id){socket.removeEventListener('message',on);frame.ok?resolve(frame.payload):reject(frame.error)}};socket.addEventListener('message',on);socket.send(JSON.stringify({type:'req',id,method,params}))})}
function modifiers(e){return ['Control','Shift','Alt','Meta'].filter(k=>e[k.toLowerCase()+'Key'])}
function act(action){return request('browserAct',{sessionId,actionId:'viewer-'+crypto.randomUUID(),expectedRevision:revision,action}).then(result=>{revision=result.revision}).catch(()=>{})}
function draw(frame){if(frame.seq<=seq)return;seq=frame.seq;const image=new Image();image.onload=()=>{canvas.width=frame.viewport.width;canvas.height=frame.viewport.height;ctx.drawImage(image,0,0,canvas.width,canvas.height)};image.src='data:image/jpeg;base64,'+frame.jpegBase64}
function connect(){socket=new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//'+location.host);socket.addEventListener('open',async()=>{const hello=await request('connect',{minProtocol:1,maxProtocol:1,client:{id:'browser-viewer',version:'1',platform:'browser'},subscribe:['browser:'+sessionId]});const context=await request('browserContext',{sessionId,include:[]});revision=context.snapshot.revision;canvas.focus()});socket.addEventListener('message',e=>{let frame;try{frame=JSON.parse(e.data)}catch{return}if(frame.type==='event'&&frame.event==='browser.frame'&&frame.payload.sessionId===sessionId)draw(frame.payload)})}connect();
canvas.addEventListener('pointerdown',e=>{const r=canvas.getBoundingClientRect();act({kind:'click',point:{x:(e.clientX-r.left)*canvas.width/r.width,y:(e.clientY-r.top)*canvas.height/r.height},button:e.button===2?'right':'left',modifiers:modifiers(e)})});canvas.addEventListener('wheel',e=>{e.preventDefault();act({kind:'scroll',deltaX:e.deltaX,deltaY:e.deltaY})},{passive:false});canvas.addEventListener('keydown',e=>{e.preventDefault();act({kind:'press',key:e.key,modifiers:modifiers(e)})});document.querySelectorAll('[data-action]').forEach(b=>b.addEventListener('click',()=>act({kind:b.dataset.action})));addEventListener('beforeunload',()=>socket?.close());
</script></body></html>`;
}
