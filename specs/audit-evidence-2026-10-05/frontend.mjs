import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'

// 仅读取当前项目源代码；用隔离对象、延迟保存替身复现，不访问用户项目库、网络或真实模型。
const source = fs.readFileSync(new URL('../../src/app.js', import.meta.url), 'utf8')
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)))
const reports = []
const report = (scenario, result) => reports.push({ scenario, ...result })
const applySource = extract('async function applyCandidate(', '\nasync function undoCustom(')

function candidateContext() {
  const saves = []
  const state = {currentDocId:'scene-1',activeTab:'script',generationContext:{documentId:'scene-1',tabName:'script',title:'scene',baseContent:'原文',knowledgeChunks:[]},documents:{'scene-1':{content:'原文'}},versions:{'scene-1':[]},versionCounters:{'scene-1':0},selectedVersionByDocument:{},tabContents:{'scene-1':{}},lastAcceptedText:''}
  const history = {undo:[],redo:[]}
  const elements = {candidateContent:{textContent:'候选'},scriptEditor:{value:'原文',selectionStart:2,selectionEnd:2,focus(){}},generationError:{},candidateCard:{classList:{add(){}}}}
  const ctx = {structuredClone,state,elements,document:{querySelector:()=>({textContent:''})},getContentAt:()=>state.documents['scene-1'].content,setContentAt:(_id,_tab,text)=>state.documents['scene-1'].content=text,getEditHistory:()=>history,addVersion:(_id,text)=>{state.versions['scene-1'].push({text});return ++state.versionCounters['scene-1']},persistWorkspace:()=>new Promise(resolve=>saves.push(resolve)),updateDocumentView(){},updateEditorMetrics(){},showToast(){},setSaveStatus(){},discardCandidate(){state.generationContext=null;elements.candidateContent.textContent=''},formatVersionHistory:()=>'',saves}
  vm.createContext(ctx)
  vm.runInContext(applySource,ctx)
  return ctx
}

{
  const ctx = candidateContext()
  const first = ctx.applyCandidate('append')
  const second = ctx.applyCandidate('append')
  assert.equal(ctx.state.documents['scene-1'].content,'原文\n\n候选\n\n候选')
  assert.equal(ctx.state.versions['scene-1'].length,2)
  report('同一候选在首次保存返回前重复采纳', {content:ctx.state.documents['scene-1'].content,versions:ctx.state.versions['scene-1'].length,reproduced:true})
  ctx.saves.forEach(resolve=>resolve(true))
  await Promise.all([first,second])
}

{
  const ctx = candidateContext()
  const applying = ctx.applyCandidate('replace')
  // 对应 input 事件同步写入 state 与 editor；300 ms 自动保存定时器尚未触发。
  ctx.state.documents['scene-1'].content = '候选 + 保存等待期间新写入'
  ctx.elements.scriptEditor.value = ctx.state.documents['scene-1'].content
  ctx.saves[0](false)
  await applying
  assert.equal(ctx.state.documents['scene-1'].content,'原文')
  assert.equal(ctx.elements.scriptEditor.value,'原文')
  report('采纳保存期间继续编辑，随后本次保存失败', {content:ctx.state.documents['scene-1'].content,newEditsLost:true,reproduced:true})
}

{
  const ctx = {state:{currentDocId:'scene-1',generationContext:{documentId:'scene-1',tabName:'references',title:'场景1',knowledgeChunks:[]},project:{name:'演示',type:'短剧'},documents:{}},document:{querySelectorAll:()=>[{getAttribute:()=> 'true'},{getAttribute:()=> 'true'}]},getDocumentKind:()=> 'scene',getParentEpisodeId:()=> 'episode-1',getContentAt:(_id,tab)=>tab==='script'?'唯一的需要核对的真实正文':'关联资料默认说明'}
  vm.createContext(ctx)
  vm.runInContext(extract('function getUpstreamContextDocuments(', '\nfunction appendGenerationDelta('),ctx)
  const sent = ctx.buildGenerationMessages('检查冲突')[1].content
  assert.equal(sent.includes('唯一的需要核对的真实正文'),false)
  assert.equal(sent.includes('关联资料默认说明'),true)
  report('设定引用页执行检查冲突', {hasCurrentScript:false,hasReferenceNotes:true,reproduced:true})
}

{
  let exported = ''
  const state = {currentDocId:'episode-2',activeTab:'script',project:{name:'演示'},documents:{'episode-1':{title:'第一集',content:'集1'},'episode-2':{title:'第二集',content:'集2'},'scene-1':{title:'第一集的分场',content:'场1'},'scene-2':{title:'第二集的分场',content:'场2'}},structure:{acts:[{episodeIds:['episode-1','episode-2']}],episodes:{'episode-1':{sceneIds:['scene-1']},'episode-2':{sceneIds:['scene-2']}}},tabContents:{'episode-1':{references:'手写引用备注'}},knowledge:{index:{}}}
  const ctx = {state,activeProjectId:'demo',elements:{scriptEditor:{value:'集2'}},setCurrentContent(){},workspaceSnapshot:()=>({}),downloadDocument:async(_name,content)=>{exported=content;return '/tmp/仅模拟'},refreshStructureMetadata(){},renderProjectIdentity(){},updateDocumentView(){},persistWorkspace:async()=>true,showToast(){}}
  vm.createContext(ctx)
  vm.runInContext(extract('function getDocumentPosition(', '\nfunction makeUniqueId(')+extract('async function moveCurrentDocument(', '\nasync function duplicateCurrentDocument(')+extract('async function exportProject(', '\ndocument.querySelector(\'#newProjectForm\')'),ctx)
  await ctx.moveCurrentDocument(-1)
  await ctx.exportProject('md')
  assert.equal(state.structure.acts[0].episodeIds[0],'episode-2')
  const actualHeadings = [...exported.matchAll(/^## (.+)$/gm)].map(match=>match[1])
  assert.deepEqual(actualHeadings,['第一集','第二集','第一集的分场','第二集的分场'])
  assert.equal(exported.includes('手写引用备注'),false)
  report('第二集上移后导出 Markdown', {treeEpisodeOrder:[...state.structure.acts[0].episodeIds],exportedHeadings:actualHeadings,referencesOmitted:true,reproduced:true})
}

{
  let focused = ''
  const deferredSaves = []
  const node = name => ({textContent:'',disabled:false,classList:{toggle(){}},setAttribute(){},replaceChildren(){},focus(){focused=name},querySelector(){return node('child')},closest(){return node('parent')}})
  const tabs = ['script','outline','references','history'].map(tab => ({...node(tab),dataset:{tab},handlers:{},addEventListener(type,callback){this.handlers[type]=callback}}))
  const state = {currentDocId:'scene-1',activeTab:'script',documents:{'scene-1':{title:'场景',breadcrumb:'分场',badge:'待创作',kicker:'场景',sceneTitle:'场景',intent:'目标',meta:[],mode:'剧本',labels:['正文','大纲','引用','历史']}},versionCounters:{},storageFailed:false}
  const elements = Object.fromEntries(['documentTitle','documentBreadcrumb','documentBadge','sceneKicker','sceneTitle','sceneIntent','scriptEditor','historyVersionSelect'].map(name=>[name,node(name)]))
  const ctx={state,elements,tabFallbacks:{outline:'',references:'',history:''},pendingSaves:0,unsavedEdits:false,document:{querySelector:()=>node('misc'),querySelectorAll:selector=>selector==='.document-tab'?tabs:[]},window:{requestAnimationFrame:callback=>callback()},saveImmediately:()=>new Promise(resolve=>deferredSaves.push(resolve)),abandonCandidateOnContextChange(){},getCurrentDocument:()=>state.documents['scene-1'],renderHistoryControls:()=>null,getCurrentContent:()=>'',updateEditorMetrics(){},updateAssistantProfile(){},updateStageAdvanceButton(){},setSaveStatus(){}}
  vm.createContext(ctx)
  vm.runInContext(extract('function updateDocumentView(', '\nfunction updateEditorMetrics(')+extract('async function switchTab(', '\nfunction switchView(')+extract("document.querySelectorAll('.document-tab').forEach((tab) => {", '\nelements.historyVersionSelect.addEventListener('),ctx)
  tabs[0].handlers.keydown({key:'ArrowRight',preventDefault(){}})
  assert.equal(focused,'outline')
  deferredSaves[0](true)
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(focused,'scriptEditor')
  report('tablist 按方向键，异步保存结束后', {selectedTab:state.activeTab,focusedControl:focused,focusLeftTablist:true,reproduced:true})
}

console.log(JSON.stringify({method:'真实函数源码 + 隔离对象/延迟保存替身；无 UI、原生窗口、数据库或模型调用',reports},null,2))
