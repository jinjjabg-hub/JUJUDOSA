// 가상 명식 N개 + 상담 시스템 프롬프트 생성 (index.html 엔진을 그대로 사용)
const fs=require('fs'),vm=require('vm');
const h=fs.readFileSync(''+require('path').join(__dirname,'..','..','index.html')+'','utf8');
const a=h.indexOf('/* ===== 만세력 코어'),b=h.indexOf('window.jujuDebug=');
const pbA=h.indexOf('function personBlock'),pbB=h.indexOf('/* ===== 정밀 MBTI');
const brA=h.indexOf('function BASE_RULES'),brB=h.indexOf('/* ===================== 궁합 (mode G)');
const slim=h.match(/const SLIM_LIMIT='([^']*)'/)[1].replace(/\\n/g,'\n');
const ctx={console,Math,Date,window:{}};vm.createContext(ctx);
vm.runInContext(h.slice(a,b)+'\n'+h.slice(pbA,pbB)+'\n'+h.slice(brA,brB),ctx);
// 재현 가능한 난수
let s=20261109;const rnd=()=>{s=(s*1664525+1013904223)%4294967296;return s/4294967296;};
const N=+process.argv[2]||40,NOWY=2026,out=[];
for(let i=0;i<N;i++){
 const y=1958+Math.floor(rnd()*46),mo=1+Math.floor(rnd()*12),d=1+Math.floor(rnd()*28),hh=Math.floor(rnd()*24),mi=Math.floor(rnd()*60);
 const g=rnd()<0.5?'M':'F';
 ctx.__in={y,mo,d,hh,mi,g,NOWY};
 vm.runInContext(`
  var r=computeSaju({y:__in.y,mo:__in.mo,d:__in.d,h:__in.hh,mi:__in.mi,timeUnknown:false,lonDeg:126.98,useLon:true});
  var mp=r.pillars[1],yp=r.pillars[0];
  var daeun=computeDaeun(r.jde,yp.stem,mp.stem,mp.branch,__in.g);
  var age=__in.NOWY-__in.y+1,cur=null;
  if(daeun)for(const pp of daeun.pillars)if(age>=pp.ageStart&&age<=pp.ageEnd)cur=pp;
  var P={r:r,daeun:daeun,cur:cur,age:age,gender:__in.g,nowY:__in.NOWY};
  var luck=buildLuckBlock(r,__in.g,__in.NOWY);
  var sys=BASE_RULES('2026년 11월 9일','주주도사')+'\\n\\n## 상담자 명식 데이터\\n'+personBlock(P,'')+'\\n'+luck+${JSON.stringify(slim)};
  var seun=getSeunList(r.pillars[2].stem,__in.NOWY,__in.NOWY+1).map(function(x){return {year:x.year,stem:x.stemSipseong,branch:x.branchSipseong,ganji:x.ganjiKr}});
  var sig=judgeJaewoon(r.pillars,getSeunList(r.pillars[2].stem,__in.NOWY,__in.NOWY)[0]);
  var sigN=judgeJaewoon(r.pillars,getSeunList(r.pillars[2].stem,__in.NOWY+1,__in.NOWY+1)[0]);
  var yn=judgeYeonaeun(r.pillars,__in.g,getSeunList(r.pillars[2].stem,__in.NOWY,__in.NOWY)[0]);
  this.__o={pillars:r.pillars.map(function(p){return SK[p.stem]+BK[p.branch]}),system:sys,seun:seun,jae:sig,jaeNext:sigN,love:yn,age:age,cur:cur?(cur.ageStart+'-'+cur.ageEnd+' '+SK[cur.stem]+BK[cur.branch]):null,
    wongukSS:wongukSipseong(r.pillars).map(function(x){return x.ss})};`,ctx);
 out.push(Object.assign({pid:'p'+String(i+1).padStart(2,'0'),birth:`${y}-${mo}-${d} ${hh}:${mi}`,gender:g},JSON.parse(JSON.stringify(ctx.__o))));
}
fs.writeFileSync(process.argv[3]||'profiles.json',JSON.stringify(out,null,1));
console.log('profiles',out.length,'system chars',out[0].system.length);
console.log(out[0].pillars.join(' '),out[0].cur,out[0].seun[0]);
