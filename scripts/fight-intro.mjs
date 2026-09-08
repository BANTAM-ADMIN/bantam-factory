// A seekable Hyperframes composition built from the gallery's recorded highlight.
const E=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const J=value=>JSON.stringify(value).replace(/</g,'\\u003c');
export function introFacts(feature){
  if(!feature)return null;
  const {bantam,peer,card}=feature;
  if(bantam.arm!=='bantam-local-27b'||!['hermes','opencode','deepseek-local-27b'].includes(peer.arm)
    ||![bantam,peer].every(row=>row.passed===true&&row.wallMs>0&&/^Qwen 27B · same local (?:model|weights)$/.test(row.model)))throw Error('Intro requires a completed same-model comparison');
  return {card:card.id,title:card.title,peer:peer.label,bantamMs:bantam.wallMs,peerMs:peer.wallMs,ratio:peer.wallMs/bantam.wallMs,
    href:`../../${card.id}/share/index.html#${new URLSearchParams({card:card.id,view:'results',layout:'compare',left:bantam.arm,right:peer.arm})}`};
}
export function renderFightIntro(feature,{assetRoot='../'}={}){
  const facts=introFacts(feature);if(!facts)return null;
  if(!['../','assets/'].includes(assetRoot))throw Error('Unexpected composition asset root');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=1920,height=1080"><title>BANTAM FACTORY · Meet your factory</title>
  <script src="${assetRoot}gsap-3.14.2.min.js"></script><style>
  @font-face{font-family:Display;src:url('${assetRoot}barlow-condensed-800.ttf');font-weight:800}@font-face{font-family:Body;src:url('${assetRoot}manrope-400.ttf');font-weight:400}
  *{box-sizing:border-box}body{margin:0;background:#20251f;color:#20251f;font-family:Body,Arial,sans-serif}#factory-film{width:1920px;height:1080px;position:relative;overflow:hidden}h1,h2,p{margin:0}p>span{display:block}.scene{position:absolute;inset:0;width:1920px;height:1080px;overflow:hidden;background:#e4ded0}.label{position:absolute;left:110px;top:82px;font:24px monospace;letter-spacing:3px}.film-heading{font:800 188px/1.23 Display,sans-serif;letter-spacing:-2px;position:absolute;left:110px;top:170px;width:1150px}.film-heading span{display:block}.accent{color:#b83b1e}.disc{width:780px;height:780px;position:absolute;border-radius:50%;right:85px;top:160px;background:#f1bf36}.hero-rooster{position:absolute;right:70px;top:65px;width:860px;height:950px;object-fit:contain}.brand-line{position:absolute;left:110px;bottom:95px;font:800 51px Display,sans-serif}.rule{position:absolute;left:110px;right:110px;top:157px;height:3px;background:currentColor}.small{font:27px Body,sans-serif}.subline{position:absolute;left:115px;bottom:195px;font:31px Body,sans-serif;max-width:790px;line-height:1.5}.scene-two{background:#f1bf36}.scene-two h2{font:800 120px Display,sans-serif;position:absolute;left:110px;top:190px}.station-row{position:absolute;left:110px;right:110px;top:414px;display:grid;grid-template-columns:1fr 70px 1fr 70px 1fr;gap:20px;align-items:center}.station{border:3px solid #20251f;padding:34px 40px;height:330px;background:#e4ded0;position:relative}.station small{font:23px monospace}.station h3{font:800 70px Display,sans-serif;margin:30px 0 12px}.station p{font:26px/1.5 Body,sans-serif;max-width:380px}.arrow{font:60px Display,sans-serif;text-align:center}.factory-note{position:absolute;left:110px;bottom:155px;font:35px Body,sans-serif}.station-number{position:absolute;right:28px;top:20px;font:800 55px Display,sans-serif;color:#b83b1e}.scene-three{background:#20251f;color:#e4ded0}.scene-three h2{font:800 104px Display,sans-serif;position:absolute;left:110px;top:180px}.bout{position:absolute;left:110px;right:110px;top:355px;display:grid;grid-template-columns:1fr 90px 1fr;gap:25px;align-items:center}.corner{padding:44px;height:425px;background:#e4ded0;color:#20251f}.corner.factory{background:#f1bf36}.corner-name{font:800 64px Display,sans-serif;display:block;white-space:nowrap}.corner-time{font:800 200px/.95 Display,sans-serif;display:block;margin:27px 0 20px}.corner-time small{font:800 65px Display,sans-serif}.corner-finish{font:23px monospace;letter-spacing:1px}.versus{font:800 60px Display,sans-serif;text-align:center;color:#f1bf36}.fight-fact{position:absolute;left:110px;bottom:125px;font:28px/1.5 Body,sans-serif;width:1100px}.fight-ratio{position:absolute;right:110px;bottom:115px;font:800 110px Display,sans-serif;color:#f1bf36}.scene-four{background:#b83b1e;color:#fff7e3}.outro-heading{position:absolute;left:715px;top:180px;font:800 187px/1.23 Display,sans-serif;width:1110px}.outro-heading span{display:block}.outro-rooster{position:absolute;left:55px;top:140px;width:650px;height:800px;object-fit:contain}.outro-circle{position:absolute;left:80px;top:225px;width:610px;height:610px;background:#f1bf36;border-radius:50%}.outro-tagline{position:absolute;left:724px;top:715px;font:34px/1.5 Body,sans-serif;max-width:1020px}.outro-link{position:absolute;left:724px;bottom:124px;font:25px monospace;letter-spacing:1px}
  </style></head><body><div id="factory-film" data-composition-id="bantam-intro" data-start="0" data-width="1920" data-height="1080" data-duration="18">
  <section id="intro-brand" class="scene clip" data-start="0" data-duration="4.25" data-track-index="0"><p class="label">THE CODING FACTORY IN YOUR CORNER</p><div class="rule"></div><div class="disc"></div><h1 class="film-heading"><span id="small-model">SMALL MODEL.</span><span id="heavy-hitter" class="accent">HEAVY HITTER.</span></h1><img id="intro-rooster" class="hero-rooster" data-start="0" data-duration="4.25" src="${assetRoot}bantam-rooster-v1.png" alt="Bantam rooster" width="1232" height="1296"><p class="subline"><span>Your model is the worker.</span><span>Give it a whole factory.</span></p><p class="brand-line">BANTAM FACTORY</p></section>
  <section id="intro-factory" class="scene scene-two clip" data-start="4.25" data-duration="4.5" data-track-index="1"><p class="label">HOW THE FACTORY WORKS</p><div class="rule"></div><h2>BIG JOBS. CHICKEN PROBLEMS.</h2><div class="station-row"><article class="station"><small>FOCUSED WORK</small><span class="station-number">01</span><h3>BUILD.</h3><p><span>One station.</span><span>A concrete next step.</span></p></article><span class="arrow">→</span><article class="station"><small>A SECOND LOOK</small><span class="station-number">02</span><h3>REVIEW.</h3><p><span>Inspect the work.</span><span>Design the check.</span></p></article><span class="arrow">→</span><article class="station"><small>REAL VERIFICATION</small><span class="station-number">03</span><h3>PROVE IT.</h3><p><span>Run the check.</span><span>Repair or deliver.</span></p></article></div><p class="factory-note">The model works. The factory directs the next step.</p></section>
  <section id="intro-fight" class="scene scene-three clip" data-start="8.75" data-duration="6.25" data-track-index="2"><p class="label">${E(facts.title.toUpperCase())} / SAME LOCAL QWEN 27B</p><div class="rule"></div><h2>CHANGE THE HARNESS. WATCH THE WORK.</h2><div class="bout"><article class="corner factory"><span class="corner-name">BANTAM FACTORY</span><strong class="corner-time">${(facts.bantamMs/1000).toFixed(1)}<small>s</small></strong><span class="corner-finish">✓ ACCEPTED & COMPLETED</span></article><span class="versus">VS.</span><article class="corner"><span class="corner-name">${E(facts.peer.toUpperCase())}</span><strong class="corner-time">${(facts.peerMs/1000).toFixed(1)}<small>s</small></strong><span class="corner-finish">✓ ACCEPTED & COMPLETED</span></article></div><p class="fight-fact"><span>Same work order. Same local weights. Both passed.</span><span>Recorded elapsed time for this task.</span></p><strong class="fight-ratio">${facts.ratio.toFixed(1)}×</strong></section>
  <section id="intro-outro" class="scene scene-four clip" data-start="15" data-duration="3" data-track-index="3"><p class="label">PUT YOUR MODEL TO WORK</p><div class="rule"></div><div class="outro-circle"></div><img id="outro-rooster" class="outro-rooster" data-start="15" data-duration="3" src="${assetRoot}bantam-rooster-v1.png" alt="" width="1232" height="1296"><h2 class="outro-heading"><span>BANTAM</span><span>FACTORY.</span></h2><p class="outro-tagline"><span>Your model. Your hardware.</span><span>A better coding factory.</span></p><p class="outro-link">bantam-admin.github.io/bantam-factory</p></section>
  </div><script id="intro-facts" type="application/json">${J(facts)}</script><script>
  window.__timelines=window.__timelines||{};
  const tl=gsap.timeline({paused:true});
  gsap.set(['#intro-factory','#intro-fight','#intro-outro'],{autoAlpha:0});
  tl.fromTo('#small-model',{y:40,opacity:0},{y:0,opacity:1,duration:.6,ease:'power3.out'},.15);
  tl.fromTo('#heavy-hitter',{scale:1.12,opacity:0},{scale:1,opacity:1,duration:.55,ease:'expo.out'},.42);
  tl.fromTo('.hero-rooster',{y:65,rotation:-4,opacity:0},{y:0,rotation:0,opacity:1,duration:.9,ease:'power3.out'},.2);
  tl.fromTo('.disc',{scale:.7},{scale:1,duration:1.1,ease:'power3.out'},0);
  tl.set('#intro-brand',{autoAlpha:0},4.25).set('#intro-factory',{autoAlpha:1},4.25);
  tl.fromTo('.scene-two h2',{y:35,opacity:0},{y:0,opacity:1,duration:.45},4.3);
  tl.fromTo('.station',{y:60,opacity:0},{y:0,opacity:1,duration:.5,stagger:.25,ease:'power3.out'},4.7);
  tl.fromTo('.arrow',{x:-15,opacity:0},{x:0,opacity:1,duration:.35,stagger:.25},5.0);
  tl.fromTo('.factory-note',{opacity:0},{opacity:1,duration:.4},5.7);
  tl.set('#intro-factory',{autoAlpha:0},8.75).set('#intro-fight',{autoAlpha:1},8.75);
  tl.fromTo('.scene-three h2',{y:30,opacity:0},{y:0,opacity:1,duration:.45},8.85);
  tl.fromTo('.corner.factory',{x:-80,opacity:0},{x:0,opacity:1,duration:.6,ease:'power3.out'},9.15);
  tl.fromTo('.corner:not(.factory)',{x:80,opacity:0},{x:0,opacity:1,duration:.6,ease:'power3.out'},9.35);
  tl.fromTo('.versus',{scale:1.3,opacity:0},{scale:1,opacity:1,duration:.35,ease:'expo.out'},9.75);
  tl.fromTo('.fight-ratio',{scale:1.2,opacity:0},{scale:1,opacity:1,duration:.45,ease:'expo.out'},10.25);
  tl.set('#intro-fight',{autoAlpha:0},15).set('#intro-outro',{autoAlpha:1},15);
  tl.fromTo('.outro-heading',{y:50,opacity:0},{y:0,opacity:1,duration:.6,ease:'power3.out'},15.05);
  tl.fromTo('.outro-rooster',{x:-40,opacity:0},{x:0,opacity:1,duration:.65,ease:'power3.out'},15.15);
  tl.fromTo('.outro-tagline,.outro-link',{opacity:0},{opacity:1,duration:.5,stagger:.1},15.65);
  window.__timelines['bantam-intro']=tl;
  </script></body></html>`;
}

export function renderIntroPlayer(feature){
  const facts=introFacts(feature);if(!facts)return null;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Meet BANTAM FACTORY · 18-second introduction</title><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>*{box-sizing:border-box}body{margin:0;background:#20251f;color:#e4ded0;font:13px/1.6 Arial,sans-serif}.player{max-width:1280px;margin:auto;padding:24px}header{display:flex;justify-content:space-between;gap:20px;align-items:center;padding:0 0 18px}h1{font-size:16px;margin:0}a{color:inherit;text-underline-offset:4px}.viewport{width:100%;aspect-ratio:16/9;position:relative;overflow:hidden;background:#e4ded0}iframe{border:0;position:absolute;left:0;top:0;width:1920px;height:1080px;transform-origin:0 0}.controls{display:flex;gap:16px;align-items:center;padding:18px 0}button{border:1px solid #f1bf36;background:#f1bf36;color:#20251f;font-weight:bold;padding:10px 22px;cursor:pointer;min-width:90px}input{accent-color:#f1bf36;flex:1;min-width:70px}output{font:12px monospace;white-space:nowrap}.note{font-size:11px;color:#bbc4b1}button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid #f1bf36;outline-offset:4px}@media(max-width:600px){.player{padding:14px}header{font-size:11px}h1{font-size:13px}.controls{gap:10px}button{padding:9px 13px;min-width:70px}output{font-size:10px}}</style></head><body><main class="player"><header><h1>BANTAM FACTORY · Meet your factory</h1><a href="../../fights.html">All fights ↗</a></header><div class="viewport"><iframe id="film" src="index.html" title="BANTAM FACTORY animated introduction"></iframe></div><div class="controls"><button id="play" disabled>Play</button><label for="seek" hidden>Introduction playback position</label><input id="seek" type="range" min="0" max="18" step="0.01" value="0" aria-label="Introduction playback position" disabled><output id="time">0:00 / 0:18</output></div><p class="note">18-second introduction · Sound off · <a href="${E(facts.href)}">Open the complete recorded fight →</a></p></main><script>(${introPlayerBrowser.toString()})();</script></body></html>`;
}

export function introPlayerBrowser(){
  const frame=document.getElementById('film'),play=document.getElementById('play'),seek=document.getElementById('seek'),time=document.getElementById('time');
  let tl=null;
  function size(){frame.style.transform='scale('+frame.parentElement.clientWidth/1920+')';}
  new ResizeObserver(size).observe(frame.parentElement);size();
  function update(){const t=Math.min(18,tl.time());seek.value=t;time.textContent='0:'+String(Math.floor(t)).padStart(2,'0')+' / 0:18';play.textContent=tl.paused()?'Play':'Pause';}
  frame.addEventListener('load',async()=>{
    await frame.contentDocument.fonts.ready;
    tl=frame.contentWindow.__timelines?.['bantam-intro'];
    if(!tl){time.textContent='Could not load introduction';return;}
    // Extend the player's hold, not the composition's render duration.
    tl.to({hold:0},{hold:1,duration:Math.max(0,18-tl.duration())},tl.duration());
    tl.pause(1.4);seek.disabled=false;play.disabled=false;
    tl.eventCallback('onUpdate',update);tl.eventCallback('onComplete',()=>{tl.pause();update();play.textContent='Replay';});
    play.onclick=()=>{if(tl.time()>=17.99)tl.restart();else if(tl.paused())tl.play();else tl.pause();update();};
    seek.oninput=()=>{tl.pause(Number(seek.value));update();};
    document.addEventListener('visibilitychange',()=>{if(document.hidden){tl.pause();update();}});
    update();
  });
}
