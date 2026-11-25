import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSoundPreferences as normalize } from "../web/js/app/sound-preferences.js";
test("sound preferences validate persisted values and preserve silence",()=>{
 assert.deepEqual(normalize(null),{volume:.8,muted:false});
 assert.deepEqual(normalize({volume:0,muted:true}),{volume:0,muted:true});
 assert.equal(normalize({volume:2}).volume,1);
 assert.equal(normalize({volume:-1}).volume,0);
 assert.equal(normalize({volume:NaN}).volume,.8);
 assert.deepEqual(normalize({volume:".5",muted:"false"}),{volume:.8,muted:false});
});


test("App applies saved sound to both output paths and retains it through mute toggles",async()=>{
 const {App}=await import("../web/js/app/app.js");
 const {readJson}=await import("../web/js/shared/storage.js");
 const original=globalThis.localStorage;
 const values=new Map();globalThis.localStorage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};
 try {
  const state={};
  const output=name=>({setVolume:v=>state[name+"Volume"]=v,setMuted:v=>state[name+"Muted"]=v});
  const app=Object.create(App.prototype);app.audio=output("pcm");app.direct=output("direct");app.ui=output("ui");
  app.setSoundPreferences({volume:.35,muted:true});
  assert.deepEqual(readJson("sound",null),{volume:.35,muted:true});
  app.toggleMute();assert.equal(app.volume,.35);assert.equal(app.muted,false);
  for(const name of ["pcm","direct","ui"]){assert.equal(state[name+"Volume"],.35);assert.equal(state[name+"Muted"],false);}
  app.setSoundPreferences(readJson("sound",null),false);
  assert.equal(app.volume,.35);
 } finally {if(original===undefined)delete globalThis.localStorage;else globalThis.localStorage=original;}
});
