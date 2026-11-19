'use strict';
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../shared/google-classroom.gs'),'utf8');
const reads=[],drive=[];
const userId='100000000000000000001',studentId='1510101',courseId='301',courseWorkId='41';
const student={userId,profile:{emailAddress:'student@example.invalid',name:{fullName:'01 1510101'}}};
const assignment={courseId,courseWorkId,userId,state:'TURNED_IN',updateTime:'2026-11-18T01:00:00Z',assignmentSubmission:{attachments:[{driveFile:{id:'one',title:'work.png'}}]}};
let email='jimwang@mail.qfm.kh.edu.tw',view=student,submissions={studentSubmissions:[assignment]};
const context=vm.createContext({
 Session:{getActiveUser:()=>({getEmail:()=>email})},
 ContentService:{MimeType:{JSON:'json',JAVASCRIPT:'javascript'},createTextOutput:text=>({setMimeType:()=>text})}
});
vm.runInContext(source,context);
context.classroomGet_=(name,parameters)=>{
 reads.push({name,parameters});
 if(name==='courses/301/students/'+userId)return view;
 if(name==='courses/301/courseWork/41/studentSubmissions')return submissions;
 throw Error('Unexpected Classroom read: '+name);
};
context.driveFileMetadataMap_=items=>{
 drive.push([...(items||[])].map(item=>item.driveFile.id));
 return{one:{mimeType:'image/png',modifiedTime:'2026-11-18T02:00:00Z',webViewLink:'https://drive.google.com/file/d/one/view'}};
};
const request=(extra={})=>JSON.parse(context.doGet({parameter:{action:'review-submission',courseId,courseWorkId,classroomUserId:userId,studentId,...extra}}));
let result=request();
assert.equal(result.status,'success');
assert.equal(result.courseId,courseId);assert.equal(result.courseWorkId,courseWorkId);
assert.equal(result.submission.studentId,studentId);assert.equal(result.submission.classroomUserId,userId);
assert.equal(result.submission.attachments[0].modifiedAt,'2026-11-18T02:00:00Z');
assert.deepEqual(reads.map(row=>row.name),['courses/301/students/'+userId,'courses/301/courseWork/41/studentSubmissions']);
assert.equal(reads[1].parameters.userId,userId);assert.equal(reads[1].parameters.pageSize,2);assert.deepEqual(drive,[['one']]);
assert.equal(request({studentId:'1510102'}).status,'error');
assert.equal(reads.length,3,'different student mapping is rejected before reading the assignment');
assert.equal(request({courseWorkId:'-'}).status,'error');
assert.equal(request({classroomUserId:'me'}).status,'error');
assert.equal(reads.length,3,'invalid scope does not call Classroom');
for(const edited of [
 {studentSubmissions:[{...assignment,courseWorkId:'another'}]},
 {studentSubmissions:[{...assignment,userId:'999'}]},
 {studentSubmissions:[assignment,assignment]},
 {studentSubmissions:[],nextPageToken:'unexpected'}
]){
 submissions=edited;assert.equal(request().status,'error');
}
assert.equal(drive.length,1,'unexpected assignment never reads Drive');
submissions={studentSubmissions:[]};result=request();
assert.equal(result.submission.state,'CREATED');assert.deepEqual(result.submission.attachments,[]);
const before=reads.length;
email='student@example.invalid';assert.equal(request().status,'error');assert.equal(reads.length,before,'teacher authorization still enforced');
console.log('PASS single Classroom review: teacher-only, one student, one assignment, scoped Drive metadata, unchanged/missing/mismatched evidence.');
