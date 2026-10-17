// Prepare a bounded overview for the local projector without changing source
// evidence. Pixel-level facts continue to refer to the original file.
// Pure Node: the PNG decoder is terminal-image.js's, the encoder is zlib.
import fs from 'node:fs';
import {deflateSync} from 'node:zlib';
import {decodePng} from './terminal-image.js';

const PNG_SIGNATURE=Buffer.from([137,80,78,71,13,10,26,10]);

const CRC_TABLE=Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function crc32(buf){let c=0xffffffff;for(const byte of buf)c=CRC_TABLE[(c^byte)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
function chunk(type,data){const out=Buffer.alloc(12+data.length);out.writeUInt32BE(data.length,0);out.write(type,4,'ascii');data.copy(out,8);out.writeUInt32BE(crc32(out.subarray(4,8+data.length)),8+data.length);return out;}

// Box-average RGBA → RGB (alpha composited on black, as the decoder's other
// caller does), then encode as an unfiltered 8-bit RGB PNG.
export function downscalePng({width,height,pixels},side){
 const scale=Math.max(width,height)/side;
 const w=Math.max(1,Math.round(width/scale)),h=Math.max(1,Math.round(height/scale));
 const raw=Buffer.alloc((w*3+1)*h);
 for(let y=0;y<h;y++){
  const y0=Math.floor(y*height/h),y1=Math.max(y0+1,Math.floor((y+1)*height/h));
  raw[y*(w*3+1)]=0;
  for(let x=0;x<w;x++){
   const x0=Math.floor(x*width/w),x1=Math.max(x0+1,Math.floor((x+1)*width/w));
   let r=0,g=0,b=0,n=0;
   for(let sy=y0;sy<y1;sy++)for(let sx=x0;sx<x1;sx++){const i=(sy*width+sx)*4,a=pixels[i+3]/255;r+=pixels[i]*a;g+=pixels[i+1]*a;b+=pixels[i+2]*a;n++;}
   const o=y*(w*3+1)+1+x*3;raw[o]=Math.round(r/n);raw[o+1]=Math.round(g/n);raw[o+2]=Math.round(b/n);
  }
 }
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=2;
 return {bytes:Buffer.concat([PNG_SIGNATURE,chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]),delivered:[w,h]};
}

export function prepareVisionInput(file, {maxSide=Number(process.env.BANTAM_VISION_MAX_SIDE)||768, decode=decodePng}={}) {
 const bytes=fs.readFileSync(file);
 const side=Number.isSafeInteger(maxSide)&&maxSide>=256&&maxSide<=4096?maxSide:768;
 const png=bytes.length>=24&&bytes.subarray(0,8).equals(PNG_SIGNATURE);
 const original=png?[bytes.readUInt32BE(16),bytes.readUInt32BE(20)]:null;
 // Small images and non-PNG formats keep their exact encoded bytes.
 if(!original||Math.max(...original)<=side)return {bytes,original,delivered:original,resized:false,notice:''};
 const image=decode(file);
 // Palette, 16-bit and interlaced PNGs are outside the decoder; send them as
 // they are rather than fail the look, and say so.
 if(!image)return {bytes,original,delivered:original,resized:false,
  notice:`Local vision input: source ${original.join('×')}px sent unresized (this PNG encoding has no local overview). Small text/sprites need a crop or individual asset.`};
 const overview=downscalePng(image,side);
 return {bytes:overview.bytes,original,delivered:overview.delivered,resized:true,
  notice:`Local vision overview: source ${original.join('×')}px; delivered ${overview.delivered.join('×')}px, preserving the whole image. Small text/sprites need a legible contact-sheet page, crop or individual asset. Original file unchanged.`};
}
