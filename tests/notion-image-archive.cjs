'use strict';
// Synthetic archive snapshots and local PNGs only; no live data or network.
const assert = require('node:assert/strict');
const {fixture,png,clone} = require('./notion-certificate-sync.cjs');
let checks=0;
function check(value,message){assert(value,message);checks++;}
function job(f,{term='115-1',unit=1}={}) {
 const url='https://drive.google.com/file/d/approved/view';
 return {term,classRoom:'701',task:{key:'thinking-'+unit,category:'thinking',title:'封存測試'},students:[{
  ...f.student('1510101',false),status:'已核定通關',reviewedBy:'jimwang@mail.qfm.kh.edu.tw',reviewedAt:'2026-10-08T03:00:00Z',
  completedAt:'2026-10-08T02:00:00Z',approvedAttachmentUrl:url,attachments:[{name:'採認圖片',url}]
 }]};
}
function manual(payload,base64=png){const student=payload.students[0];student.manualImage={base64,approvedAttachmentUrl:student.approvedAttachmentUrl,reviewedAt:student.reviewedAt};return payload;}
for(const term of ['115-1','115-2']) for(let unit=1;unit<=8;unit++){
 const f=fixture(),payload=job(f,{term,unit});f.context.syncNotion_(payload);
 const page=f.work('1510101'),id=page.id,upload=page.cover.file_upload.id,reads=f.driveCalls.length,sends=f.sends();
 f.driveFiles.get('approved').httpStatus=401;
 const result=f.context.syncNotion_(payload);
 check(result.filesSynced===1&&!result.failedStudents.length&&f.driveCalls.length===reads&&f.sends()===sends,term+' '+unit+' retained snapshot bypasses failing Drive');
 check(page.id===id&&page.cover.file_upload.id===upload&&f.text(page.properties['圖片採認索引']).length===64,'stable card/upload with approval fingerprint');
 check(f.calls.filter(call=>call.method==='patch'&&call.url==='pages/'+id).slice(-1).every(call=>!('cover' in call.data)&&!('作品附件' in call.data.properties)),'retained attached files/cover are not reattached or overwritten');
}
{
 const f=fixture(),payload=job(f);f.context.syncNotion_(payload);const page=f.work('1510101'),reads=f.driveCalls.length;
 for(const name of ['圖片採認索引','圖片封存來源','圖片封存時間'])delete page.properties[name];
 f.driveFiles.get('approved').httpStatus=401;
 const result=f.context.syncNotion_(payload);
 check(result.filesSynced===1&&f.driveCalls.length===reads&&f.text(page.properties['圖片封存來源'])==='既有圖片封存','v5 cards migrate from matching link/review time without Drive');
}
{
 const f=fixture(),payload=job(f);f.context.syncNotion_(payload);const page=f.work('1510101'),reads=f.driveCalls.length,sends=f.sends();
 page.cover=null;page.properties['作品附件']={files:[]};page.blocks=page.blocks.filter(block=>!f.context.isNotionWorkImageBlock_(block));
 f.driveFiles.get('approved').httpStatus=401;
 const result=f.context.syncNotion_(payload);
 check(result.filesSynced===1&&!result.failedStudents.length&&page.cover&&f.live(page).some(block=>f.context.isNotionWorkImageBlock_(block))&&f.driveCalls.length===reads&&f.sends()===sends,'missing body/cover/files repair from valid Notion upload without Drive');
}
for(const change of ['review','url','fingerprint','force']){
 const f=fixture(),payload=job(f);f.context.syncNotion_(payload);const page=f.work('1510101'),reads=f.driveCalls.length;
 if(change==='review')payload.students[0].reviewedAt='2026-10-08T04:00:00Z';
 if(change==='url'){payload.students[0].approvedAttachmentUrl='https://drive.google.com/open?id=approved';payload.students[0].attachments[0].url=payload.students[0].approvedAttachmentUrl;}
 if(change==='fingerprint')page.properties['圖片採認索引']=f.rt('0'.repeat(64));
 if(change==='force')payload.forceRefreshImages=true;
 const result=f.context.syncNotion_(payload);
 check(result.filesSynced===1&&f.driveCalls.length===reads+2,'changed approval/explicit refresh reads source: '+change);
}
{
 const f=fixture(),payload=job(f);f.context.syncNotion_(payload);const page=f.work('1510101'),before=JSON.stringify(page);
 payload.forceRefreshImages=true;f.driveFiles.get('approved').httpStatus=401;
 const result=f.context.syncNotion_(payload);
 check(result.filesSynced===0&&result.failedStudents[0].httpStatus===401&&JSON.stringify(page)===before,'forced refresh failure keeps prior snapshot instead of clearing it');
}
for(const term of ['115-1','115-2']){
 const f=fixture(),payload=manual(job(f,{term}));f.driveFiles.get('approved').httpStatus=401;
 const result=f.context.syncNotion_(payload),page=f.work('1510101');
 check(result.filesSynced===1&&!result.failedStudents.length&&f.driveCalls.length===0&&f.sends()===1,'manual PNG bypasses Drive completely: '+term);
 check(f.text(page.properties['圖片封存來源'])==='教師手動補圖'&&page.properties['作品連結'].url===payload.students[0].approvedAttachmentUrl&&page.properties['圖片封存時間'].date.start,'manual origin/time and original approved source are recorded');
 const id=page.id,sends=f.sends();delete payload.students[0].manualImage;
 const again=f.context.syncNotion_(payload);
 check(again.filesSynced===1&&page.id===id&&f.driveCalls.length===0&&f.sends()===sends&&f.text(page.properties['圖片封存來源'])==='教師手動補圖','ordinary sync preserves manual snapshot');
 payload.forceRefreshImages=true;delete f.driveFiles.get('approved').httpStatus;
 const refreshed=f.context.syncNotion_(payload);
 check(refreshed.filesSynced===1&&f.driveCalls.length===2&&f.text(page.properties['圖片封存來源'])==='Google Drive','explicit refresh replaces manual origin with current Drive source');
}
{
 const f=fixture(),payload=job(f);f.context.syncNotion_(payload);const page=f.work('1510101'),id=page.id;
 page.blocks.push({id:'note',type:'paragraph',paragraph:{rich_text:[{text:{content:'教師筆記'}}]}});
 manual(payload,Buffer.concat([Buffer.from(png,'base64'),Buffer.from([0])]).toString('base64'));
 const result=f.context.syncNotion_(payload);
 check(result.filesSynced===1&&page.id===id&&result.workCreated===0&&f.live(page).some(block=>block.id==='note'),'manual replacement keeps original card and teacher notes');
 delete payload.students[0].manualImage;payload.students[0].status='需要補件';
 f.context.syncNotion_(payload);
 check(page.cover===null&&page.properties['作品附件'].files.length===0&&!f.text(page.properties['圖片採認索引'])&&!f.text(page.properties['圖片封存來源'])&&page.properties['圖片封存時間'].date===null,'revoked approval clears archive metadata and generated image');
}
for(const invalid of ['unapproved','reviewer','url','date','type','batch','base64','signature','oversize']){
 const f=fixture(),payload=manual(job(f));
 if(invalid==='unapproved')payload.students[0].status='尚未核定';
 if(invalid==='reviewer')payload.students[0].reviewedBy='other@example.invalid';
 if(invalid==='url')payload.students[0].manualImage.approvedAttachmentUrl='https://drive.google.com/file/d/other/view';
 if(invalid==='date')payload.students[0].manualImage.reviewedAt='2026-10-08T04:00:00Z';
 if(invalid==='type')payload.task={key:'programming-1',category:'programming',title:'不能補圖'};
 if(invalid==='batch')payload.students.push({...payload.students[0],studentId:'1510102'});
 if(invalid==='base64')payload.students[0].manualImage.base64='not*base64';
 if(invalid==='signature')payload.students[0].manualImage.base64=Buffer.from('not-a-png'.repeat(10)).toString('base64');
 if(invalid==='oversize')payload.students[0].manualImage.base64='A'.repeat(Math.ceil(10*1024*1024/3)*4+4);
 assert.throws(()=>f.context.syncNotion_(payload));
 check(f.calls.length===0&&f.driveCalls.length===0&&f.sends()===0,'invalid manual request rejected before any external writes: '+invalid);
}
{
 const f=fixture(),payload=manual(job(f));f.fail.add('verify:1510101');
 const result=f.context.syncNotion_(payload);
 check(result.filesSynced===0&&result.failedStudents.length===1,'manual success requires Notion readback confirmation');
}
console.log(`PASS ${checks} offline image snapshot/manual-upload checks; no live calls or data changes.`);
