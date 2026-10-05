// Read-only application audit using synthetic data only. No database, network, or real model calls.
import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import { pathToFileURL, fileURLToPath } from 'node:url'
const root = process.argv[2] || fileURLToPath(new URL('../..', import.meta.url))
const {createKnowledgeIndex} = await import(pathToFileURL(`${root}/src/knowledge-index.js`))
const {buildSemanticIndex} = await import(pathToFileURL(`${root}/src/semantic-search.js`))
let embedCalls = 0
globalThis.window = {__TAURI__:{core:{invoke:async(command,{texts}) => {
  assert.equal(command,'embed_text')
  embedCalls++
  return texts.map(()=>[1,0,0])
}}}}
const {projectBackup,parseBackup} = await import(pathToFileURL(`${root}/src/project-store.js`))
const source = fs.readFileSync(`${root}/src/app.js`,'utf8')
const doc={id:'source-project:world',sourceId:'source-project',name:'世界观',path:'世界观.md',content:'城中永远是冬季。居民通过书写记忆交换热量。',updatedAt:'2026-10-05T00:00:00.000Z'}
const first=createKnowledgeIndex([doc])
const second=createKnowledgeIndex([{...doc,updatedAt:'2026-10-05T00:00:01.000Z'}])
const previous=await buildSemanticIndex(first,'stub-model',null)
await buildSemanticIndex(second,'stub-model',previous)
assert.notEqual(first.chunks[0].id,second.chunks[0].id)
assert.equal(embedCalls,2)
console.log(JSON.stringify({case:'相同正文的项目设定再次同步',selectedReferenceSurvives:second.chunks.some(c=>c.id===first.chunks[0].id),mockEmbeddingCalls:embedCalls}))

const vector=Array.from({length:1024},(_,i)=>Math.sin(i)*0.01)
const content='甲'.repeat(600)
const chunks=Array.from({length:1500},(_,i)=>({...first.chunks[0],id:`d:${i}`,content}))
const semanticVectors=Object.fromEntries(chunks.map(c=>[c.id,{content:c.content,vector}]))
const workspace={project:{name:'容量复现',type:'短剧'},documents:{idea:{content:''}},knowledge:{sources:[{id:'s',name:'测试'}],selectedChunkIds:[],semantic:{model:'stub',vectors:semanticVectors}}}
const index={version:1,dimension:384,chunks}
const library={version:1,revision:1,activeId:'p',projects:[{id:'p',workspace,index}]}
const compactBytes=Buffer.byteLength(JSON.stringify(library))
const backup=projectBackup(workspace,index)
assert.ok(compactBytes<64*1024*1024)
assert.ok(Buffer.byteLength(backup)>64*1024*1024)
assert.throws(()=>parseBackup(backup),/备份超过 64 MiB/)
console.log(JSON.stringify({case:'1500片段+1024维模拟语义向量',databaseMiB:compactBytes/1048576,backupMiB:Buffer.byteLength(backup)/1048576,restoreRejected:true}))

let onClose
let projectSaved=false
let destroyed=false
const closeContext={isDesktopRuntime:true,window:{__TAURI__:{window:{getCurrentWindow:()=>({onCloseRequested:cb=>{onClose=cb;return Promise.resolve()},destroy:async()=>{destroyed=true}})}}},saveImmediately:async()=>{projectSaved=true;return true},inspirationUI:{dirty:()=>true,save:()=>{throw new Error('应保存草稿')}},showToast:()=>{},readableError:x=>x}
const closeStart=source.indexOf('if (isDesktopRuntime && window.__TAURI__.window?.getCurrentWindow)')
const closeStop=source.indexOf("document.querySelectorAll('svg.icon')",closeStart)
vm.runInNewContext(source.slice(closeStart,closeStop),closeContext)
await onClose({preventDefault(){}})
assert.ok(destroyed)
console.log(JSON.stringify({case:'灵感未保存时执行原始桌面关闭回调',projectSaved,destroyed,inspirationStillDirty:closeContext.inspirationUI.dirty()}))

const files=Array.from({length:81},(_,i)=>({name:`file-${i+1}.md`,webkitRelativePath:`合成资料/file-${i+1}.md`,size:40,lastModified:1791158400000,text:async()=>`第${i+1}条合成资料，标识 test${i+1}。`}))
const importContext={activeProjectId:'p',MAX_KNOWLEDGE_CHUNKS:2000,MAX_SELECTED_KNOWLEDGE_CHUNKS:6,state:{knowledge:{pendingFiles:files,index:createKnowledgeIndex([]),sources:[],selectedChunkIds:[]}},document:{querySelector:()=>({value:'folder'})},elements:{knowledgeDialog:{dataset:{}}},createKnowledgeIndex,persistWorkspace:async()=>true,renderKnowledge:()=>{},structuredClone}
vm.createContext(importContext)
const helpersStart=source.indexOf('function takeBalancedKnowledgeChunks(')
const helpersStop=source.indexOf('function renderKnowledge()',helpersStart)
const importStart=source.indexOf('async function indexPendingKnowledgeFiles()')
const importStop=source.indexOf('async function syncKnowledge(',importStart)
vm.runInContext(source.slice(helpersStart,helpersStop)+'\n'+source.slice(importStart,importStop),importContext)
const result=await vm.runInContext('indexPendingKnowledgeFiles()',importContext)
assert.equal(result.fileCount,80)
assert.equal(importContext.state.knowledge.index.chunks.some(c=>c.path.endsWith('file-81.md')),false)
console.log(JSON.stringify({case:'选择81个合格Markdown文件',selected:files.length,imported:result.fileCount,lastFilePresent:false,returnedSkippedCount:Object.hasOwn(result,'skippedCount')}))
console.log('All synthetic reproductions completed; repository and personal data unchanged.')
