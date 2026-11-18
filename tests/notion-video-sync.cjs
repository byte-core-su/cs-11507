'use strict';
// Container/Notion integration mocks only. This does not prove codec playback.
const assert=require('node:assert/strict');
const {fixture,png,mp4,clone}=require('./notion-certificate-sync.cjs');
let checks=0;
function check(value,message){assert(value,message);checks++;}
function setup(term='115-1',unit=1){
 const f=fixture(),url='https://drive.google.com/file/d/approved/view';
 Object.assign(f.driveFiles.get('approved'),{mimeType:'video/mp4',bytes:[...mp4],size:mp4.length});
 const job={term,classRoom:'701',task:{key:'programming-'+unit,category:'programming',title:'影片測試'},students:[{...f.student('1510101',false),status:'已核定通關',reviewedAt:'2026-10-09T03:00:00Z',reviewedBy:'jimwang@mail.qfm.kh.edu.tw',approvedAttachmentUrl:url,attachments:[{name:'成果.MP4',url}],videoCover:{base64:png}}]};
 return {f,job};
}
function manual(job){job.students[0].manualVideo={base64:mp4.toString('base64'),cover:{base64:png},approvedAttachmentUrl:job.students[0].approvedAttachmentUrl,reviewedAt:job.students[0].reviewedAt};return job;}
for(const term of ['115-1','115-2'])for(let unit=1;unit<=8;unit++){
 const {f,job}=setup(term,unit),result=f.context.syncNotion_(job),page=f.work('1510101');
 check(result.filesSynced===1&&!result.failedStudents.length&&page.properties['作品附件'].files.length===1&&page.properties['作品附件'].files[0].name.endsWith('.mp4'),'one actual MP4 primary work: '+term+' '+unit);
 check(f.live(page).filter(b=>b.type==='video').length===1&&page.cover.type==='file_upload'&&f.sends()===2,'player and independent poster uploaded, not external Drive embed');
 check(page.properties['作品連結'].url===job.students[0].approvedAttachmentUrl&&f.text(page.properties['影片封面來源']).includes('非影片截圖'),'original approval link and honest fallback cover');
 const id=page.id,reads=f.driveCalls.length,sends=f.sends();f.driveFiles.get('approved').httpStatus=401;
 const again=f.context.syncNotion_(job);
 check(again.filesSynced===1&&!again.failedStudents.length&&page.id===id&&f.driveCalls.length===reads&&f.sends()===sends,'retained video bypasses failing Drive and no reupload');
 check(!('cover' in f.calls.filter(c=>c.method==='patch'&&c.url==='pages/'+id).at(-1).data)&&!('作品附件' in f.calls.filter(c=>c.method==='patch'&&c.url==='pages/'+id).at(-1).data.properties),'attached video and cover not reattached on ordinary sync');
}
{
 const {f,job}=setup();let nativeReads=0;
 f.context.DriveApp={getFileById:id=>{assert.equal(id,'approved');nativeReads++;return{getThumbnail:()=>({getBytes:()=>[...Buffer.from(png,'base64')]})};}};
 const result=f.context.syncNotion_(job),page=f.work('1510101');
 check(result.filesSynced===1&&nativeReads===1&&f.text(page.properties['影片封面來源'])==='Google 影片縮圖','actual thumbnail stored, not short-lived Drive URL');
}
{
 const {f,job}=setup();f.context.DriveApp={getFileById:()=>{throw Error('synthetic thumbnail auth failure');}};
 check(f.context.syncNotion_(job).filesSynced===1,'thumbnail-only failure uses labeled poster without losing valid video');
}
{
 const {f,job}=setup(),jpeg=[255,216,255,...Array(40).fill(1)];
 f.context.DriveApp={getFileById:()=>({getThumbnail:()=>({getBytes:()=>jpeg})})};
 check(f.context.syncNotion_(job).filesSynced===1&&f.calls.some(c=>c.url==='file_uploads'&&c.data?.content_type==='image/jpeg'),'JPEG thumbnail keeps matching MIME type and extension');
}
{
 const {f,job}=setup();job.students[0].status='尚未核定';f.context.syncNotion_(job);const page=f.work('1510101'),id=page.id;
 page.blocks.push({id:'teacher-note',type:'paragraph',paragraph:{rich_text:[{text:{content:'原有筆記'}}]}});job.students[0].status='已核定通關';
 const result=f.context.syncNotion_(job);
 check(result.filesSynced===1&&result.workCreated===0&&page.id===id&&f.live(page).some(b=>b.type==='video')&&f.live(page).some(b=>b.id==='teacher-note'),'legacy/blank card repaired in place with notes preserved');
}
for(const missing of ['cover','files','player','duplicate']){
 const {f,job}=setup();f.context.syncNotion_(job);const page=f.work('1510101'),reads=f.driveCalls.length,sends=f.sends();
 page.blocks.push({id:'teacher-note',type:'paragraph',paragraph:{rich_text:[{text:{content:'保留筆記'}}]}});
 if(missing==='cover')page.cover=null;
 if(missing==='files')page.properties['作品附件']={files:[]};
 if(missing==='player')page.blocks=page.blocks.filter(b=>b.type!=='video');
 if(missing==='duplicate')page.blocks.push({...clone(page.blocks.find(b=>b.type==='video')),id:'duplicate'});
 f.driveFiles.get('approved').httpStatus=401;const result=f.context.syncNotion_(job);
 check(result.filesSynced===1&&!result.failedStudents.length&&f.driveCalls.length===reads&&f.sends()===sends,'repair '+missing+' from reusable Notion uploads without Drive');
 check(f.live(page).filter(b=>b.type==='video').length===1&&f.live(page).some(b=>b.id==='teacher-note'),'one managed player and teacher notes retained');
}
for(const changed of ['review','url','force']){
 const {f,job}=setup();f.context.syncNotion_(job);const reads=f.driveCalls.length;
 if(changed==='review')job.students[0].reviewedAt='2026-10-09T04:00:00Z';
 if(changed==='url'){job.students[0].approvedAttachmentUrl='https://drive.google.com/open?id=approved';job.students[0].attachments[0].url=job.students[0].approvedAttachmentUrl;}
 if(changed==='force')job.forceRefreshImages=true;
 check(f.context.syncNotion_(job).filesSynced===1&&f.driveCalls.length===reads+2,'changed approval or explicit refresh reads video: '+changed);
}
{
 const {f,job}=setup();f.context.syncNotion_(job);const page=f.work('1510101'),before=JSON.stringify(page);job.forceRefreshImages=true;f.driveFiles.get('approved').httpStatus=401;
 const result=f.context.syncNotion_(job);
 check(result.filesSynced===0&&result.failedStudents[0].httpStatus===401&&result.failedStudents[0].authDiagnostic.version==='drive-auth-diagnostic-v1'&&JSON.stringify(page)===before,'persistent Drive 401 keeps old card, exposes bounded-retry evidence');
}
{
 const {f,job}=setup();f.context.syncNotion_(job);const page=f.work('1510101');job.students[0].status='需要補件';
 const result=f.context.syncNotion_(job);
 check(result.filesSynced===0&&page.cover===null&&page.properties['作品附件'].files.length===0&&!f.live(page).some(b=>b.type==='video')&&!f.text(page.properties['作品影片索引']),'revoked approval removes generated video, cover and indexes');
}
for(const term of ['115-1','115-2']){
 const {f,job}=setup(term);manual(job);f.driveFiles.get('approved').httpStatus=401;
 const result=f.context.syncNotion_(job),page=f.work('1510101'),id=page.id;
 check(result.filesSynced===1&&f.driveCalls.length===0&&f.text(page.properties['影片封存來源'])==='教師手動補影片'&&f.text(page.properties['影片封面來源'])==='教師手動擷取','manual MP4 bypasses Drive and records source: '+term);
 delete job.students[0].manualVideo;
 check(f.context.syncNotion_(job).filesSynced===1&&page.id===id&&f.driveCalls.length===0,'normal sync preserves manual video');
}
for(const invalid of ['unapproved','reviewer','stale','url','signature','base64','oversize','cover','category','batch']){
 const {f,job}=setup();manual(job);const student=job.students[0];
 if(invalid==='unapproved')student.status='尚未核定';if(invalid==='reviewer')student.reviewedBy='other@example.invalid';
 if(invalid==='stale')student.manualVideo.reviewedAt='2026-10-09T04:00:00Z';if(invalid==='url')student.manualVideo.approvedAttachmentUrl='https://drive.google.com/file/d/other/view';
 if(invalid==='signature')student.manualVideo.base64=png;if(invalid==='base64')student.manualVideo.base64='bad***';
 if(invalid==='oversize')student.manualVideo.base64='A'.repeat(Math.ceil(20*1024*1024/3)*4+4);
 if(invalid==='cover')student.manualVideo.cover={base64:'bad***'};
 if(invalid==='category')job.task={key:'thinking-1',category:'thinking',title:'不能補影片'};
 if(invalid==='batch')job.students.push({...student,studentId:'1510102'});
 assert.throws(()=>f.context.syncNotion_(job));check(f.calls.length===0&&f.driveCalls.length===0&&f.sends()===0,'invalid manual request rejected before writes: '+invalid);
}
for(const invalid of ['oversize','mime','download','html']){
 const {f,job}=setup(),file=f.driveFiles.get('approved');
 if(invalid==='oversize')file.size=20*1024*1024+1;if(invalid==='mime')file.mimeType='image/png';if(invalid==='download')file.capabilities.canDownload=false;if(invalid==='html')file.bytes=[...Buffer.from('<html>not a video</html>'.repeat(3))];
 const result=f.context.syncNotion_(job);
 check(result.filesSynced===0&&result.failedStudents.length===1&&f.sends()===0&&!f.work('1510101'),'source '+invalid+' never publishes link-only success');
}
{
 const {f,job}=setup();job.students[0].studentId='1510100';
 check(f.context.syncNotion_(job).skippedTestAccounts===1&&f.driveCalls.length===0&&f.pages.size===0,'00 test students excluded before reads/writes');
}
for(const fail of ['upload-send','verify:1510101']){
 const {f,job}=setup();f.fail.add(fail);const result=f.context.syncNotion_(job);
 check(result.filesSynced===0&&result.failedStudents.length===1,'upload/readback failure never counted as success: '+fail);
}
for(const brand of ['qt  ','avif','heic']){
 const {f}=setup(),bytes=[...mp4];for(let i=0;i<4;i++)bytes[8+i]=brand.charCodeAt(i);
 assert.throws(()=>f.context.validateNotionVideoBytes_(bytes,'invalid.mp4'));
 check(true,'non-MP4 major brand rejected even with isom-compatible entry: '+brand);
}
{
 const {f,job}=setup();const native={type:'file',file:{url:'https://example.invalid/notion-video',expiry_time:'2099-01-01T00:00:00Z'}};f.context.syncNotion_(job);const page=f.work('1510101'),reads=f.driveCalls.length;
 page.cover=clone(native);page.properties['作品附件'].files[0]={...clone(native),name:page.properties['作品附件'].files[0].name};page.blocks.find(b=>b.type==='video').video={...clone(native),caption:page.blocks.find(b=>b.type==='video').video.caption};
 f.driveFiles.get('approved').httpStatus=401;
 check(f.context.syncNotion_(job).filesSynced===1&&f.driveCalls.length===reads,'real Notion response file URLs retain attached video without reattaching expired upload IDs');
}
console.log(`PASS ${checks} offline approved-video/archive/manual-upload checks; no live API calls or codec guarantees.`);
