import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import vm from 'node:vm'
const source = readFileSync(new URL('../../scripts/dev-server.mjs', import.meta.url), 'utf8')
const handler = source.slice(source.indexOf('async function handleCliGenerateRequest('), source.indexOf('\nasync function handleRuntimeRequest('))
let finishLookup
let enteredLookup
const lookupStarted = new Promise(resolve => enteredLookup = resolve)
const fakeResponse = new EventEmitter()
fakeResponse.destroyed = false
fakeResponse.headersSent = false
fakeResponse.writableEnded = false
let launchState = null
const context = {
  cliTaskRunning: false,
  port: 4173,
  URL,
  AbortController,
  readJsonBody: async () => ({driverId:'antigravity', allowUserProfile:true, messages:[{role:'user',content:'safe mock'}]}),
  cliDrivers: [{id:'antigravity',command:'mock-agy',generateArgs:[]}],
  getCliExecutionStatus: () => 'available',
  findExecutable: () => { enteredLookup(); return new Promise(resolve => finishLookup = resolve) },
  createCliPrompt: () => 'safe mock',
  mkdtempSync: () => '/tmp/mock-workbench-unused',
  join: (...parts) => parts.join('/'),
  cliRuntimeRoot: '/tmp/mock',
  process: {env:{}},
  antigravityInput: value => value,
  runCliProcess: async (_path,_args,_prompt, options) => {launchState = {clientDisconnected:fakeResponse.destroyed, signalAborted:options.signal.aborted}; return 'mock result'},
  parseAntigravityOutput: () => 'mock result',
  sendJson: () => {},
  rmSync: () => {},
}
vm.createContext(context)
vm.runInContext(handler, context)
const request = {headers:{origin:'http://127.0.0.1:4173','content-type':'application/json'}}
const running = context.handleCliGenerateRequest(request, fakeResponse)
await lookupStarted
fakeResponse.destroyed = true
fakeResponse.emit('close')
finishLookup('/tmp/never-executed-mock')
await running
console.log(JSON.stringify({test:'disconnect while resolving CLI', launchState}))
const promptSource = source.slice(source.indexOf('function createCliPrompt('), source.indexOf('\nfunction buildCliEnvironment('))
vm.runInContext(promptSource, context)
const msg = 'x'.repeat(24000)+'MUST_APPEAR_END'
const prompt = context.createCliPrompt([{role:'user',content:msg}])
console.log(JSON.stringify({test:'browser CLI silent truncation', inputChars:msg.length, preservesTail:prompt.includes('MUST_APPEAR_END')}))
const requestHandler = source.slice(source.indexOf('async function handleRequest('), source.indexOf('\nconst server = createServer('))
const fs = await import('node:fs')
const path = await import('node:path')
let servedPath
const staticContext = { URL, handleRuntimeRequest: async () => false, projectRoot:'/Users/zxx/dev/ai-creator-workbench', normalize:path.normalize, resolve:path.resolve, join:path.join, sep:path.sep, existsSync:fs.existsSync, statSync:fs.statSync, extname:path.extname, contentTypes:{}, createReadStream:filePath => ({pipe:() => servedPath = filePath}) }
vm.createContext(staticContext)
vm.runInContext(requestHandler, staticContext)
let returnedStatus
await staticContext.handleRequest({method:'GET',url:'/.git/HEAD',headers:{host:'untrusted.example:4173'}}, {writeHead:code => returnedStatus = code,end:() => {}})
console.log(JSON.stringify({test:'static root and Host boundary', status:returnedStatus, servedPath}))
