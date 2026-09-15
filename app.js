const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const storage = (() => {
  try { const probe = "__agri_probe__"; window.localStorage.setItem(probe, "1"); window.localStorage.removeItem(probe); return window.localStorage; }
  catch (e) { console.warn("AgriSummarize: browser storage is blocked, so API settings cannot be remembered.", e); return null; }
})();
const store = {
  get(key, fallback = "") { try { return storage?.getItem(key) || fallback; } catch { return fallback; } },
  set(key, value) { try { if (!storage) return false; storage.setItem(key, value); return true; } catch { return false; } }
};

const state = {
  file: null,
  pdf: null,
  pages: [],
  fullText: "",
  chunks: [],
  evidence: [],
  result: null,
  apiKey: store.get("agri_gemini_key"),
  model: store.get("agri_gemini_model", "gemini-3.6-flash"),
  chat: [],
  displayedSummary: null,       // translated text currently on screen (null = the original English summary)
  displayedLanguage: "English"  // language currently displayed in the summary card
};

const els = {
  fileInput: $("#fileInput"), dropZone: $("#dropZone"), browseBtn: $("#browseBtn"),
  filePreview: $("#filePreview"), fileName: $("#fileName"), fileMeta: $("#fileMeta"),
  removeFile: $("#removeFile"), analyzeBtn: $("#analyzeBtn"), apiInline: $("#apiInline"),
  processing: $("#processing"), progressFill: $("#progressFill"), processingTitle: $("#processingTitle"),
  processingDetail: $("#processingDetail"), stageList: $("#stageList"), results: $("#results"),
  questions: $("#questions"), translation: $("#translation"), summaryContent: $("#summaryContent"),
  resultTitle: $("#resultTitle"), resultSubtitle: $("#resultSubtitle"), metricPages: $("#metricPages"),
  metricChars: $("#metricChars"), metricChunks: $("#metricChunks"), mainTopic: $("#mainTopic"),
  numbersList: $("#numbersList"), warningsList: $("#warningsList"), recommendationsList: $("#recommendationsList"),
  termsList: $("#termsList"), copyBtn: $("#copyBtn"), downloadBtn: $("#downloadBtn"),
  questionForm: $("#questionForm"), questionInput: $("#questionInput"), chatLog: $("#chatLog"),
  languageSelect: $("#languageSelect"), translateBtn: $("#translateBtn"), toast: $("#toast"),
  settingsDialog: $("#settingsDialog"), apiKeyInput: $("#apiKeyInput"), modelInput: $("#modelInput")
};

// Attaches a listener without throwing when an element is missing, so one absent node cannot kill the whole app wiring.
function on(target, event, handler) { if (target && typeof target.addEventListener === "function") target.addEventListener(event, handler); return target; }

function toast(message) {
  els.toast.textContent = message; els.toast.classList.add("show");
  clearTimeout(window.__toast); window.__toast = setTimeout(() => els.toast.classList.remove("show"), 3000);
}
function setStage(stage, status="active") {
  $$("#stageList [data-stage]").forEach(x => {
    const is = x.dataset.stage === stage;
    if (is) x.classList.add(status);
    const order = ["upload","extract","understand","topics","summary","prepare"];
    if (order.indexOf(x.dataset.stage) < order.indexOf(stage)) { x.classList.remove("active"); x.classList.add("done"); x.querySelector("b").textContent="✓"; }
    if (is && status==="active") x.querySelector("b").textContent="…";
  });
}
function setProgress(n,title,detail,stage){ els.progressFill.style.width=`${n}%`; els.processingTitle.textContent=title; els.processingDetail.textContent=detail; if(stage)setStage(stage); }
function escapeHtml(s=""){return s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));}
function renderMarkdown(md=""){
  let x=escapeHtml(md).replace(/\r/g,"");
  x=x.replace(/^### (.*)$/gm,"<h3>$1</h3>").replace(/^## (.*)$/gm,"<h2>$1</h2>");
  x=x.replace(/\*\*(.*?)\*\*/g,"<strong>$1</strong>").replace(/`([^`]+)`/g,"<code>$1</code>");
  x=x.replace(/^\s*[-•] (.*)$/gm,"<li>$1</li>");
  x=x.replace(/(<li>.*<\/li>\n?)+/g,m=>`<ul>${m}</ul>`);
  x=x.split(/\n{2,}/).map(block=>block.trim()).filter(Boolean).map(block=>{
    if(/^<(h2|h3|ul)/.test(block)) return block;
    return `<p>${block.replace(/\n/g,"<br>")}</p>`;
  }).join("");
  return x;
}
function listRender(el, items) { el.innerHTML=(items?.length?items:["Not specified in the uploaded document."]).map(x=>`<li>${escapeHtml(String(x))}</li>`).join(""); }
function normalizeResult(obj){
  return {
    mainTopic: obj.mainTopic || "Not specified in the uploaded document.",
    summary: obj.summary || "Not specified in the uploaded document.",
    importantNumbers: Array.isArray(obj.importantNumbers)?obj.importantNumbers:[],
    warnings: Array.isArray(obj.warnings)?obj.warnings:[],
    recommendations: Array.isArray(obj.recommendations)?obj.recommendations:[],
    terminology: Array.isArray(obj.terminology)?obj.terminology:[],
    pageReferences: Array.isArray(obj.pageReferences)?obj.pageReferences:[]
  };
}
function extractJson(text){
  const cleaned=text.replace(/```json|```/gi,"").trim();
  try{return JSON.parse(cleaned)}catch{}
  const a=cleaned.indexOf("{"), b=cleaned.lastIndexOf("}");
  if(a>=0&&b>a){try{return JSON.parse(cleaned.slice(a,b+1))}catch{}}
  throw new Error("AI returned an invalid structured response.");
}
function chunkPages(pages, maxChars=42000){
  const chunks=[]; let current=""; let start=1; let end=1;
  for(const p of pages){
    const block=`\n\n===== PAGE ${p.page} =====\n${p.text}`;
    if(current && current.length+block.length>maxChars){chunks.push({start,end,text:current});current=block;start=p.page;end=p.page}
    else{current+=block;end=p.page}
  }
  if(current.trim()) chunks.push({start,end,text:current});
  return chunks;
}
async function gemini(prompt){
  if(!state.apiKey) throw new Error("Gemini API key is missing. Open API Settings and add your key.");
  const url=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(state.model)}:generateContent`;
  const res=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json","x-goog-api-key":state.apiKey},body:JSON.stringify({
    system_instruction:{parts:[{text:"You are a source-grounded agricultural extension document analyst. The supplied document text is the ONLY source of truth. Never use outside knowledge. If a requested fact is absent, say exactly: Not specified in the uploaded document. Preserve numbers, units, dosage, ranges, conditions, warnings, terminology and page references exactly as supported by the source."}]},
    contents:[{role:"user",parts:[{text:prompt}]}],
    generationConfig:{temperature:0.1,responseMimeType:"application/json"}
  })});
  if(!res.ok){let msg="Gemini request failed";try{const e=await res.json();msg=e.error?.message||msg}catch{}throw new Error(msg)}
  const data=await res.json(); const text=data.candidates?.[0]?.content?.parts?.map(p=>p.text||"").join("")||"";
  if(!text) throw new Error("No AI response was returned."); return text;
}

async function extractPdf(file){
  if(!file || file.type!=="application/pdf") throw new Error("Please select a valid PDF file.");
  const pdfjs = await import("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";
  const buffer=await file.arrayBuffer(); const pdf=await pdfjs.getDocument({data:buffer}).promise;
  const pages=[];
  for(let i=1;i<=pdf.numPages;i++){
    setProgress(Math.min(42,10+Math.round(i/pdf.numPages*32)),`Reading page ${i} of ${pdf.numPages}`,`Extracting text and retaining page ${i} as an evidence boundary.`,"extract");
    const page=await pdf.getPage(i); const content=await page.getTextContent();
    const text=content.items.map(x=>x.str).join(" ").replace(/\s+/g," ").trim();
    pages.push({page:i,text});
    await new Promise(r=>setTimeout(r,0));
  }
  return {pdf,pages};
}

async function analyzeDocument(){
  if(!state.file) return;
  if(!state.apiKey){els.apiInline.classList.remove("hidden"); openSettings(); return;}
  els.processing.classList.remove("hidden"); els.results.classList.add("hidden"); els.questions.classList.add("hidden"); els.translation.classList.add("hidden");
  document.querySelector("#processing").scrollIntoView({behavior:"smooth",block:"center"});
  try{
    setProgress(5,"Uploading document","Validating the selected PDF in your browser.","upload");
    const {pdf,pages}=await extractPdf(state.file); state.pdf=pdf; state.pages=pages;
    const usable=pages.filter(p=>p.text.trim());
    state.fullText=usable.map(p=>`===== PAGE ${p.page} =====\n${p.text}`).join("\n\n");
    if(!state.fullText.trim()) throw new Error("This PDF contains no extractable text. Try a text-based PDF or OCR it first.");
    state.chunks=chunkPages(usable);
    setProgress(48,"Understanding document",`${state.chunks.length} evidence block(s) created from ${pdf.numPages} page(s).`,"understand");
    const evidence=[];
    for(let i=0;i<state.chunks.length;i++){
      setProgress(48+Math.round((i/state.chunks.length)*20),`Reviewing evidence block ${i+1} of ${state.chunks.length}`,`Extracting only facts supported by pages ${state.chunks[i].start}–${state.chunks[i].end}.`,"topics");
      const prompt=`Analyze ONLY this evidence block from an agricultural extension PDF. Return JSON with:
{"facts":["..."],"numbers":["..."],"warnings":["..."],"recommendations":["..."],"terminology":["..."],"topicHints":["..."]}
Each item must preserve the source wording/number/unit where relevant and append [Page N] or [Pages N–M] when supported. Do not infer missing facts.
EVIDENCE:
${state.chunks[i].text}`;
      evidence.push(normalizeResult(extractJson(await gemini(prompt))));
    }
    state.evidence=evidence;
    setProgress(73,"Generating detailed summary","Synthesizing the evidence blocks without adding outside agricultural knowledge.","summary");
    const evidenceText=evidence.map((e,i)=>`BLOCK ${i+1}\nFacts: ${e.summary}\nNumbers: ${e.importantNumbers.join(" | ")}\nWarnings: ${e.warnings.join(" | ")}\nRecommendations: ${e.recommendations.join(" | ")}\nTerms: ${e.terminology.join(" | ")}`).join("\n\n");
    const finalPrompt=`Create the final detailed summary of the uploaded agricultural PDF using ONLY the evidence below. The final answer must be useful for an agricultural extension reader but must never introduce outside knowledge.

Return exactly this JSON schema:
{
 "mainTopic":"...",
 "summary":"Markdown with a concise overview followed by ONLY the sections that actually occur in the source. Cover relevant conditions, steps/procedures, cultivation/practice details, management, harvesting/post-harvest, uses, limitations, warnings and recommendations when supported. For every method/practice, explain purpose, materials/tools, procedure, conditions, timing, uses, advantages, limitations and precautions ONLY where evidence exists. Include [Page N] after important claims.",
 "importantNumbers":["exact values/ranges/dosages/measurements with [Page N]"],
 "warnings":["source-supported warnings/precautions with [Page N]"],
 "recommendations":["source-supported recommendations with [Page N]"],
 "terminology":["important technical terms actually used"],
 "pageReferences":["topic — Page N"]
}
If a requested category is absent, omit that section rather than inventing it. If a value is absent, write “Not specified in the uploaded document.” Do not create generic agriculture sections just because they were requested. Preserve numbers and units exactly.
EVIDENCE BLOCKS:
${evidenceText}`;
    state.result=normalizeResult(extractJson(await gemini(finalPrompt)));
    setProgress(91,"Preparing results","Formatting source references, facts and document Q&A.","prepare");
    renderResults();
    setProgress(100,"Analysis complete","Your results are grounded in the extracted PDF text.","prepare");
    $$("#stageList [data-stage]").forEach(x=>{x.classList.remove("active");x.classList.add("done");x.querySelector("b").textContent="✓"});
    await new Promise(r=>setTimeout(r,450));
    els.processing.classList.add("hidden"); els.results.classList.remove("hidden"); els.questions.classList.remove("hidden"); els.translation.classList.remove("hidden");
    els.results.scrollIntoView({behavior:"smooth",block:"start"});
  }catch(err){
    els.processing.classList.add("hidden"); toast(err.message||"Processing failed.");
    console.error(err);
  }
}

function renderResults(){
  const r=state.result;
  els.resultTitle.textContent=state.file.name;
  els.resultSubtitle.textContent=`${state.pages.length} pages · analyzed ${new Date().toLocaleString()}`;
  els.metricPages.textContent=state.pages.length;
  els.metricChars.textContent=state.fullText.length.toLocaleString();
  els.metricChunks.textContent=state.chunks.length;
  els.mainTopic.textContent=r.mainTopic;
  state.displayedSummary=null; state.displayedLanguage="English"; renderSummary(); updateTranslateLabel();
  listRender(els.numbersList,r.importantNumbers); listRender(els.warningsList,r.warnings); listRender(els.recommendationsList,r.recommendations);
  els.termsList.innerHTML=(r.terminology.length?r.terminology:["Not specified in the uploaded document."]).map(t=>`<span class="tag">${escapeHtml(t)}</span>`).join("");
  state.chat=[]; els.chatLog.innerHTML=`<div class="assistant-bubble"><span>✦</span><p>Your document is ready. Ask about a method, dosage, condition, page, warning or recommendation.</p></div>`;
}

function addChat(role,text){
  const wrap=document.createElement("div"); wrap.className=role==="user"?"user-bubble":"assistant-bubble";
  wrap.innerHTML=role==="user"?`<p>${escapeHtml(text)}</p>`:`<span>✦</span><p>${escapeHtml(text)}</p>`;
  els.chatLog.appendChild(wrap); els.chatLog.scrollTop=els.chatLog.scrollHeight;
}
async function askQuestion(question){
  if(!state.fullText){toast("Analyze a PDF first.");return}
  addChat("user",question);
  const thinking=document.createElement("div");thinking.className="assistant-bubble";thinking.innerHTML="<span>✦</span><p>Searching the uploaded evidence…</p>";els.chatLog.appendChild(thinking);
  try{
    const terms=question.toLowerCase().split(/[^a-z0-9]+/).filter(w=>w.length>2);
    const scored=state.pages.map(p=>({p,score:terms.reduce((n,t)=>n+(p.text.toLowerCase().includes(t)?1:0),0)})).sort((a,b)=>b.score-a.score);
    let selected=scored.filter(x=>x.score>0).slice(0,8).map(x=>x.p);
    if(!selected.length) selected=state.pages.slice(0,8);
    let evidence=selected.map(p=>`===== PAGE ${p.page} =====\n${p.text}`).join("\n\n");
    if(evidence.length>50000)evidence=evidence.slice(0,50000);
    const prompt=`Answer this question using ONLY the selected pages from the uploaded PDF. If the answer is not supported by these pages, say “Not specified in the uploaded document.” Do not use general agricultural knowledge. Preserve numbers, units and conditions exactly. Cite page numbers inline.
Question: ${question}
Selected PDF evidence:
${evidence}`;
    const answer=await gemini(prompt);
    const obj=extractJson(answer); const text=obj.answer||obj.response||obj.summary||"Not specified in the uploaded document.";
    thinking.remove(); addChat("assistant",text);
  }catch(e){thinking.remove();addChat("assistant",e.message||"Not specified in the uploaded document.");}
}
function currentSummaryText(){return state.displayedSummary||state.result?.summary||""}
function renderSummary(){els.summaryContent.innerHTML=renderMarkdown(currentSummaryText())}
function updateTranslateLabel(){
  const lang=els.languageSelect?els.languageSelect.value:"English";
  if(!state.result){els.translateBtn.textContent="Translate complete summary";return}
  if(lang===state.displayedLanguage){els.translateBtn.textContent=`Already shown in ${lang}`;return}
  els.translateBtn.textContent=lang==="English"?"Show original English":`Translate to ${lang}`;
}
async function translateSummary(){
  if(!state.result)return;
  const lang=els.languageSelect.value;
  if(lang===state.displayedLanguage){toast(`The summary is already shown in ${lang}.`);return}
  if(lang==="English"){
    state.displayedSummary=null; state.displayedLanguage="English"; renderSummary(); updateTranslateLabel();
    toast("Showing the original English summary."); return;
  }
  els.translateBtn.disabled=true;els.translateBtn.textContent="Translating…";
  try{
    const prompt=`Translate the COMPLETE following generated summary into ${lang}. Do not add or remove facts. Keep all numbers, units, ranges, technical terminology, warnings and [Page N] references unchanged in meaning. Return JSON {"translatedSummary":"..."}.
SUMMARY:
${state.result.summary}`;
    const obj=extractJson(await gemini(prompt));
    state.displayedSummary=obj.translatedSummary||state.result.summary; state.displayedLanguage=lang;
    renderSummary();
    toast(`Summary translated to ${lang}.`);
  }catch(e){toast(e.message)}finally{els.translateBtn.disabled=false;updateTranslateLabel();}
}

function isPdfFile(file){if(!file)return false;if(file.type==="application/pdf")return true;return /\.pdf$/i.test(file.name||"")}
function resetFileInput(){els.fileInput.value=""}
function selectFile(file){
  if(!file)return;
  if(!isPdfFile(file)){toast("Only PDF files are supported.");resetFileInput();return}
  state.file=file;els.fileName.textContent=file.name;els.fileMeta.textContent=`${(file.size/1024/1024).toFixed(2)} MB · pages will be read on analyze`;
  els.dropZone.classList.add("hidden");els.filePreview.classList.remove("hidden");els.analyzeBtn.disabled=false;
  els.apiInline.classList.toggle("hidden",!!state.apiKey);
  resetFileInput();
}
function clearFile(){state.file=null;els.fileInput.value="";els.filePreview.classList.add("hidden");els.dropZone.classList.remove("hidden");els.analyzeBtn.disabled=true;els.apiInline.classList.add("hidden")}
function openSettings(){
  els.apiKeyInput.value=state.apiKey;els.modelInput.value=state.model;
  const dlg=els.settingsDialog;if(!dlg)return;
  if(typeof dlg.showModal==="function"){if(!dlg.open)dlg.showModal()}
  else{dlg.setAttribute("open","");dlg.classList.add("modal-fallback")}
}
function closeSettings(){
  const dlg=els.settingsDialog;if(!dlg)return;
  if(typeof dlg.close==="function"&&dlg.open)dlg.close();
  dlg.removeAttribute("open");dlg.classList.remove("modal-fallback");
}
function saveSettings(e){
  e.preventDefault();
  if(e.submitter&&e.submitter.value==="cancel"){closeSettings();return}
  const apiKey=els.apiKeyInput.value.trim().replace(/^["']|["']$/g,"").replace(/^Bearer\s+/i,"").replace(/\s+/g,"");
  const model=els.modelInput.value.trim().replace(/^models\//i,"").replace(/\s+/g,"")||"gemini-3.6-flash";
  state.apiKey=apiKey;state.model=model;
  const savedKey=store.set("agri_gemini_key",apiKey),savedModel=store.set("agri_gemini_model",model),persisted=savedKey&&savedModel;
  closeSettings();els.apiInline.classList.toggle("hidden",!!state.apiKey);
  if(!apiKey)toast("API key cleared.");
  else if(persisted)toast("AI settings saved.");
  else toast("Settings applied for this session, but this browser blocks storage so they will not be remembered.");
}

try{
  on(els.browseBtn,"click",e=>{e.stopPropagation();els.fileInput.click()});
  on(els.dropZone,"click",()=>els.fileInput.click());
  on(els.dropZone,"keydown",e=>{if(e.key==="Enter"||e.key===" "||e.key==="Spacebar"){e.preventDefault();els.fileInput.click()}});
  on(els.fileInput,"change",e=>selectFile(e.target.files&&e.target.files[0]));
  ["dragenter","dragover"].forEach(ev=>on(els.dropZone,ev,e=>{e.preventDefault();els.dropZone.classList.add("drag")}));
  ["dragleave","drop"].forEach(ev=>on(els.dropZone,ev,e=>{e.preventDefault();els.dropZone.classList.remove("drag")}));
  on(els.dropZone,"drop",e=>{e.preventDefault();e.stopPropagation();const files=[...(e.dataTransfer?.files||[])];selectFile(files.find(isPdfFile)||files[0])});
  ["dragenter","dragover"].forEach(ev=>on(document,ev,e=>e.preventDefault()));
  on(document,"drop",e=>{e.preventDefault();const files=[...(e.dataTransfer?.files||[])];if(files.length)selectFile(files.find(isPdfFile)||files[0])});
  on(els.removeFile,"click",clearFile);
  on($("#openSettings"),"click",openSettings);
  on($("#inlineSettings"),"click",openSettings);
  on($("#cancelSettings"),"click",e=>{e.preventDefault();closeSettings()});
  on($("#cancelSettingsBtn"),"click",e=>{e.preventDefault();closeSettings()});
  on($("#settingsForm"),"submit",saveSettings);
  on(document,"keydown",e=>{if(e.key==="Escape"&&els.settingsDialog&&els.settingsDialog.classList.contains("modal-fallback"))closeSettings()});
  on(els.analyzeBtn,"click",analyzeDocument);
  on(els.questionForm,"submit",e=>{e.preventDefault();const q=els.questionInput.value.trim();if(q){els.questionInput.value="";askQuestion(q)}});
  $$(".suggestions button").forEach(b=>on(b,"click",()=>askQuestion(b.dataset.q)));
  on(els.languageSelect,"change",updateTranslateLabel);
  on(els.translateBtn,"click",translateSummary);
}catch(err){console.error("AgriSummarize failed to initialise.",err);toast("AgriSummarize could not start. Open DevTools (F12) → Console for details.")}
els.copyBtn.addEventListener("click",async()=>{try{await navigator.clipboard.writeText(currentSummaryText());toast(`Copied the ${state.displayedLanguage} summary.`)}catch{toast("Clipboard access was blocked by the browser.")}});
els.downloadBtn.addEventListener("click",()=>{const r=state.result;if(!r)return;const text=`AgriSummarize\n${state.file.name}\n\nLanguage: ${state.displayedLanguage}\n\nMain topic: ${r.mainTopic}\n\n${currentSummaryText()}\n\nImportant numbers:\n- ${r.importantNumbers.join("\n- ")}\n\nWarnings:\n- ${r.warnings.join("\n- ")}\n\nRecommendations:\n- ${r.recommendations.join("\n- ")}\n\nTerminology:\n- ${r.terminology.join("\n- ")}`;const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([text],{type:"text/plain"}));const suffix=state.displayedLanguage==="English"?"":`-${state.displayedLanguage.toLowerCase()}`;a.download=`${state.file.name.replace(/\.pdf$/i,"")}-summary${suffix}.txt`;a.click();URL.revokeObjectURL(a.href)});
els.apiInline.classList.toggle("hidden",!!state.apiKey);
updateTranslateLabel();
window.__agriReady = true; // signals the startup watchdog in index.html that app wiring finished

