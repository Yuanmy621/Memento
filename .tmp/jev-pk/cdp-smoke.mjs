const base = 'http://127.0.0.1:9222'
const list = await (await fetch(base + '/json/list')).json()
const page = list.find(t => t.type === 'page' && t.url.includes('localhost:5173'))
if (!page) { console.log('targets:', list.map(t=>[t.type,t.url])); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const waiting = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); const r = waiting.get(m.id); if (r) { waiting.delete(m.id); r(m) } }
await new Promise(r => ws.onopen = r)
const send = (method, params={}) => new Promise(r => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({id:i, method, params})) })
const ev = async (expr, awaitPromise=false) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true })
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0,500))
  return r.result?.result?.value
}
console.log('title      :', await ev('document.title'))
console.log('hasGomoku  :', await ev('!!window.__gomoku'))
console.log('webgl      :', await ev(`(()=>{try{const c=document.createElement('canvas');return !!(c.getContext('webgl2')||c.getContext('webgl'))}catch(e){return 'err:'+e.message}})()`))
console.log('stoneCount :', await ev('window.__gomoku ? window.__gomoku.stoneCount() : -1'))
console.log('state      :', JSON.stringify(await ev('window.__gomoku.state()')))
ws.close()
