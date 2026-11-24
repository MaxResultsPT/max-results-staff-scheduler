import {createClient} from 'https://esm.sh/@supabase/supabase-js@2.100.0';
import {SUPABASE_URL, SUPABASE_PUBLIC_KEY} from './config.js';
const app = document.querySelector('#app');
const notice = document.querySelector('#notice');
const dialog = document.querySelector('#bookingDialog');
const tz = 'Australia/Melbourne';
const statuses = ['Unmarked','Attended','No-show','Late cancelled','Away','Rescheduled'];
const dateFormat = new Intl.DateTimeFormat('en-CA', {timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'});
const timeFormat = new Intl.DateTimeFormat('en-GB', {timeZone:tz,hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const headings = new Intl.DateTimeFormat('en-AU', {weekday:'short',day:'numeric',month:'short',timeZone:'UTC'});
const dateKey = date => {
  const parts = Object.fromEntries(dateFormat.formatToParts(date).map(part => [part.type,part.value]));
  return parts.year + '-' + parts.month + '-' + parts.day;
};
const shift = (day, amount) => new Date(Date.parse(day+'T00:00:00Z')+amount*86400000).toISOString().slice(0,10);
const today = () => dateKey(new Date());
let selected = today(), mode = 'Today', staff, members = [], team = [], colours = new Map(), db;

function node(parent, tag, value) {
  const item = document.createElement(tag);
  if (value !== undefined) item.textContent = value;
  parent.append(item);
  return item;
}
function button(parent, title, action, primary = false) {
  const element = node(parent,'button',title);
  element.type = 'button';
  if(primary) element.className='primary';
  element.onclick = () => run(action, element);
  return element;
}
async function run(action, control) {
  notice.textContent='';
  if(control) control.disabled=true;
  try { await action(); }
  catch(error) {
    const message = error.message || String(error);
    notice.textContent = message;
    if(dialog.open) {
      let feedback = dialog.querySelector('[role="alert"]');
      if(!feedback) {
        feedback = node(dialog,'p');
        feedback.setAttribute('role','alert');
      }
      feedback.textContent = message;
    }
  }
  finally { if(control) control.disabled=false; }
}
async function data(request) {
  const result=await request;
  if(result.error) throw result.error;
  return result.data;
}
function field(parent, label, type, value='') {
  const wrapper=node(parent,'label',label);
  const input=node(wrapper,'input');
  input.type=type; input.value=value;
  return input;
}
function select(parent, label, options, value) {
  const input=node(node(parent,'label',label),'select');
  for(const [key,text] of options) node(input,'option',text).value=key;
  if(value !== undefined) input.value=value;
  return input;
}
function dateRange(day) {
  if(mode!=='Team calendar') return [day];
  const monday=shift(day,-((new Date(day+'T00:00:00Z').getUTCDay()+6)%7));
  return Array.from({length:7},(_,index)=>shift(monday,index));
}
async function bookings(first, last) {
  const result = await data(db.from('sessions').select('*,roster(member_id,status,members(name))')
    .gte('starts',shift(first,-1)+'T00:00:00Z').lt('starts',shift(last,1)+'T00:00:00Z')
    .order('starts').limit(1000));
  return result.filter(item=>{
    const day=dateKey(new Date(item.starts));
    return day>=first && day<=last;
  });
}
async function login() {
  app.replaceChildren();
  const form=node(app,'form'); form.className='login panel';
  node(form,'h2','Staff sign in');
  const email=field(form,'Email','email'); email.autocomplete='username'; email.required=true;
  const password=field(form,'Password','password'); password.autocomplete='current-password'; password.required=true;
  const submit=node(form,'button','Sign in'); submit.className='primary';
  form.onsubmit=event=>{
    event.preventDefault();
    run(async()=>{
      await data(db.auth.signInWithPassword({email:email.value.trim(),password:password.value}));
      await start();
    },submit);
  };
}
async function start(){
  const {session}=await data(db.auth.getSession());
  if(!session) return login();
  staff=await data(db.from('staff').select('id,name,role').eq('id',session.user.id).maybeSingle());
  if(!staff || !['owner','trainer'].includes(staff.role)){
    await db.auth.signOut(); login(); notice.textContent='This account has no staff access.'; return;
  }
  mode='Today'; selected=today();
  await render();
}
async function render(){
  const owner=staff.role==='owner';
  const days=dateRange(selected);
  const calendar=mode==='Team calendar';
  const sessions=calendar
    ? await data(db.rpc('team_calendar',{first_day:days[0],last_day:days.at(-1)}))
    : (await bookings(days[0],days[0])).filter(item=>item.trainer===staff.id && !item.cancelled);
  if(owner) [members,team]=await Promise.all([
    data(db.from('members').select('id,name').order('name')),
    data(db.from('staff').select('id,name,role').in('role',['owner','trainer']).order('name'))
  ]);
  if(calendar || owner){
    const savedColours=await data(db.rpc('trainer_calendar_colours'));
    colours=new Map(savedColours.map(item=>[item.trainer_id,item.colour]));
  }
  app.replaceChildren();
  const nav=node(app,'nav');
  const date=field(nav,'Schedule date','date',selected);
  date.onchange=()=>{if(date.value) run(async()=>{selected=date.value;await render();});};
  for(const view of ['My sessions','Team calendar']){
    const tab=button(nav,view,async()=>{
      mode=view==='Team calendar'?view:'Today';
      if(mode==='Today') selected=today();
      await render();
    });
    tab.setAttribute('aria-pressed',String(calendar===(view==='Team calendar')));
  }
  if(owner){
    button(nav,'New booking',()=>editBooking(),true);
    button(nav,'Add member',addMember);
    button(nav,'Trainer colours',editTrainerColour);
  }
  button(nav,'Sign out',async()=>{await data(db.auth.signOut());await login();});
  if(calendar){
    renderCalendar(days,sessions,owner);
    return;
  }
  const grid=node(app,'div'); grid.className='grid';
  for(const day of days){
    const panel=node(grid,'article'); panel.className='day stack';
    node(panel,'h2',headings.format(new Date(day+'T00:00:00Z')));
    const entries=sessions.filter(item=>dateKey(new Date(item.starts))===day);
    if(!entries.length) node(panel,'p','No sessions scheduled.').className='muted';
    const now=Date.now();
    const upcoming=entries.filter(item=>Date.parse(item.starts)>now);
    const started=entries.filter(item=>Date.parse(item.starts)<=now);
    for(const [title,group] of [['Upcoming',upcoming],['Started or completed',started]]){
      if(!group.length) continue;
      node(panel,'h3',title);
      for(const session of group) showBooking(panel,session,owner);
    }
  }
}
function canMarkSession(session){
  return !session.cancelled && Date.parse(session.starts)<=Date.now();
}
function showBooking(panel,session,owner){
  const card=node(panel,'details');card.className='booking';
  const start=new Date(session.starts);
  const pending=session.roster.filter(member=>member.status==='Unmarked').length;
  node(card,'summary',timeFormat.format(start)+' · '+session.capacity+':1 · '+
    (session.cancelled?'Cancelled':pending?pending+' to mark':session.roster.length?'Complete':'Empty roster'));
  if(canMarkSession(session) && pending) card.open=true;
  node(card,'p',session.duration+' min · '+(team.find(person=>person.id===session.trainer)?.name||staff.name)+
    ' · '+(session.capacity-session.roster.length)+' spare').className='muted';
  const roll=node(card,'div');roll.className='roll';
  const picks=session.roster.map(member=>({
    member_id:member.member_id,
    select:select(roll,member.members?.name||'Member',statuses.map(status=>[status,status]),member.status)
  }));
  const canMark=canMarkSession(session);
  for(const pick of picks) pick.select.disabled=!canMark;
  const actions=node(card,'div');actions.className='actions';
  if(canMark && picks.length){
    button(actions,'Mark unmarked attended',()=>picks.filter(pick=>pick.select.value==='Unmarked')
      .forEach(pick=>{pick.select.value='Attended';}));
    button(actions,'Save roll call',async()=>{
      await data(db.rpc('mark_roll',{booking:session.id,marks:picks.map(pick=>({
        member_id:pick.member_id,status:pick.select.value
      }))}));
      await render();notice.textContent='Roll call saved.';
    },true);
  }
  if(owner && !session.cancelled) button(actions,'Edit booking',()=>editBooking(session));
}
const trainerPalette=[
  ['#e1efff','#16559c'],['#e4f5ec','#156044'],['#fce5ed','#982d59'],
  ['#f2e7ff','#6e389d'],['#fff0d8','#885311'],['#dbf5f6','#12626b'],
  ['#ffe6dd','#973e26'],['#eef2ce','#526000']
];
function trainerColour(index){
  if(index<trainerPalette.length) return trainerPalette[index];
  const hue=(index*137.508)%360;
  return ['hsl('+hue+' 70% 91%)','hsl('+hue+' 65% 28%)'];
}
function minutesAt(date){
  const [hours,minutes]=timeFormat.format(date).split(':').map(Number);
  return hours*60+minutes;
}
function renderCalendar(days,sessions,owner){
  const controls=node(app,'div');controls.className='actions';
  button(controls,'Previous week',async()=>{selected=shift(days[0],-7);await render();});
  node(controls,'strong',headings.format(new Date(days[0]+'T00:00:00Z'))+' – '+
    headings.format(new Date(days[6]+'T00:00:00Z')));
  button(controls,'Next week',async()=>{selected=shift(days[0],7);await render();});
  const legend=node(app,'div');legend.className='calendar-legend';
  const trainers=new Map(sessions.map(item=>[item.trainer_id,item]));
  for(const trainer of [...trainers.values()].sort((a,b)=>a.trainer_name.localeCompare(b.trainer_name))){
    const tag=node(legend,'span',trainer.trainer_name);applyColour(tag,trainer.trainer_id,trainer.colour_index);
  }
  const events=sessions.map(session=>({
    ...session,day:dateKey(new Date(session.starts)),minute:minutesAt(new Date(session.starts))
  }));
  const first=Math.floor(Math.min(360,...events.map(item=>item.minute))/60)*60;
  const last=Math.min(1440,Math.ceil(Math.max(1200,...events.map(item=>item.minute+item.duration))/60)*60);
  const frame=node(app,'div');frame.className='calendar-frame';
  const grid=node(frame,'section');grid.className='week-calendar';
  grid.setAttribute('aria-label','Weekly team timetable, Melbourne time');
  node(grid,'div','Time').className='calendar-heading';
  for(const day of days){
    const title=node(grid,'div',headings.format(new Date(day+'T00:00:00Z')));
    title.className='calendar-heading'+(day===today()?' current-day':'');
  }
  const clock=node(grid,'div');clock.className='clock';
  for(let minute=first;minute<last;minute+=60){
    const time=node(clock,'span',String(Math.floor(minute/60)).padStart(2,'0')+':00');
    time.style.top=(minute-first)+'px';
  }
  for(const day of days){
    const column=node(grid,'div');column.className='calendar-day';
    column.style.height=(last-first)+'px';
    const groups=[];
    for(const event of events.filter(item=>item.day===day).sort((a,b)=>a.minute-b.minute)){
      const end=event.minute+Math.max(event.duration,34);
      let group=groups.at(-1);
      if(!group || event.minute>=group.end){
        group={lanes:[],entries:[],end};groups.push(group);
      }
      let lane=group.lanes.findIndex(value=>value<=event.minute);
      if(lane<0) lane=group.lanes.length;
      group.lanes[lane]=end;
      group.entries.push({...event,lane});
      group.end=Math.max(group.end,end);
    }
    for(const group of groups){
      for(const event of group.entries){
        const label=timeFormat.format(new Date(event.starts))+' · '+event.trainer_name+' · '+event.capacity+':1';
        const card=owner?button(column,label,async()=>{
          const session=await data(db.from('sessions').select('*,roster(member_id,status,members(name))').eq('id',event.id).single());
          editBooking(session);
        }):node(column,'div',label);
        card.className='calendar-event';
        card.title=label;
        card.style.top=(event.minute-first)+'px';
        card.style.height=Math.min(last-event.minute,Math.max(event.duration,34))+'px';
        card.style.left=(100*event.lane/group.lanes.length)+'%';
        card.style.width=(100/group.lanes.length)+'%';
        applyColour(card,event.trainer_id,event.colour_index);
      }
    }
  }
}
function applyColour(element,id,index){
  const background=colours.get(id)||trainerColour(index)[1];
  element.style.setProperty('--event-bg',background);
  element.style.setProperty('--event-ink',colourText(background));
}
function colourText(background){
  if(!background.startsWith('#')) return '#ffffff';
  const channels=[1,3,5].map(offset=>parseInt(background.slice(offset,offset+2),16)/255);
  const [r,g,b]=channels.map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);
  return .2126*r+.7152*g+.0722*b>.179?'#000000':'#ffffff';
}
function editTrainerColour(){
  dialog.replaceChildren();
  const form=node(dialog,'form');
  node(form,'h2','Trainer colours');
  const trainer=select(form,'Trainer',team.map(person=>[person.id,person.name]));
  const colour=field(form,'Calendar colour','color');
  const sync=()=>{colour.value=colours.get(trainer.value)||'#16559c';};
  trainer.onchange=sync;
  sync();
  async function save(value){
    await data(db.rpc('set_trainer_colour',{target:trainer.value,colour:value}));
    dialog.close();
    await render();
    notice.textContent='Trainer colour saved.';
  }
  button(form,'Save colour',()=>save(colour.value),true);
  button(form,'Use automatic colour',()=>save(null));
  button(form,'Close',()=>dialog.close());
  dialog.showModal();
}
function addMember(){
  dialog.replaceChildren();
  const form=node(dialog,'form');node(form,'h2','Add member to booking roster');
  const name=field(form,'Member name','text');name.required=true;
  button(form,'Save member',async()=>{
    if(!form.reportValidity() || !name.value.trim()) return;
    await data(db.from('members').insert({name:name.value.trim()}));
    dialog.close();await render();
  },true);
  button(form,'Close',()=>dialog.close());
  dialog.showModal();
}
function editBooking(session){
  dialog.replaceChildren();
  const form=node(dialog,'form');node(form,'h2',session?'Edit booking':'New booking');
  const slots=node(form,'div');slots.className='row';
  const day=field(slots,'Date','date',session?dateKey(new Date(session.starts)):selected);
  const time=field(slots,'Start time','time',session?timeFormat.format(new Date(session.starts)):'06:00');
  const duration=field(slots,'Minutes','number',session?.duration??45);duration.min=5;duration.max=240;
  for(const input of [day,time,duration]) input.required=true;
  const trainer=select(form,'Trainer',team.map(person=>[person.id,person.name]),session?.trainer);
  const capacity=select(form,'Session size',[['1','1:1'],['3','3:1'],['6','6:1']],session?.capacity??3);
  const repeat=session?null:field(form,'Number of weekly occurrences','number',1);
  if(repeat){repeat.min=1;repeat.max=52;repeat.required=true;}
  const scope=session?.series_id?select(form,'Apply to',[['one','This session'],['following','This and future sessions']]):null;
  const roster=node(form,'div');roster.className='stack';
  const initial=session?.roster.map(member=>member.member_id)||[];
  let picks=[];
  function drawRoster(current){
    roster.replaceChildren();
    picks=Array.from({length:Number(capacity.value)},(_,index)=>select(roster,'Spot '+(index+1),
      [['','Spare'],...members.map(member=>[member.id,member.name])],current[index]??''));
  }
  drawRoster(initial);
  capacity.onchange=()=>drawRoster(picks.map(pick=>pick.value));
  const actions=node(form,'div');actions.className='actions';
  button(actions,'Save booking',async()=>{
    if(!form.reportValidity()) return;
    await data(db.rpc('save_booking',{booking:session?.id??null,following:scope?.value==='following',
      trainer_id:trainer.value,local_start:day.value+'T'+time.value,minutes:Number(duration.value),
      places:Number(capacity.value),member_ids:picks.map(pick=>pick.value).filter(Boolean).map(Number),
      repeat_weeks:repeat?Number(repeat.value):1}));
    selected=day.value;dialog.close();await render();
  },true);
  if(session) button(actions,'Cancel booking',async()=>{
    if(!confirm(scope?.value==='following'?'Cancel this session and future sessions?':'Cancel this session?')) return;
    await data(db.rpc('cancel_booking',{booking:session.id,following:scope?.value==='following'}));
    dialog.close();await render();
  });
  button(actions,'Close',()=>dialog.close());
  dialog.showModal();
}
if(SUPABASE_URL && SUPABASE_PUBLIC_KEY){
  db=createClient(SUPABASE_URL,SUPABASE_PUBLIC_KEY);
  run(start);
}else{
  node(app,'p','Set the Supabase URL and public key in config.js to connect this staff app.');
}
