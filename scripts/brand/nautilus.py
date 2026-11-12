"""ShellTeam nautilus mark (SHE-172).

Run it to regenerate frontend/static/{logo.svg, favicon.svg, favicon.ico, favicon-16/32.png,
apple-touch-icon.png, icon-192/512.png}. Needs rsvg-convert. The mark is a log spiral with
chambers cut by even gaps; full() has four chambers, small() three for sizes under 32 px.
Why a nautilus: docs/decisions/20261112-nautilus-logo.md
"""
import math
AMBER='#f59e0b'; INK='#1a1205'
def body(n, g, gap, span, inturn, r1=47, end=18, pad=5, uid='nt', color=AMBER, N=96):
    te=math.radians(end)
    R=lambda th: r1*g**((th-te)/(2*math.pi))
    P=lambda th,r: (r*math.cos(th), r*math.sin(th))
    outer=[P(th,R(th)) for th in (te-2*math.pi+2*math.pi*i/N for i in range(N+1))]
    xs=[p[0] for p in outer]; ys=[p[1] for p in outer]
    edge=2.0  # half of the rounding stroke
    w=max(xs)-min(xs)+2*edge; h=max(ys)-min(ys)+2*edge
    s=(100-2*pad)/max(w,h)
    ox=50-s*(max(xs)+min(xs))/2; oy=50-s*(max(ys)+min(ys))/2
    T=lambda p: (ox+s*p[0], oy+s*p[1])
    f=lambda pts: ' L'.join('%.1f %.1f'%T(p) for p in pts)
    inner=[P(th,R(th)) for th in (te-2*math.pi-2*math.pi*inturn*i/N for i in range(N+1))]
    sw=gap*s
    cuts=f'<path d="M{f(inner)}" stroke-linecap="round"/>'
    for i in range(1,n+1):
        th=te-2*math.pi*span*(i/(n+0.35))
        a=T(P(th,R(th-2*math.pi))); b=T(P(th,R(th)+6)); m=T(P(th+0.20,(R(th-2*math.pi)+R(th))/2))
        cuts+='<path d="M%.1f %.1f Q%.1f %.1f %.1f %.1f"/>'%(*a,*m,*b)
    return (f'<defs><mask id="{uid}"><rect width="100" height="100" fill="#fff"/><g fill="none" stroke="#000" stroke-width="{sw:.2f}">{cuts}</g></mask></defs>'
            f'<path d="M{f(outer)} Z" fill="{color}" stroke="{color}" stroke-width="{2*edge*s:.2f}" stroke-linejoin="round" mask="url(#{uid})"/>')
def full(uid='nt', color=AMBER, pad=5): return body(4,2.6,5.0,0.78,0.9,uid=uid,color=color,pad=pad)
def small(uid='nt', color=AMBER, pad=4): return body(3,2.4,5.6,0.70,0.75,uid=uid,color=color,pad=pad)
def svg(b, label='ShellTeam'): return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="{label}">{b}</svg>'
def tile(b_ink, radius=0): return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="{radius}" fill="{AMBER}"/>{b_ink}</svg>'
if __name__=='__main__':
    import subprocess, struct, io, sys
    import pathlib; S=str(pathlib.Path(__file__).resolve().parents[2]/'frontend'/'static')
    open(f'{S}/logo.svg','w').write(svg(full(),'ShellTeam nautilus mark')+'\n')
    open(f'{S}/favicon.svg','w').write(svg(small(),'ShellTeam nautilus mark, small')+'\n')
    open('/tmp/shellteam-tile.svg','w').write(tile(full(color=INK,pad=16)))
    r=lambda src,w,out: subprocess.run(['rsvg-convert','-w',str(w),'-h',str(w),src,'-o',out],check=True)
    for w in (16,32,48,64): r(f'{S}/favicon.svg',w,f'/tmp/shellteam-f{w}.png')
    for w,name in ((16,'favicon-16.png'),(32,'favicon-32.png')): r(f'{S}/favicon.svg',w,f'{S}/{name}')
    for w,name in ((180,'apple-touch-icon.png'),(192,'icon-192.png'),(512,'icon-512.png')): r('/tmp/shellteam-tile.svg',w,f'{S}/{name}')
    pngs=[open(f'/tmp/shellteam-f{w}.png','rb').read() for w in (16,32,48,64)]
    out=io.BytesIO(); out.write(struct.pack('<HHH',0,1,4)); off=6+16*4
    for w,p in zip((16,32,48,64),pngs):
        out.write(struct.pack('<BBBBHHII',w,w,0,0,1,32,len(p),off)); off+=len(p)
    for p in pngs: out.write(p)
    open(f'{S}/favicon.ico','wb').write(out.getvalue())
    print(len(svg(full())), len(svg(small())))
