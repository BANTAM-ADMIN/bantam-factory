// The masthead bird uses the same terminal sprite on every public page.
(() => {
  'use strict';
  const canvas=document.getElementById('headerRooster'),sprite=window.ROOSTER;
  if(!canvas||!sprite)return;
  const ctx=canvas.getContext('2d'),reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const color=h=>h==='x'?null:sprite.palette[parseInt(h,16)];
  const names=['idle','idle','peck','idle','flap','idle','crow','idle'];
  let sequence=0,frame=0,timer,visible=true;
  function draw(name,index){
    ctx.clearRect(0,0,22,22);
    sprite.anims[name].frames[index].forEach((row,y)=>{
      for(let i=0;i<row.length;i+=3){
        const glyph=row[i],fg=color(row[i+1]),bg=color(row[i+2]);
        const top=glyph==='1'?fg:bg,bottom=glyph==='2'?fg:bg;
        if(top){ctx.fillStyle=top;ctx.fillRect(i/3,y*2,1,1);}
        if(bottom){ctx.fillStyle=bottom;ctx.fillRect(i/3,y*2+1,1,1);}
      }
    });
  }
  function tick(){
    if(reduced.matches||document.hidden||!visible)return;
    const name=names[sequence%names.length],anim=sprite.anims[name];
    draw(name,frame++);
    if(frame===anim.frames.length){frame=0;sequence++;}
    timer=setTimeout(tick,1000/anim.fps);
  }
  function resume(){clearTimeout(timer);if(reduced.matches)draw('idle',0);else tick();}
  new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;resume();}).observe(canvas);
  document.addEventListener('visibilitychange',resume);
  reduced.addEventListener('change',resume);
  draw('idle',0);
})();
