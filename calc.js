/* ふたりの家計簿 — 計算ロジック(画面やデータ保存に依存しない部分) */
var Calc = (function(){
  function catOf(s,id){ return s.categories.find(function(c){return c.id===id}) }
  function purOf(s,id){ return s.purposes.find(function(p){return p.id===id}) }
  function isLivingOut(e,s){ var c=catOf(s,e.cat); return e.kind==='out' && !e.trip && !!(c&&c.living) }
  function isLivingIn(e,s){ var p=purOf(s,e.purpose); return e.kind==='in' && !e.trip && !!(p&&p.living) }
  function filterBook(list, book){
    if(book==='all') return list;
    if(book==='daily') return list.filter(function(e){return !e.trip});
    return list.filter(function(e){return e.trip===book});
  }
  function summarize(list, s){
    var r={totalOut:0,totalIn:0,byCat:{},byPurpose:{},outBy:{},inBy:{},livingIn:0,livingOut:0,count:list.length};
    s.members.forEach(function(m){r.outBy[m.id]=0;r.inBy[m.id]=0});
    list.forEach(function(e){
      var a=Number(e.amount)||0;
      if(e.kind==='out'){
        r.totalOut+=a; r.byCat[e.cat]=(r.byCat[e.cat]||0)+a; r.outBy[e.payer]=(r.outBy[e.payer]||0)+a;
        if(isLivingOut(e,s)) r.livingOut+=a;
      }else if(e.kind==='in'){
        r.totalIn+=a; r.byPurpose[e.purpose]=(r.byPurpose[e.purpose]||0)+a; r.inBy[e.payer]=(r.inBy[e.payer]||0)+a;
        if(isLivingIn(e,s)) r.livingIn+=a;
      }
    });
    r.livingDiff=r.livingIn-r.livingOut;
    return r;
  }
  function livingSeries(months, s){
    var cum=0;
    return months.map(function(m){
      var x=summarize(m.entries,s); cum+=x.livingDiff;
      return {month:m.month,livingIn:x.livingIn,livingOut:x.livingOut,diff:x.livingDiff,cumulative:cum};
    });
  }
  function shiftMonth(m,d){ var p=m.split('-').map(Number); var t=p[0]*12+(p[1]-1)+d; var y=Math.floor(t/12), mo=t-y*12+1; return y+'-'+(mo<10?'0':'')+mo }
  function monthsBetween(a,b){ var out=[]; if(a>b){var t=a;a=b;b=t} var m=a; while(m<=b && out.length<60){out.push(m); m=shiftMonth(m,1)} return out }
  function toInt(v){ var n=parseInt(String(v==null?'':v).replace(/[０-９]/g,function(c){return String.fromCharCode(c.charCodeAt(0)-0xFEE0)}).replace(/[^0-9]/g,''),10); return isNaN(n)?0:n }
  function groupByMonth(list, months){ var g={}; months.forEach(function(m){g[m]=[]}); list.forEach(function(e){ if(g[e.month]) g[e.month].push(e) }); return months.map(function(m){return {month:m,entries:g[m]}}) }
  function yen(n){ return '¥'+Math.round(Math.abs(n)).toLocaleString('ja-JP') }
  function signed(n){ return (n>0?'+':n<0?'−':'±')+yen(n) }
  return {catOf:catOf,purOf:purOf,isLivingOut:isLivingOut,isLivingIn:isLivingIn,filterBook:filterBook,summarize:summarize,livingSeries:livingSeries,shiftMonth:shiftMonth,monthsBetween:monthsBetween,toInt:toInt,groupByMonth:groupByMonth,yen:yen,signed:signed};
})();
if(typeof module!=='undefined') module.exports=Calc;
