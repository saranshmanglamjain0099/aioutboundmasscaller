const $=id=>document.getElementById(id);
const api=(p,o)=>fetch(p,o).then(r=>r.json());
const apiPost=(p,b)=>fetch(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json());
const apiDel=p=>fetch(p,{method:'DELETE'}).then(r=>r.json());
const apiPatch=(p,b)=>fetch(p,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json());
let charts={},callPage=1,logsInterval=null,logsPaused=false;

function toast(msg,type='ok'){
  const c=$('toasts')||document.body;
  const d=document.createElement('div');d.className='toast '+type;d.textContent=msg;
  c.appendChild(d);setTimeout(()=>d.remove(),3500);
}

function switchTab(name){
  document.querySelectorAll('.nav button').forEach(b=>{b.classList.toggle('active',b.dataset.tab===name)});
  document.querySelectorAll('.panel').forEach(p=>{p.classList.toggle('active',p.id==='p-'+name)});
  const loaders={stats:loadStats,calls:loadCalls,appointments:loadAppointments,logs:loadLogs,
    campaigns:loadCampaigns,agents:loadAgentProfiles,prompt:loadPrompt,settings:loadSettings,
    crm:loadCRM,batch:loadAgentProfiles,setup:()=>{}};
  if(loaders[name])loaders[name]();
}

function badge(val,cls){return `<span class="badge badge-${cls||val}">${val}</span>`}
function fmtDur(s){if(!s)return'-';const m=Math.floor(s/60);return m?`${m}m ${s%60}s`:`${s}s`}

// Stats
async function loadStats(){
  try{
    const d=await api('/api/stats');
    $('kpi-total').textContent=d.total_calls;
    $('kpi-booked').textContent=d.booked;
    $('kpi-ni').textContent=d.not_interested;
    $('kpi-rate').textContent=d.booking_rate_percent+'%';
    $('kpi-dur').textContent=fmtDur(Math.round(d.avg_duration_seconds));
    renderCharts(d);
  }catch(e){console.error(e)}
  try{
    const s=await api('/api/settings');const p=await api('/api/prompt');
    const cc=$('config-chips');if(!cc)return;
    const mk=(l,v,ok)=>`<span class="chip ${ok?'ok':'warn'}">${l}: ${v||'not set'}</span>`;
    cc.innerHTML=mk('Model',s.GEMINI_MODEL?.value,s.GEMINI_MODEL?.configured)+
      mk('Voice',s.GEMINI_TTS_VOICE?.value,s.GEMINI_TTS_VOICE?.configured)+
      mk('Trunk',s.OUTBOUND_TRUNK_ID?.value?'ready':'missing',s.OUTBOUND_TRUNK_ID?.configured)+
      mk('Prompt',p.is_custom?'custom':'default',true);
  }catch(e){}
}

function renderCharts(d){
  const oc=Object.entries(d.outcomes||{});
  const colors=['#00e87b','#ff4d6a','#ffb830','#00b8ff','#8888aa','#cc66ff'];
  // Outcomes donut
  if(charts.outcomes)charts.outcomes.destroy();
  const ctx1=$('chart-outcomes');
  if(ctx1)charts.outcomes=new Chart(ctx1,{type:'doughnut',data:{labels:oc.map(x=>x[0]),datasets:[{data:oc.map(x=>x[1]),backgroundColor:colors.slice(0,oc.length),borderWidth:0}]},options:{responsive:true,plugins:{legend:{labels:{color:'#8888aa',font:{size:11}}}}}});
  // Timeline
  if(charts.timeline)charts.timeline.destroy();
  const ctx2=$('chart-timeline');
  if(ctx2)charts.timeline=new Chart(ctx2,{type:'line',data:{labels:(d.timeline||[]).map(x=>x.date.slice(5)),datasets:[{label:'Calls',data:(d.timeline||[]).map(x=>x.count),borderColor:'#00e87b',backgroundColor:'rgba(0,232,123,.1)',fill:true,tension:.4,pointRadius:3}]},options:{responsive:true,scales:{x:{ticks:{color:'#8888aa'}},y:{ticks:{color:'#8888aa'},beginAtZero:true}},plugins:{legend:{display:false}}}});
  // Duration bar
  const dbo=Object.entries(d.duration_by_outcome||{});
  if(charts.duration)charts.duration.destroy();
  const ctx3=$('chart-duration');
  if(ctx3)charts.duration=new Chart(ctx3,{type:'bar',data:{labels:dbo.map(x=>x[0]),datasets:[{label:'Avg (s)',data:dbo.map(x=>Math.round(x[1])),backgroundColor:colors.slice(0,dbo.length),borderRadius:6}]},options:{responsive:true,scales:{x:{ticks:{color:'#8888aa'}},y:{ticks:{color:'#8888aa'},beginAtZero:true}},plugins:{legend:{display:false}}}});
}

// Single Call
async function submitCall(e){
  e.preventDefault();
  const phone=$('f-phone').value.trim();
  if(!phone.startsWith('+')){toast('Use E.164 format: +91...','err');return}
  const body={phone,lead_name:$('f-name').value||'there',business_name:$('f-biz').value||'our company',
    service_type:$('f-service').value||'our service'};
  const sel=$('f-agent-profile');if(sel&&sel.value)body.agent_profile_id=sel.value;
  const cp=$('f-custom-prompt');if(cp&&cp.value.trim())body.system_prompt=cp.value;
  try{const r=await apiPost('/api/call',body);toast('Call dispatched: '+r.room)}catch(e){toast('Failed: '+e,'err')}
}

// Batch
let batchContacts=[];
function parseCSV(){
  const file=$('bc-file').files[0];if(!file){toast('Select CSV','err');return}
  const reader=new FileReader();
  reader.onload=e=>{
    const lines=e.target.result.split('\n').filter(l=>l.trim());
    const headers=lines[0].split(',').map(h=>h.trim().toLowerCase());
    batchContacts=lines.slice(1).map(l=>{const cols=l.split(',');const o={};headers.forEach((h,i)=>o[h]=cols[i]?.trim());return o}).filter(c=>c.phone);
    $('bc-preview').innerHTML=`<p>${batchContacts.length} contacts parsed</p><table><tr><th>Phone</th><th>Name</th></tr>${batchContacts.slice(0,10).map(c=>`<tr><td>${c.phone}</td><td>${c.lead_name||c.name||'-'}</td></tr>`).join('')}</table>`;
  };reader.readAsText(file);
}
async function startBatch(){
  if(!batchContacts.length){toast('Parse CSV first','err');return}
  const delay=parseInt($('bc-delay')?.value)||3;
  const profSel=$('bc-agent-profile');
  const pb=$('bc-progress');const pf=$('bc-progress-fill');
  pb.style.display='block';let done=0;
  for(const c of batchContacts){
    const body={phone:c.phone,lead_name:c.lead_name||c.name||'there',business_name:c.business_name||'our company',service_type:c.service_type||'our service'};
    if(profSel&&profSel.value)body.agent_profile_id=profSel.value;
    try{await apiPost('/api/call',body);done++}catch(e){console.error(e)}
    pf.style.width=Math.round(done/batchContacts.length*100)+'%';
    if(done<batchContacts.length)await new Promise(r=>setTimeout(r,delay*1000));
  }
  toast(`Batch done: ${done}/${batchContacts.length}`);
}

// Campaigns
async function loadCampaigns(){
  const data=await api('/api/campaigns');const t=$('camp-table');if(!t)return;
  if(!data.length){t.innerHTML='<tr><td colspan="7" class="empty">No campaigns</td></tr>';return}
  t.innerHTML=data.map(c=>`<tr>
    <td>${c.name}</td><td>${badge(c.status,c.status)}</td><td>${c.schedule_type}</td>
    <td>${c.schedule_time||'-'}</td><td>${c.total_dispatched||0}/${c.total_failed||0}</td>
    <td>${(c.last_run_at||'never').slice(0,16)}</td>
    <td><button class="btn btn-sm btn-primary" onclick="runCampaign('${c.id}')">Run</button>
    <button class="btn btn-sm btn-secondary" onclick="toggleCampaignStatus('${c.id}','${c.status==='active'?'paused':'active'}')">${c.status==='active'?'Pause':'Resume'}</button>
    <button class="btn btn-sm btn-danger" onclick="deleteCampaign('${c.id}','${c.name}')">Del</button></td></tr>`).join('');
}
let campContacts=[];
function parseCampCSV(){
  const file=$('camp-file').files[0];if(!file)return;
  const reader=new FileReader();
  reader.onload=e=>{
    const lines=e.target.result.split('\n').filter(l=>l.trim());
    const headers=lines[0].split(',').map(h=>h.trim().toLowerCase());
    campContacts=lines.slice(1).map(l=>{const cols=l.split(',');const o={};headers.forEach((h,i)=>o[h]=cols[i]?.trim());return o}).filter(c=>c.phone);
    $('camp-csv-info').textContent=campContacts.length+' contacts parsed';
  };reader.readAsText(file);
}
async function createCampaign(){
  if(!campContacts.length){toast('Parse CSV first','err');return}
  const body={name:$('camp-name').value||'Campaign',contacts:campContacts,
    schedule_type:$('camp-schedule').value,schedule_time:$('camp-time').value||'09:00',
    call_delay_seconds:parseInt($('camp-delay').value)||3};
  const ps=$('camp-agent-profile');if(ps&&ps.value)body.agent_profile_id=ps.value;
  const cp=$('camp-prompt');if(cp&&cp.value.trim())body.system_prompt=cp.value;
  try{await apiPost('/api/campaigns',body);toast('Campaign created');loadCampaigns();campContacts=[]}catch(e){toast('Failed','err')}
}
window.runCampaign=async id=>{try{await apiPost(`/api/campaigns/${id}/run`,{});toast('Running...');loadCampaigns()}catch(e){toast('Error','err')}};
window.toggleCampaignStatus=async(id,s)=>{try{await apiPatch(`/api/campaigns/${id}/status`,{status:s});loadCampaigns()}catch(e){toast('Error','err')}};
window.deleteCampaign=async(id,n)=>{if(!confirm('Delete '+n+'?'))return;try{await apiDel(`/api/campaigns/${id}`);loadCampaigns()}catch(e){toast('Error','err')}};

// Agent Profiles
let editingProfileId=null;
async function loadAgentProfiles(){
  try{
    const raw=await api('/api/agent-profiles');
    const profiles=Array.isArray(raw)?raw:[];
    const t=$('agent-table');
    if(t){
      if(!profiles.length)t.innerHTML='<tr><td colspan="6" class="empty">No profiles</td></tr>';
      else t.innerHTML=profiles.map(p=>`<tr>
        <td>${p.name}${p.is_default?' ★':''}</td><td>${p.voice}</td><td>${p.model}</td>
        <td>${p.system_prompt?'Custom':'Default'}</td>
        <td><button class="btn btn-sm btn-secondary" onclick="editAgentProfile('${p.id}')">Edit</button>
        <button class="btn btn-sm btn-primary" onclick="setDefaultAgentProfile('${p.id}','${p.name}')">★</button>
        <button class="btn btn-sm btn-danger" onclick="deleteAgentProfile('${p.id}','${p.name}')">Del</button></td></tr>`).join('');
    }
    // Populate dropdowns
    ['f-agent-profile','bc-agent-profile','camp-agent-profile'].forEach(sid=>{
      const sel=$(sid);if(!sel)return;
      const cur=sel.value;
      sel.innerHTML='<option value="">Default</option>'+profiles.map(p=>`<option value="${p.id}"${p.is_default?' selected':''}>${p.name}</option>`).join('');
      if(cur)sel.value=cur;
    });
  }catch(e){console.error(e)}
}
window.saveAgentProfile=async()=>{
  const body={name:$('ap-name').value,voice:$('ap-voice').value,model:$('ap-model').value,
    system_prompt:$('ap-prompt').value||null,enabled_tools:$('ap-tools').value||'[]',is_default:$('ap-default').checked};
  try{
    if(editingProfileId){await fetch(`/api/agent-profiles/${editingProfileId}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});toast('Updated')}
    else{await apiPost('/api/agent-profiles',body);toast('Created')}
    editingProfileId=null;$('ap-name').value='';$('ap-prompt').value='';$('ap-tools').value='[]';$('ap-default').checked=false;
    loadAgentProfiles();
  }catch(e){toast('Error','err')}
};
window.editAgentProfile=async id=>{
  const p=await api(`/api/agent-profiles/${id}`);
  $('ap-name').value=p.name;$('ap-voice').value=p.voice;$('ap-model').value=p.model;
  $('ap-prompt').value=p.system_prompt||'';$('ap-tools').value=p.enabled_tools||'[]';$('ap-default').checked=!!p.is_default;
  editingProfileId=id;switchTab('agents');
};
window.deleteAgentProfile=async(id,n)=>{if(!confirm('Delete '+n+'?'))return;await apiDel(`/api/agent-profiles/${id}`);loadAgentProfiles()};
window.setDefaultAgentProfile=async(id,n)=>{await apiPost(`/api/agent-profiles/${id}/set-default`,{});toast(n+' set as default');loadAgentProfiles()};

// Prompt
async function loadPrompt(){
  const d=await api('/api/prompt');
  $('prompt-text').value=d.prompt;
  $('prompt-status').textContent=d.is_custom?'Custom prompt active':'Using default prompt';
}
window.savePrompt=async()=>{await apiPost('/api/prompt',{prompt:$('prompt-text').value});toast('Prompt saved');loadPrompt()};
window.resetPrompt=async()=>{if(!confirm('Reset to default?'))return;await apiDel('/api/prompt');toast('Reset');loadPrompt()};

// Appointments
async function loadAppointments(){
  const df=$('apt-date')?.value||'';
  const data=await api('/api/appointments'+(df?'?date='+df:''));
  const t=$('apt-table');if(!t)return;
  if(!data.length){t.innerHTML='<tr><td colspan="7" class="empty">No appointments</td></tr>';return}
  t.innerHTML=data.map(a=>`<tr><td>${a.name}</td><td>${a.phone}</td><td>${a.date}</td><td>${a.time}</td>
    <td>${a.service}</td><td>${badge(a.status,a.status==='booked'?'booked':'not_interested')}</td>
    <td>${a.status==='booked'?`<button class="btn btn-sm btn-danger" onclick="cancelAppointment('${a.id}')">Cancel</button>`:''}</td></tr>`).join('');
}
window.cancelAppointment=async id=>{if(!confirm('Cancel?'))return;await apiDel(`/api/appointments/${id}`);toast('Cancelled');loadAppointments()};

// Call Logs
async function loadCalls(page){
  if(page)callPage=page;
  const data=await api(`/api/calls?page=${callPage}&limit=20`);
  const t=$('calls-table');if(!t)return;
  if(!data.length){t.innerHTML='<tr><td colspan="7" class="empty">No calls</td></tr>';return}
  t.innerHTML=data.map(c=>`<tr><td>${c.phone_number}</td><td>${c.lead_name||'-'}</td>
    <td>${badge(c.outcome||'unknown')}</td><td>${fmtDur(c.duration_seconds)}</td>
    <td>${(c.timestamp||'').slice(0,16)}</td>
    <td>${c.recording_url?`<a href="${c.recording_url}" target="_blank">Play</a>`:'-'}</td>
    <td><div class="inline-note"><input id="note-${c.id}" value="${(c.notes||'').replace(/"/g,'&quot;')}" placeholder="Notes...">
    <button class="btn btn-sm btn-secondary" onclick="saveNotes('${c.id}')">Save</button></div></td></tr>`).join('');
  $('calls-page').textContent='Page '+callPage;
}
window.saveNotes=async id=>{const n=$('note-'+id)?.value||'';await apiPatch(`/api/calls/${id}/notes`,{notes:n});toast('Saved')};
window.prevPage=()=>{if(callPage>1)loadCalls(callPage-1)};
window.nextPage=()=>loadCalls(callPage+1);

// CRM
async function loadCRM(){
  const d=await api('/api/crm');const t=$('crm-table');if(!t)return;
  const data=d.data||[];
  if(!data.length){t.innerHTML='<tr><td colspan="6" class="empty">No contacts</td></tr>';return}
  t.innerHTML=data.map(c=>`<tr style="cursor:pointer" onclick="loadContactDetail('${c.phone_number}')">
    <td>${c.phone_number}</td><td>${c.lead_name||'-'}</td><td>${c.total_calls}</td>
    <td>${c.booked}</td><td>${badge(c.last_outcome||'unknown')}</td>
    <td>${(c.last_call||'').slice(0,16)}</td></tr>`).join('');
}
window.loadContactDetail=async phone=>{
  const d=await api('/api/crm/calls?phone='+encodeURIComponent(phone));
  const det=$('crm-detail');if(!det)return;
  det.innerHTML=`<h3>Call History: ${phone}</h3><table><tr><th>Date</th><th>Outcome</th><th>Reason</th><th>Duration</th><th>Notes</th></tr>
    ${(d.data||[]).map(c=>`<tr><td>${(c.timestamp||'').slice(0,16)}</td><td>${badge(c.outcome||'unknown')}</td>
    <td>${c.reason||'-'}</td><td>${fmtDur(c.duration_seconds)}</td><td>${c.notes||'-'}</td></tr>`).join('')}</table>`;
};

// Settings
async function loadSettings(){
  const s=await api('/api/settings');
  const fields=['LIVEKIT_URL','LIVEKIT_API_KEY','LIVEKIT_API_SECRET','GOOGLE_API_KEY','GEMINI_MODEL','GEMINI_TTS_VOICE','USE_GEMINI_REALTIME',
    'VOBIZ_SIP_DOMAIN','VOBIZ_USERNAME','VOBIZ_PASSWORD','VOBIZ_OUTBOUND_NUMBER','OUTBOUND_TRUNK_ID','DEFAULT_TRANSFER_NUMBER',
    'TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_FROM_NUMBER',
    'S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY','S3_ENDPOINT_URL','S3_REGION','S3_BUCKET',
    'CALCOM_API_KEY','CALCOM_EVENT_TYPE_ID','CALCOM_TIMEZONE','DEEPGRAM_API_KEY'];
  fields.forEach(k=>{
    const el=$('s-'+k);if(!el)return;
    const info=s[k]||{};
    if(info.value)el.value=info.value;
    const badge=el.parentElement?.querySelector('.cfg-badge');
    if(badge)badge.textContent=info.configured?'✓':'○';
  });
}
async function saveGroup(keys){
  const settings={};
  keys.forEach(k=>{const el=$('s-'+k);if(el&&el.value)settings[k]=el.value});
  if(!Object.keys(settings).length){toast('Nothing to save','err');return}
  await apiPost('/api/settings',{settings});toast('Saved');loadSettings();
}
window.createSIPTrunk=async()=>{
  try{const r=await apiPost('/api/setup/trunk',{});toast('Trunk created: '+r.trunk_id);loadSettings()}catch(e){toast('Failed: '+e,'err')}
};

// Logs
async function loadLogs(){
  if(logsPaused)return;
  const level=$('log-level')?.value||'';
  const src=$('log-source')?.value||'';
  let url='/api/logs?limit=200';
  if(level)url+='&level='+level;if(src)url+='&source='+src;
  const data=await api(url);const c=$('log-container');if(!c)return;
  c.innerHTML=data.map(l=>`<div class="log-line"><span class="badge badge-${l.level}" style="margin-right:8px">${l.level}</span>
    <span style="color:var(--text2);margin-right:8px">${(l.timestamp||'').slice(11,19)}</span>
    <span style="color:var(--muted);margin-right:8px">[${l.source}]</span>${l.message}</div>`).join('')||'<div class="empty">No logs</div>';
}
window.clearLogs=async()=>{await apiDel('/api/logs');toast('Cleared');loadLogs()};
window.toggleLogsPause=()=>{logsPaused=!logsPaused;$('logs-pause-btn').textContent=logsPaused?'Resume':'Pause'};

function init(){
  loadStats();loadAgentProfiles();
  setInterval(loadStats,15000);
  logsInterval=setInterval(loadLogs,5000);
  document.querySelectorAll('.nav button').forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.tab)));
  $('call-form')?.addEventListener('submit',submitCall);
}
document.addEventListener('DOMContentLoaded',init);
