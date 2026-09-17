// Run with Bun, then open the printed URL in a browser. Test data uses a unique
// filename; the page deletes only its own files after closing worker handles.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
const output = await mkdtemp(join(tmpdir(), 'graphx-browser-'));
const build = await Bun.build({
	entrypoints: ['packages/graphx/test/core/fixtures/browser-worker.ts'],
	target: 'browser',
	outdir: output,
	naming: 'worker.js',
	external: ['@sqlite.org/sqlite-wasm'],
});
if (!build.success) throw new AggregateError(build.logs, 'Browser test build failed');
const sqliteDir = join(
	dirname(import.meta.resolve('@sqlite.org/sqlite-wasm/package.json').replace('file://', '')),
	'dist',
);
const html = `<!doctype html><title>Graphx OPFS conformance</title><pre id="result">Running…</pre><script type="module">
const report = document.querySelector('#result');
const filename = '/graphx-conformance-' + crypto.randomUUID() + '.sqlite3';
const workers = [];
let nextId = 0;
async function spawn() {
  const worker = new Worker('/worker.js', {type:'module'});
  workers.push(worker);
  const pending = new Map();
  await new Promise((resolve,reject) => {
    const startup = setTimeout(()=>reject(new Error('Worker startup timed out')),20000);
    worker.onerror = (event) => {clearTimeout(startup);reject(new Error(event.message));for(const cb of pending.values()) cb.reject(new Error(event.message));pending.clear();};
    worker.onmessage = ({data}) => {
      if(data.ready) {clearTimeout(startup);return resolve();}
      const cb = pending.get(data.id); pending.delete(data.id);
      if(cb) data.error ? cb.reject(new Error(data.error)) : cb.resolve(data.value);
    };
  });
  return {worker, call(op,args={}) {
    const id = ++nextId;
    return new Promise((resolve,reject)=> {
      const timeout=setTimeout(()=>{pending.delete(id);reject(new Error('Worker operation timed out: '+op));},20000);
      pending.set(id,{resolve(value){clearTimeout(timeout);resolve(value);},reject(error){clearTimeout(timeout);reject(error);}});
      worker.postMessage({id,op,args});
    });
  }};
}
function assert(value,message) { if(!value) throw new Error(message); }
let peer;
window.peer = {
  async open(filename) {peer=await spawn();return peer.call('open',{filename});},
  call(op,args) {return peer.call(op,args);},
  async close() {await peer.call('close');peer.worker.terminate();},
};
if(new URL(location.href).searchParams.has('peer')) {
  window.testResult={status:'peer-ready'};report.textContent='Peer ready';
} else {
window.testResult = {status:'running',filename};
try {
  let a = await spawn();
  const opened = await a.call('open',{filename});
  assert(opened.journal[0].journal_mode==='delete','rollback journaling');
  const seed = await a.call('seed');
  await a.call('close'); a.worker.terminate();
  a = await spawn(); await a.call('open',{filename});
  const read = await a.call('read',seed);
  assert(read.body==='peach orchard edited' && read.history===2,'reopen body and history');
  assert(read.found.includes(seed.id) && read.neighbors.includes(seed.other),'reopen FTS and edges');
  assert(JSON.stringify(read.bytes)==='[0,255,1,128]','reopen binary blob');
  const b = await spawn(); await b.call('open',{filename});
  const writes = await Promise.allSettled([a.call('write',{name:'concurrent A'}),b.call('write',{name:'concurrent B'})]);
  for(let i=0;i<writes.length;i++) {
    if(writes[i].status==='rejected') {
      assert(/BUSY|locked|locking/i.test(String(writes[i].reason)), 'only lock contention may require retry: '+writes[i].reason);
      await [a,b][i].call('write',{name:'retry '+i});
    }
  }
  assert(await a.call('count')===4 && await b.call('count')===4,'concurrent writes remain visible');
  await b.call('close'); b.worker.terminate();
  assert(await a.call('hold')==='transaction-held','hold uncommitted transaction');
  a.worker.terminate();
  a = await spawn(); await a.call('open',{filename});
  assert((await a.call('recovered')).length===0,'crashed transaction rolled back');
  assert(await a.call('count')===4,'committed writes survived crash');
  await a.call('close'); a.worker.terminate();
  window.testResult={status:'passed',version:opened.version,reopen:read,concurrentWrites:4,crashRollback:true};
} catch(error) {window.testResult={status:'failed',error:String(error),stack:error.stack,filename};}
finally {
  for(const worker of workers) worker.terminate();
  if(window.testResult.status==='passed') {
    const root=await navigator.storage.getDirectory();
    for(const suffix of ['', '-journal','-wal','-shm']) await root.removeEntry(filename.slice(1)+suffix).catch(()=>{});
  }
  report.textContent=JSON.stringify(window.testResult,null,2);
}
}
</script>`;
const headers = {
	'Cross-Origin-Opener-Policy': 'same-origin',
	'Cross-Origin-Embedder-Policy': 'require-corp',
	'Cache-Control': 'no-store',
};
const server = Bun.serve({
	port: 4179,
	hostname: '127.0.0.1',
	async fetch(req) {
		const path = new URL(req.url).pathname;
		if (path === '/')
			return new Response(html, { headers: { ...headers, 'Content-Type': 'text/html' } });
		if (path === '/worker.js') {
			const code = (await Bun.file(join(output, 'worker.js')).text()).replaceAll(
				'"@sqlite.org/sqlite-wasm"',
				'"/sqlite/index.mjs"',
			);
			return new Response(code, { headers: { ...headers, 'Content-Type': 'text/javascript' } });
		}
		const name = path.slice('/sqlite/'.length);
		if (path.startsWith('/sqlite/') && /^[\w.-]+$/.test(name))
			return new Response(Bun.file(join(sqliteDir, name)), { headers });
		return new Response('Not found', { status: 404, headers });
	},
});
console.log('Graphx browser conformance: ' + server.url);
process.on('SIGINT', async () => {
	server.stop(true);
	await rm(output, { recursive: true, force: true });
	process.exit(0);
});
