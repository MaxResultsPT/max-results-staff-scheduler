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
  const result = await data(db.from('sessions').select('*,roster(member_id,status,moved_booking,members(name))')
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
async function loadMembers(){
  const all=[];
  const pageSize=200;
  for(let offset=0;;offset+=pageSize){
    const page=await data(db.from('members').select('id,name,archived')
      .order('name').order('id').range(offset,offset+pageSize-1));
    all.push(...page);
    if(page.length<pageSize) return all;
  }
}
async function render(){
  const owner=staff.role==='owner';
  const days=dateRange(selected);
  const calendar=mode==='Team calendar';
  const sessions=calendar
    ? await data(db.rpc('calendar_sessions_with_moves',{first_day:days[0],last_day:days.at(-1)}))
    : (await bookings(days[0],days[0])).filter(item=>item.trainer===staff.id && !item.cancelled);
  if(owner) [members,team]=await Promise.all([
    loadMembers(),
    data(db.from('staff').select('id,name,role').in('role',['owner','trainer']).order('name'))
  ]);
  if(calendar || owner){
    const savedColours=await data(db.rpc('trainer_calendar_colours'));
    colours=new Map(savedColours.map(item=>[item.trainer_id,item.colour]));
  }
  const repeatConflicts=owner?await data(db.rpc('weekly_repeat_conflicts')):[];
  app.replaceChildren();
  const nav=node(app,'nav');
  const date=field(nav,'Schedule date','date',selected);
  date.onchange=()=>{if(date.value) run(async()=>{selected=date.value;await render();});};
  const views=node(nav,'div'); views.className='view-tabs';
  for(const view of ['My sessions','Team calendar']){
    const tab=button(views,view,async()=>{
      mode=view==='Team calendar'?view:'Today';
      if(mode==='Today') selected=today();
      await render();
    });
    tab.setAttribute('aria-pressed',String(calendar===(view==='Team calendar')));
  }
  if(owner) button(nav,'New booking',()=>editBooking(),true);
  const options=node(nav,'details'); options.className='schedule-menu';
  node(options,'summary',owner?'Manage':'Account');
  const menu=node(options,'div'); menu.className='actions';
  if(owner){
    button(menu,'Add class',()=>editClass());
    button(menu,'Recurring spare spots',showSpareSpots);
    button(menu,'Weekly training hours',showWeeklyTrainingHours);
    button(menu,'Member statistics',showMemberStatistics);
    button(menu,'Manage members',manageMembers);
    button(menu,'Set member away',setMemberAway);
    button(menu,'Manage users',manageUsers);
  }
  button(menu,'Sign out',async()=>{await data(db.auth.signOut());await login();});
  for(const conflict of repeatConflicts){
    const date=new Date(conflict.blocked_at);
    node(app,'p','Weekly repeat paused for '+conflict.trainer_name+' on '+dateKey(date)
      +' at '+timeFormat.format(date)+' because another booking overlaps.').className='repeat-warning';
  }
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
  if(session.class_name){
    node(card,'summary',timeFormat.format(start)+' · '+session.class_name+' · Class');
    node(card,'p',session.duration+' min · Calendar only').className='muted';
    if(owner) button(card,'Edit class',()=>editClass(session));
    return;
  }
  const away=session.roster.filter(member=>member.status==='Away');
  const moved=session.roster.filter(member=>member.status==='Rescheduled');
  const occupied=session.roster.length-away.length-moved.length;
  const pending=session.roster.filter(member=>member.status==='Unmarked').length;
  node(card,'summary',timeFormat.format(start)+' · '+session.capacity+':1 · '+
    (session.cancelled?'Cancelled':pending?pending+' to mark':session.roster.length?'Complete':'Empty roster')+
    (away.length?' · Away: '+away.map(member=>member.members?.name||'Member').join(', '):'')+
    (moved.length?' · Rescheduled: '+moved.map(member=>member.members?.name||'Member').join(', '):''));
  if(canMarkSession(session) && pending) card.open=true;
  node(card,'p',session.duration+' min · '+(team.find(person=>person.id===session.trainer)?.name||staff.name)+
    ' · '+Math.max(0,session.capacity-occupied)+' spare').className='muted';
  const roll=node(card,'div');roll.className='roll';
  const picks=session.roster.map(member=>({
    member_id:member.member_id,
    select:select(roll,member.members?.name||'Member',statuses.map(status=>[status,status]),member.status),
    moved:member.moved_booking
  }));
  const canMark=canMarkSession(session);
  for(const pick of picks) pick.select.disabled=!canMark || pick.moved;
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
  if(owner && !session.cancelled){
    if(occupied<session.capacity+1) button(actions,occupied<session.capacity?'Add one-off member':'Add extra member',
      ()=>addOneOffMember(session.id,session.roster,occupied>=session.capacity));
    button(actions,'Edit booking',()=>editBooking(session));
  }
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
  const controls=node(app,'div');controls.className='actions week-controls';
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
  renderPhoneCalendar(events,owner);
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
    const groups=calendarLanes(events.filter(item=>item.day===day),34);
    for(const group of groups){
      for(const event of group.entries){
        const label=timeFormat.format(new Date(event.starts))+' · '+event.trainer_name+' · '+sessionKind(event);
        const card=calendarCard(column,label,event,owner);
        card.className='calendar-event';
        card.title=event.class_name?label:label+' — '+rosterText(event);
        card.style.top=(event.minute-first)+'px';
        card.style.height=Math.min(last-event.minute,Math.max(event.duration,34))+'px';
        card.style.left=(100*event.lane/group.lanes.length)+'%';
        card.style.width=(100/group.lanes.length)+'%';
        applyColour(card,event.trainer_id,event.colour_index);
      }
    }
  }
}
function calendarLanes(events,minimumMinutes=0){
  const groups=[];
  for(const event of [...events].sort((a,b)=>a.minute-b.minute||b.duration-a.duration)){
    const end=event.minute+Math.max(event.duration,minimumMinutes);
    let group=groups.at(-1);
    if(!group || event.minute>=group.end){
      group={lanes:[],entries:[],end};
      groups.push(group);
    }
    let lane=group.lanes.findIndex(value=>value<=event.minute);
    if(lane<0) lane=group.lanes.length;
    group.lanes[lane]=end;
    group.entries.push({...event,lane});
    group.end=Math.max(group.end,end);
  }
  return groups;
}
function sessionKind(event){
  return event.class_name ? event.class_name+' (class)' : event.capacity+':1';
}
function rosterText(event){
  if(event.class_name) return '';
  const names=event.member_names?.length ? event.member_names.join(', ') : 'No members booked';
  return names+(event.absence_labels?.length?' · Away / moved: '+event.absence_labels.join(', '):'');
}
function calendarCard(parent,label,event,owner){
  const card=button(parent,label,()=>showCalendarRoster(label,event,owner));
  if(!event.class_name) node(card,'span',rosterText(event)).className='calendar-roster';
  return card;
}
function showCalendarRoster(label,event,owner){
  dialog.replaceChildren();
  node(dialog,'h2',label);
  if(event.class_name){
    node(dialog,'p','Calendar only');
  }else if(event.member_names?.length){
    const list=node(dialog,'ul');
    for(const name of event.member_names) node(list,'li',name);
  }else{
    node(dialog,'p','No members booked');
  }
  if(event.absence_labels?.length) node(dialog,'p','Away / moved: '+event.absence_labels.join(', '));
  const actions=node(dialog,'div'); actions.className='actions';
  if(owner && event.class_name) button(actions,'Edit class',async()=>{
    const session=await data(db.from('sessions').select('id,class_name,starts,duration,trainer,series_id').eq('id',event.id).single());
    dialog.close();
    editClass(session);
  },true);
  if(owner && !event.class_name) button(actions,'Edit booking',async()=>{
    const session=await data(db.from('sessions').select('*,roster(member_id,status,moved_booking,members(name))').eq('id',event.id).single());
    dialog.close();
    editBooking(session);
  },true);
  if(owner && !event.class_name && event.occupied<event.capacity+1) button(actions,
    event.available?'Add one-off member':'Add extra member',async()=>{
    const roster=await data(db.from('roster').select('member_id').eq('session_id',event.id));
    dialog.close();
    addOneOffMember(event.id,roster,event.available===0);
  });
  button(actions,'Close',()=>dialog.close());
  dialog.showModal();
}
function renderPhoneCalendar(events,owner){
  const section=node(app,'section'); section.className='phone-calendar';
  section.setAttribute('aria-label','Team timetable by day');
  const controls=node(section,'div'); controls.className='day-controls';
  button(controls,'Previous day',async()=>{selected=shift(selected,-1);await render();});
  button(controls,'Next day',async()=>{selected=shift(selected,1);await render();});
  node(section,'h2',headings.format(new Date(selected+'T00:00:00Z')));
  const daily=events.filter(event=>event.day===selected);
  if(!daily.length){
    node(section,'p','No sessions scheduled.').className='muted';
    return;
  }
  const first=Math.floor(Math.min(...daily.map(event=>event.minute))/60)*60;
  const last=Math.ceil(Math.max(...daily.map(event=>event.minute+event.duration))/60)*60;
  const hourHeight=84;
  const pixels=minutes=>minutes*hourHeight/60;
  const grid=node(section,'div');grid.className='phone-time-grid';
  grid.style.setProperty('--hour-height',hourHeight+'px');
  const clock=node(grid,'div');clock.className='phone-clock';
  const column=node(grid,'div');column.className='phone-time-column';
  column.style.height=pixels(last-first)+'px';
  for(let minute=first;minute<last;minute+=60){
    const hour=Math.floor(minute/60)%24;
    const tick=node(clock,'span',(hour%12||12)+(hour<12?' am':' pm'));
    tick.style.top=pixels(minute-first)+'px';
  }
  for(const group of calendarLanes(daily)){
    for(const event of group.entries){
      const start=new Date(event.starts);
      const end=new Date(+start+event.duration*60000);
      const time=timeFormat.format(start)+'–'+timeFormat.format(end);
      const title=event.class_name||event.trainer_name+' · '+sessionKind(event);
      const label=time+' · '+event.trainer_name+' · '+sessionKind(event);
      const card=button(column,undefined,()=>showCalendarRoster(label,event,owner));
      card.className='phone-event';
      card.setAttribute('aria-label',label+(event.class_name?'':' · '+rosterText(event)));
      node(card,'strong',title);
      if(event.class_name) node(card,'span',event.trainer_name).className='phone-event-detail';
      else node(card,'span',rosterText(event)).className='phone-event-detail';
      card.style.top=pixels(event.minute-first)+'px';
      card.style.height=pixels(event.duration)+'px';
      card.style.left=(100*event.lane/group.lanes.length)+'%';
      card.style.width=(100/group.lanes.length)+'%';
      applyColour(card,event.trainer_id,event.colour_index);
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
async function userManagement(payload){
  const {session}=await data(db.auth.getSession());
  if(!session) throw new Error('Sign in again.');
  const endpoint=SUPABASE_URL.replace(/\/$/,'')+'/functions/v1/create-trainer';
  const response=await fetch(endpoint,{
    method:'POST',
    headers:{Authorization:'Bearer '+session.access_token,apikey:SUPABASE_PUBLIC_KEY,
      'Content-Type':'application/json'},
    body:JSON.stringify(payload)
  });
  const result=await response.json().catch(()=>null);
  if(!response.ok) throw new Error(response.status===404
    ? 'Deploy the create-trainer Edge Function in Supabase first.'
    : result?.error||'Could not manage the staff account.');
  return result;
}

async function manageUsers(){
  const {users}=await userManagement({action:'list'});
  dialog.replaceChildren();
  node(dialog,'h2','Manage users');
  const actions=node(dialog,'div');actions.className='actions';
  button(actions,'Add trainer',addTrainer,true);
  button(actions,'Close',()=>dialog.close());
  const list=node(dialog,'div');list.className='stack';
  for(const user of users){
    const card=node(list,'article');card.className='user-card';
    node(card,'h3',user.name+(user.id===staff.id?' (you)':''));
    node(card,'p',(user.email||'No login email')+' · '+(user.role==='owner'?'Owner':'Trainer'));
    const colour=node(card,'span',user.calendar_colour||'Automatic colour');
    colour.className='user-colour';
    applyColour(colour,user.id,user.colour_index);
    if(user.role==='trainer' || user.id===staff.id){
      const tools=node(card,'div');tools.className='actions';
      button(tools,'Edit name or colour',()=>editUserProfile(user));
      button(tools,'Reset password',()=>resetUserPassword(user));
    }
  }
  if(!dialog.open) dialog.showModal();
}
function editUserProfile(user){
  dialog.replaceChildren();
  const form=node(dialog,'form');
  node(form,'h2','Edit staff profile');
  const name=field(form,'Display name','text',user.name);
  name.required=true;name.maxLength=100;
  const mode=select(form,'Colour mode',[['auto','Automatic'],['custom','Custom']],user.calendar_colour?'custom':'auto');
  const colour=field(form,'Calendar colour','color',user.calendar_colour||'#16559c');
  const toggle=()=>{colour.disabled=mode.value==='auto';};
  mode.onchange=toggle;toggle();
  button(form,'Save profile',async()=>{
    if(!form.reportValidity()) return;
    await userManagement({action:'update',id:user.id,name:name.value,colour:mode.value==='custom'?colour.value:null});
    if(staff.id===user.id) staff.name=name.value.trim();
    await render();
    await manageUsers();
    notice.textContent='Staff profile saved.';
  },true);
  button(form,'Back to users',manageUsers);
}
function resetUserPassword(user){
  dialog.replaceChildren();
  const form=node(dialog,'form');
  node(form,'h2','Reset password');
  node(form,'p',user.name+' · '+(user.email||'No login email'));
  const password=field(form,'New password (at least 12 characters)','password');
  password.required=true;password.minLength=12;password.maxLength=72;password.autocomplete='new-password';
  button(form,'Save new password',async()=>{
    if(!form.reportValidity()) return;
    if(!confirm('Set a new password for '+user.name+'?')) return;
    await userManagement({action:'reset',id:user.id,password:password.value});
    password.value='';
    await manageUsers();
    notice.textContent='Password updated. Use the new password for the next sign-in.';
  },true);
  button(form,'Back to users',manageUsers);
}
function addTrainer(){
  dialog.replaceChildren();
  const form=node(dialog,'form');
  node(form,'h2','Add trainer');
  const name=field(form,'Display name','text');
  const email=field(form,'Email (used to sign in)','email');
  const password=field(form,'Password (at least 12 characters)','password');
  name.maxLength=100;email.maxLength=254;password.minLength=12;password.maxLength=72;
  password.autocomplete='new-password';
  for(const input of [name,email,password]) input.required=true;
  const submit=node(form,'button','Create trainer');submit.type='submit';submit.className='primary';
  const back=button(form,'Back to users',manageUsers);
  form.onsubmit=event=>{
    event.preventDefault();
    run(async()=>{
      back.disabled=true;
      try{
        const result=await userManagement({action:'create',name:name.value,email:email.value,password:password.value});
        password.value='';
        await render();
        await manageUsers();
        notice.textContent=result.name+' can now sign in with the email and password you set.';
      }finally{back.disabled=false;}
    },submit);
  };
}
function setMemberAway(){
  dialog.replaceChildren();
  const form=node(dialog,'form');node(form,'h2','Set member away');
  const member=select(form,'Member',[['','Choose a member'],...members.filter(person=>!person.archived).map(person=>[person.id,person.name])]);
  const first=field(form,'First day away','date',today());
  const last=field(form,'Last day away (inclusive)','date',today());
  for(const input of [member,first,last]) input.required=true;
  button(form,'Save away dates',async()=>{
    if(!form.reportValidity()) return;
    if(last.value<first.value) throw new Error('Last day must be on or after the first day.');
    const updated=await data(db.rpc('set_member_away',{person:Number(member.value),from_day:first.value,to_day:last.value}));
    dialog.close();await render();
    notice.textContent='Away dates saved. '+updated+' existing roll call'+(updated===1?'':'s')+' updated.';
  },true);
  button(form,'Close',()=>dialog.close());
  dialog.showModal();
}
function addOneOffMember(booking,roster,extra=false){
  dialog.replaceChildren();
  const form=node(dialog,'form');node(form,'h2',extra?'Add extra member':'Add one-off member');
  node(form,'p',extra?'This adds one person above the usual capacity for this session only.':'This booking only.');
  const booked=new Set(roster.map(person=>person.member_id));
  const choices=members.filter(person=>!person.archived && !booked.has(person.id));
  const member=select(form,'Member',[['','Choose a member'],...choices.map(person=>[person.id,person.name])]);
  member.required=true;
  button(form,'Add to session',async()=>{
    if(!form.reportValidity()) return;
    await data(db.rpc('add_session_member',{booking,person:Number(member.value),allow_extra:extra}));
    dialog.close();await render();
    notice.textContent='Member added to this session.';
  },true);
  button(form,'Close',()=>dialog.close());
  dialog.showModal();
}
function manageMembers(){
  dialog.replaceChildren();
  node(dialog,'h2','Manage members');
  const actions=node(dialog,'div');actions.className='actions';
  button(actions,'Add member',addMember,true);
  button(actions,'Close',()=>dialog.close());
  const search=field(dialog,'Search members','search');
  const list=node(dialog,'div');list.className='stack member-list';
  function show(){
    list.replaceChildren();
    const query=search.value.trim().toLowerCase();
    const matches=members.filter(person=>person.name.toLowerCase().includes(query));
    if(!matches.length) node(list,'p','No members found.');
    for(const person of matches){
      const card=node(list,'article');card.className='user-card';
      node(card,'h3',person.name+(person.archived?' (archived)':''));
      const tools=node(card,'div');tools.className='actions';
      const update=async operation=>{
        if(operation==='delete' && !confirm('Permanently delete '+person.name+'?')) return;
        if(operation==='archive' && !confirm('Archive '+person.name+'? Existing bookings and attendance will be kept.')) return;
        await data(db.rpc('manage_member',{person:person.id,operation}));
        members=await loadMembers();
        const error=dialog.querySelector('[role="alert"]');
        if(error) error.remove();
        show();
      };
      if(!person.archived) button(tools,'Reschedule',()=>showMemberReschedule(person));
      button(tools,person.archived?'Restore':'Archive',()=>update(person.archived?'restore':'archive'));
      button(tools,'Delete',()=>update('delete'));
    }
  }
  search.oninput=show;
  show();
  if(!dialog.open) dialog.showModal();
}
function addMember(){
  dialog.replaceChildren();
  const form=node(dialog,'form');node(form,'h2','Add member to booking roster');
  const name=field(form,'Member name','text');name.required=true;
  button(form,'Save member',async()=>{
    if(!form.reportValidity() || !name.value.trim()) return;
    await data(db.from('members').insert({name:name.value.trim()}));
    members=await loadMembers();
    manageMembers();
  },true);
  button(form,'Back to members',manageMembers);
}
function editClass(session){
  dialog.replaceChildren();
  const form=node(dialog,'form');
  node(form,'h2',session?'Edit class':'Add class');
  const title=field(form,'Class name','text',session?.class_name||'');
  title.required=true;title.maxLength=100;
  const day=field(form,'Date','date',session?dateKey(new Date(session.starts)):selected);
  const time=field(form,'Start time','time',session?timeFormat.format(new Date(session.starts)):'06:00');
  const duration=field(form,'Minutes','number',session?.duration??45);
  duration.min=5;duration.max=240;
  for(const input of [day,time,duration]) input.required=true;
  const instructor=select(form,'Trainer',team.map(person=>[person.id,person.name]),session?.trainer);
  const repeat=session?.series_id?null:select(form,'Repeat',[
    ['once','One class'],['weekly','Repeat weekly until cancelled']
  ]);
  const scope=session?.series_id?select(form,'Apply to',[
    ['one','This class'],['following','This and future classes']
  ]):null;
  button(form,'Save class',async()=>{
    if(!form.reportValidity()) return;
    await data(db.rpc('save_calendar_class',{booking:session?.id??null,title:title.value,instructor:instructor.value,
      local_start:day.value+'T'+time.value,minutes:Number(duration.value),
      repeat_weekly:repeat?.value==='weekly',following:scope?.value==='following'}));
    selected=day.value;mode='Team calendar';dialog.close();await render();
  },true);
  if(session) button(form,'Cancel class',async()=>{
    const following=scope?.value==='following';
    if(!confirm(following?'Cancel this class and future classes?':'Cancel this class?')) return;
    await data(db.rpc('cancel_booking',{booking:session.id,following}));
    dialog.close();await render();
  });
  button(form,'Close',()=>dialog.close());
  dialog.showModal();
}

function mondayOf(day){
  const weekday=new Date(day+'T00:00:00Z').getUTCDay();
  return shift(day,-((weekday+6)%7));
}

function formatTrainingMinutes(minutes){
  return Math.floor(minutes/60)+' h '+String(minutes%60).padStart(2,'0')+' min';
}

async function showWeeklyTrainingHours(){
  let week=mondayOf(today());
  dialog.replaceChildren();
  node(dialog,'h2','Weekly training hours');
  node(dialog,'p','Scheduled PT and class time, Monday to Sunday in Melbourne.');
  const date=field(dialog,'Choose a date in the week','date',week);
  const actions=node(dialog,'div');actions.className='actions';
  const previous=button(actions,'Previous week',()=>load(shift(week,-7)));
  const next=button(actions,'Next week',()=>load(shift(week,7)));
  const results=node(dialog,'section');
  results.setAttribute('aria-live','polite');
  button(dialog,'Close',()=>dialog.close());
  date.onchange=()=>{if(date.value) run(()=>load(mondayOf(date.value)));};
  async function load(requested){
    previous.disabled=next.disabled=date.disabled=true;
    try{
      const rows=await data(db.rpc('weekly_pt_hours',{week_start:requested}));
      week=requested;
      date.value=week;
      results.replaceChildren();
      const describe=day=>headings.format(new Date(day+'T00:00:00Z'));
      node(results,'h3',describe(week)+' – '+describe(shift(week,6)));
      const list=node(results,'dl');list.className='attendance-stats';
      let total=0;
      for(const row of rows){
        const minutes=Number(row.total_minutes);
        total+=minutes;
        node(list,'dt',row.trainer_name+' · '+row.session_count+' '+(Number(row.session_count)===1?'session':'sessions'));
        node(list,'dd',formatTrainingMinutes(minutes));
      }
      node(list,'dt','Total training hours');
      node(list,'dd',formatTrainingMinutes(total));
    }finally{
      previous.disabled=next.disabled=date.disabled=false;
    }
  }
  dialog.showModal();
  await load(week);
}

async function showSpareSpots(){
  const sessions=await data(db.rpc('recurring_spare_spots'));
  const weekdays=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const groups=weekdays.map(()=>[]);
  for(const item of sessions){
    if(item.regular_spare<=0) continue;
    const date=new Date(item.starts);
    const day=(new Date(dateKey(date)+'T00:00:00Z').getUTCDay()+6)%7;
    groups[day].push({...item,time:timeFormat.format(date)});
  }
  dialog.replaceChildren();
  node(dialog,'h2','Recurring spare spots');
  const list=node(dialog,'div');list.className='stack';
  if(groups.every(group=>!group.length)) node(list,'p','No regular spare spots.');
  groups.forEach((group,index)=>{
    if(!group.length) return;
    const section=node(list,'section');
    node(section,'h3',weekdays[index]);
    const slots=node(section,'ul');
    for(const item of group.sort((a,b)=>a.time.localeCompare(b.time)||a.trainer_name.localeCompare(b.trainer_name))){
      node(slots,'li',item.time+' · '+item.trainer_name+' · '+item.capacity+':1 · '+
        item.regular_spare+' spare '+(item.regular_spare===1?'spot':'spots'));
    }
  });
  button(dialog,'Close',()=>dialog.close());
  dialog.showModal();
}

async function showMemberReschedule(person){
  const sources=await data(db.rpc('member_reschedule_options',{person:person.id}));
  dialog.replaceChildren();
  const form=node(dialog,'form');
  node(form,'h2','Reschedule '+person.name);
  button(form,'Back to members',manageMembers);
  if(!sources.length){
    node(form,'p','No eligible recurring bookings found. You can move an upcoming unmarked booking or a recent booking marked Away.');
    return;
  }
  const describe=item=>{
    const date=new Date(item.starts);
    return headings.format(new Date(dateKey(date)+'T00:00:00Z'))+' · '+timeFormat.format(date)
      +' · '+item.trainer_name+' · '+item.capacity+':1';
  };
  const source=select(form,'Original recurring session',[
    ['', 'Choose an occurrence'],
    ...sources.map(item=>[item.id,describe(item)+(item.status==='Away'?' · Away':'')])
  ]);
  const day=field(form,'Make-up date','date',today());
  day.min=today();
  source.required=true;day.required=true;
  const results=node(form,'div');results.className='stack';
  results.setAttribute('aria-live','polite');
  source.onchange=day.onchange=()=>results.replaceChildren();
  button(form,'Find available sessions',async()=>{
    if(!form.reportValidity()) return;
    const sourceId=Number(source.value);
    const chosenDay=day.value;
    results.replaceChildren();
    const choices=await data(db.rpc('member_makeup_slots',{
      person:person.id,source:sourceId,chosen_day:chosenDay
    }));
    if(Number(source.value)!==sourceId || day.value!==chosenDay) return;
    if(!choices.length){
      node(results,'p','No eligible sessions with a spare spot on this date.');
      return;
    }
    const target=select(results,'Make-up session',choices.map(item=>[
      item.id,describe(item)+' · '+item.available+' spare'
    ]));
    button(results,'Confirm one-off move',async()=>{
      if(!confirm('Move '+person.name+' to this session for this week only?')) return;
      await data(db.rpc('reschedule_member',{person:person.id,source:sourceId,destination:Number(target.value)}));
      selected=chosenDay;mode='Team calendar';dialog.close();await render();
      notice.textContent=person.name+' was rescheduled for this occurrence.';
    },true);
  });
}

function showMemberStatistics(){
  dialog.replaceChildren();
  const form=node(dialog,'form');
  node(form,'h2','Member statistics');
  const member=select(form,'Member',[['','Choose a member'],...members.map(person=>[person.id,person.name])]);
  const first=field(form,'From','date',shift(today(),-89));
  const last=field(form,'To','date',today());
  for(const input of [member,first,last]) input.required=true;
  const results=node(form,'section');
  results.setAttribute('aria-live','polite');
  button(form,'Show statistics',async()=>{
    if(!form.reportValidity()) return;
    if(last.value<first.value) throw new Error('Check the date range.');
    const [row]=await data(db.rpc('member_attendance_stats',{person:Number(member.value),first_day:first.value,last_day:last.value}));
    results.replaceChildren();
    const list=node(results,'dl');list.className='attendance-stats';
    for(const [key,label] of [['booked','Booked'],['attended','Attended'],['missed','Missed (no-show)'],
      ['late_cancelled','Late cancelled'],['away','Away'],['rescheduled','Rescheduled'],['unmarked','Unmarked']]){
      node(list,'dt',label);node(list,'dd',String(row[key]));
    }
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
  const recurrence=select(form,session?'Weekly repeat':'Repeat',session
    ? [['keep','Keep current repeat settings'],['indefinite','Repeat weekly until cancelled']]
    : [['single','One session'],['finite','Repeat for a set number of weeks'],['indefinite','Repeat weekly until cancelled']]);
  const repeat=session?null:field(form,'Number of weekly occurrences','number',2);
  const scope=session?.series_id?select(form,'Apply to',[['one','This session'],['following','This and future sessions']]):null;
  function syncRepeat(){
    if(repeat){
      const finite=recurrence.value==='finite';
      repeat.disabled=!finite;
      repeat.parentElement.hidden=!finite;
    }
    if(scope && recurrence.value==='indefinite') scope.value='following';
  }
  if(repeat){repeat.min=2;repeat.max=52;repeat.required=true;}
  recurrence.onchange=syncRepeat;
  syncRepeat();
  const roster=node(form,'div');roster.className='stack';
  const initial=session?.roster.map(member=>member.member_id)||[];
  let picks=[];
  function drawRoster(current){
    roster.replaceChildren();
    picks=Array.from({length:Math.max(Number(capacity.value), ...current.map((value,index)=>value?index+1:0))},(_,index)=>select(roster,'Spot '+(index+1),
      [['','Spare'],...members.filter(member=>!member.archived || String(member.id)===String(current[index]))
        .map(member=>[member.id,member.name+(member.archived?' (archived)':'')])],current[index]??''));
  }
  drawRoster(initial);
  capacity.onchange=()=>drawRoster(picks.map(pick=>pick.value));
  const actions=node(form,'div');actions.className='actions';
  button(actions,'Save booking',async()=>{
    if(!form.reportValidity()) return;
    await data(db.rpc('save_booking',{booking:session?.id??null,following:scope?.value==='following' || recurrence.value==='indefinite',
      trainer_id:trainer.value,local_start:day.value+'T'+time.value,minutes:Number(duration.value),
      places:Number(capacity.value),member_ids:picks.map(pick=>pick.value).filter(Boolean).map(Number),
      repeat_weeks:recurrence.value==='indefinite'?0:recurrence.value==='finite'?Number(repeat.value):1}));
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
