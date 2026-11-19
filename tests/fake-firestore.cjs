'use strict';
// Deliberately offline. No Firebase dependency or network calls.
function fakeFirestore(initial={}){
 const rows=new Map(Object.entries(initial)),reads=[],writes=[];
 const value=(item,field,id)=>field==='__name__'?id:field.split('.').reduce((current,key)=>current?.[key],item);
 const compare=(a,b)=>a&&typeof a==='object'&&'seconds'in a?a.seconds-b.seconds||a.nanoseconds-b.nanoseconds:typeof a==='number'?a-b:String(a).localeCompare(String(b));
 const doc=(pathname,data)=>({id:pathname.split('/').at(-1),exists:data!==undefined,data:()=>structuredClone(data)});
 function ref(pathname,kind='collection',filters=[],orders=[],after=null,size=null){return{
  path:pathname,collection:name=>ref(pathname+'/'+name),doc:id=>ref(pathname+'/'+id,'doc'),
  where:(...filter)=>ref(pathname,kind,[...filters,filter],orders,after,size),orderBy:(field,direction='asc')=>ref(pathname,kind,filters,[...orders,[field,direction]],after,size),
  startAfter:(...cursor)=>ref(pathname,kind,filters,orders,cursor,size),limit:count=>ref(pathname,kind,filters,orders,after,count),
  onSnapshot(options,next,error){let active=true;void this.get().then(snapshot=>{if(active)next({...snapshot,metadata:{fromCache:false,hasPendingWrites:false}});},error);return()=>{active=false;};},
  async get(){
   reads.push({pathname,kind,filters,orders,after,limit:size});
   if(kind==='doc')return doc(pathname,rows.get(pathname));
   let found=[...rows].filter(([name,data])=>name.startsWith(pathname+'/')&&!name.slice(pathname.length+1).includes('/')&&filters.every(([field,op,expected])=>op==='in'?expected.includes(value(data,field,name.split('/').at(-1))):value(data,field,name.split('/').at(-1))===expected));
   const sorted=orders.length?orders:[['__name__','asc']];
   found=found.filter(([name,data])=>sorted.every(([field])=>value(data,field,name.split('/').at(-1))!==undefined)).sort(([left,a],[right,b])=>{for(const [field,direction]of sorted){const delta=compare(value(a,field,left.split('/').at(-1)),value(b,field,right.split('/').at(-1)));if(delta)return direction==='desc'?-delta:delta;}return 0;});
   if(after)found=found.filter(([name,data])=>{for(let i=0;i<after.length;i++){const delta=compare(value(data,sorted[i][0],name.split('/').at(-1)),after[i]);if(delta)return sorted[i][1]==='desc'?delta<0:delta>0;}return false;});
   if(size!==null)found=found.slice(0,size);
   const docs=found.map(([name,data])=>doc(name,data));return{docs,forEach:fn=>docs.forEach(fn)};
  }
 };}
 const batch=()=>{const pending=[];return{set(reference,data){pending.push([reference.path,structuredClone(data)]);},async commit(){pending.forEach(([name,data])=>{rows.set(name,data);writes.push({pathname:name,data});});}};};
 const db={collection:name=>ref(name),batch,async runTransaction(fn){const pending=[];const result=await fn({get:reference=>reference.get(),set(reference,data){pending.push([reference.path,structuredClone(data)]);}});pending.forEach(([name,data])=>{rows.set(name,data);writes.push({pathname:name,data});});return result;}};
 return{db,rows,reads,writes};
}
module.exports={fakeFirestore};
