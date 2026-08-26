import math, json
BG="#0d0f12"; N=44
def axis_of(base,ang,length,curl):
    a0=math.radians(ang);cu=math.radians(curl);p=[];d=[];x,y=base
    for i in range(N+1):
        t=i/N;dd=a0+cu*t*t;p.append((x,y));d.append(dd)
        x+=math.cos(dd)*length/N;y+=math.sin(dd)*length/N
    return p,d
def feather(base,ang,length,width,curl):
    p,dirs=axis_of(base,ang,length,curl)
    w=lambda t: width*(1-t)**0.8*(0.40+0.60*min(1.0,t*5))
    L=[];R=[]
    for i,((px,py),dd) in enumerate(zip(p,dirs)):
        t=i/N;nx,ny=-math.sin(dd),math.cos(dd);hw=w(t)/2
        L.append((px+nx*hw,py+ny*hw));R.append((px-nx*hw,py-ny*hw))
    f=lambda q:f"{q[0]:.1f} {q[1]:.1f}"
    return "M"+"L".join(f(q) for q in L+R[::-1])+"Z"
def quill(base,ang,length,curl,a=0.28,b=0.80):
    p,_=axis_of(base,ang,length,curl)
    f=lambda q:f"{q[0]:.1f} {q[1]:.1f}"
    return "M"+"L".join(f(q) for q in p[int(N*a):int(N*b)])

BODY=("M3 29C7 26 11 24 15 22.5C16.5 21.8 18 21 19 19.5"
      "L20.5 6L25.5 13.5L29.5 3L34 12L38.5 5L41.5 17"
      "C44 19.5 45.5 23 46 27C46.5 31 45.5 35 44 38"
      "C50 42 55 47 58 54C61.5 61.5 61.5 69 58 73.5C54 78 48 79.5 42 78.5"
      "C34 77.5 27 72.5 24 65C21 57.5 21 48.5 24 42C25 39 26 36 26 34"
      "C23 33 20 32 17 31.5C11 31 6 30 3 29Z")
WATTLE="M17.5 31.5C21 33 22.5 37 21 41C19.5 45 15.8 44.6 14.8 40.8C13.8 37 15 32.8 17.5 31.5Z"
WING="M31 52C37.5 49.5 44.5 51.5 48.5 57C51.5 61 51 65.5 47.5 67.5"
def leg(hip,foot,thick=4.4):
    hx,hy=hip;fx,fy=foot
    return (f'<path d="M{hx} {hy}C{hx-1} {hy+6} {fx-1} {fy-7} {fx} {fy}" stroke="currentColor" '
            f'stroke-width="{thick}" stroke-linecap="round" fill="none"/>'
            f'<path d="M{fx-7.5} {fy+4}L{fx} {fy}L{fx+8} {fy+3}M{fx} {fy}L{fx+1.5} {fy+6.5}" '
            f'stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>')
FS=[(-84,54,20,40),(-58,47,18,38),(-32,37,15,34)]
BASE=(57,56)
def mark(wing=True, qw=3.0):
    feathers="\n  ".join(f'<path d="{feather(BASE,*f)}"/>' for f in FS)
    quills="\n  ".join(f'<path d="{quill(BASE,f[0],f[1],f[3])}" stroke="{BG}" stroke-width="{qw}" fill="none" stroke-linecap="round"/>' for f in FS[:2])
    w=f'\n  <path d="{WING}" stroke="{BG}" stroke-width="3" fill="none" stroke-linecap="round"/>' if wing else ""
    return f'''
  {feathers}
  {quills}
  <path d="{BODY}"/>
  <path d="{WATTLE}"/>{w}
  {leg((40,76.5),(37,89))}
  {leg((52,74.5),(55,87))}
  <circle cx="27.5" cy="21" r="3" fill="{BG}"/>'''
mark = mark(wing=False).replace("#0d0f12", "var(--bg)")
import sys, pathlib
out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "bantam-mark.svg")
out.write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100" '
               'role="img" aria-label="BANTAM">\n  <title>BANTAM</title>\n  <g fill="#e8a33d">'
               + mark.replace("var(--bg)", "#0d0f12") + "</g>\n</svg>\n")
print(f"wrote {out} ({out.stat().st_size} bytes)")
