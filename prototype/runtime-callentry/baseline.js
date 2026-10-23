// SPDX-License-Identifier: AGPL-3.0-or-later
importScripts('/runtime/maxima-session.js','/native/stack-parser.js','/native/input.js','/native/engine.js','/suite.js');
self.onmessage=async ({data})=>{
 const session=new MaximaSession({baseURL:'/maxima-runtime/',stackSourceURL:'/stack-sources.json',childURL:new URL('/runtime/',location.href),loadTimeoutMs:240000});
 try {const initialization=await session.init();const suite=await runSuite(session,data.fixtures,data.question);postMessage({type:'complete',initialization,suite});}
 catch(e){postMessage({type:'failure',error:String(e.stack||e)});}
 finally{session.terminate();}
};
