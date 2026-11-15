/* SCORM dual runtime wrapper (SCORM 2004 + SCORM 1.2), resume + progress.
   Based on the SCORM Conversion Kit wrapper (doc 05, B1). Same public
   functions and cmi.* keys, plus these fixes:
     - SCORM 1.2: a "passed"/"failed" lesson_status is never downgraded to
       "incomplete" on later saves.
     - Terminate/LMSFinish is called exactly once (Finish button + unload no
       longer double-terminate).
     - pagehide is used as well as unload (unload alone is unreliable on
       mobile and in modern browsers).
     - A cross-origin parent no longer aborts the API search.
     - window.SCORM_SCORED = true stops progress being written into the score
       fields, so a real quiz score set with scormSetScore() is not overwritten.
   Public API:
     scormGetBookmark()            -> {cur,max,quiz} or null   (kit compatible)
     scormSave(cur,max,quiz,total)                             (kit compatible)
     scormGetState()               -> saved object or null
     scormSaveState(obj, fraction)  save any small JSON state + progress 0..1
     scormSetScore(raw,min,max,passMark)  real score + pass/fail
     scormComplete()
     scormFinishReturn()
     scormVersion()                -> "2004" | "1.2" | null
*/
(function(){
  var api=null, ver=null, ready=false, done=false, ended=false;
  function walk(w,p){
    var n=0;
    try{
      while(w && n<12){
        try{ if(w[p]) return w[p]; }catch(e){}
        if(!w.parent || w.parent===w) break;
        w=w.parent; n++;
      }
    }catch(e){}
    return null;
  }
  function locate(w){
    var a=walk(w,"API_1484_11"); if(a){ver="2004";return a;}
    var b=walk(w,"API"); if(b){ver="1.2";return b;}
    return null;
  }
  function I(){return ver==="2004"?api.Initialize(""):api.LMSInitialize("");}
  function G(k){return String(ver==="2004"?api.GetValue(k):api.LMSGetValue(k));}
  function S(k,v){return ver==="2004"?api.SetValue(k,v):api.LMSSetValue(k,v);}
  function C(){return ver==="2004"?api.Commit(""):api.LMSCommit("");}
  function FIN(){return ver==="2004"?api.Terminate(""):api.LMSFinish("");}
  function ST(){return ver==="2004"?"cmi.completion_status":"cmi.core.lesson_status";}
  function EX(){return ver==="2004"?"cmi.exit":"cmi.core.exit";}
  function LOC(){return ver==="2004"?"cmi.location":"cmi.core.lesson_location";}
  function isFinal(s){return s==="completed"||s==="passed"||s==="failed";}
  function scored(){return window.SCORM_SCORED===true;}

  function connect(){
    if(ready) return true;
    if(ended) return false;
    try{
      api=locate(window);
      if(!api && window.opener) api=locate(window.opener);
      if(!api && window.top && window.top.opener) api=locate(window.top.opener);
      if(api){
        I(); ready=true;
        var s=G(ST());
        if(s===""||s==="unknown"||s==="not attempted"){ S(ST(),"incomplete"); C(); }
        if(isFinal(s)) done=true;
        return true;
      }
    }catch(e){}
    return false;
  }
  connect();

  function writeProgress(f){
    if(!(f>=0)) return;
    if(f>1) f=1;
    var pct=Math.round(f*100);
    if(ver==="2004"){
      S("cmi.progress_measure",f.toFixed(4));
      if(!scored()){ S("cmi.score.raw",String(pct)); S("cmi.score.min","0"); S("cmi.score.max","100"); S("cmi.score.scaled",(pct/100).toFixed(4)); }
    } else if(!scored()){
      /* 1.2 has no progress_measure: score.raw carries progress as 0-100 */
      S("cmi.core.score.raw",String(pct)); S("cmi.core.score.min","0"); S("cmi.core.score.max","100");
    }
  }
  function markIncomplete(){ var st=G(ST()); if(!isFinal(st)) S(ST(),"incomplete"); }

  window.scormVersion=function(){ connect(); return ready?ver:null; };

  window.scormGetState=function(){
    try{
      if(!connect()) return null;
      var raw=G("cmi.suspend_data");
      if(raw && raw!=="null" && raw!=="undefined"){ var o=JSON.parse(raw); if(o && typeof o==="object") return o; }
    }catch(e){}
    return null;
  };

  window.scormGetBookmark=function(){
    try{
      if(!connect()) return null;
      var o=window.scormGetState();
      if(o && typeof o.cur==="number") return o;
      var loc=G(LOC());
      if(loc!==""){ var n=parseInt(loc,10); if(!isNaN(n)) return {cur:n,max:n,quiz:false}; }
    }catch(e){}
    return null;
  };

  window.scormSaveState=function(obj,fraction,location){
    try{
      if(!connect()) return;
      if(location!==undefined && location!==null) S(LOC(),String(location));
      S("cmi.suspend_data",JSON.stringify(obj||{}));
      writeProgress(fraction);
      markIncomplete();
      S(EX(),"suspend"); C();
    }catch(e){}
  };

  window.scormSave=function(cur,max,quiz,total){
    var f=(total>1)?(max/(total-1)):undefined;
    window.scormSaveState({cur:cur,max:max,quiz:!!quiz},f,cur);
  };

  window.scormSetScore=function(raw,min,max,passMark){
    try{
      if(!connect()) return;
      min=(min===undefined)?0:min; max=(max===undefined)?100:max;
      var range=(max-min)||1, scaled=(raw-min)/range;
      if(ver==="2004"){
        S("cmi.score.raw",String(raw)); S("cmi.score.min",String(min)); S("cmi.score.max",String(max));
        S("cmi.score.scaled",scaled.toFixed(4));
        if(passMark!==undefined) S("cmi.success_status", raw>=passMark?"passed":"failed");
      } else {
        S("cmi.core.score.raw",String(raw)); S("cmi.core.score.min",String(min)); S("cmi.core.score.max",String(max));
        if(passMark!==undefined) S("cmi.core.lesson_status", raw>=passMark?"passed":"failed");
      }
      C();
    }catch(e){}
  };

  window.scormComplete=function(){
    if(done) return; done=true;
    try{ if(connect()){
      writeProgress(1);
      var st=G(ST());
      if(ver==="2004" || !isFinal(st)) S(ST(),"completed");
      S(EX(),""); C();
    } }catch(e){}
  };

  function end(){
    if(ended || !ready) return;
    ended=true;
    try{ if(!done) S(EX(),"suspend"); C(); FIN(); }catch(e){}
  }
  window.scormFinishReturn=function(){ try{ window.scormComplete(); }catch(e){} end(); };
  window.addEventListener("pagehide",end);
  window.addEventListener("unload",end);
})();
