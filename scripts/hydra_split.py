import json,sys,collections
rows={}
for f in sys.argv[1:]:
    for r in json.load(open(f))['rows']:
        rows[(r['timestamp'],r['ship_symbol'],r['trade_symbol'],r['units'])]=r
rows=list(rows.values())
ts=sorted(r['timestamp'] for r in rows)
print('sells',len(rows),ts[0],ts[-1])
FED={'X1-AR36-F49','X1-AR36-D45','X1-AR36-G50','X1-AR36-F48'}
def buy(r):
    rt=r.get('route') or ''
    return rt.split('>')[0] if '>' in rt else None
g=collections.defaultdict(lambda:[0,0,0])  # units,pnl,n
gm=collections.defaultdict(lambda:[0,0,0])
gh=collections.defaultdict(lambda:[0,0])
nob=0;nopnl=0
for r in rows:
    b=buy(r); p=r['realized_pnl']
    if p is None: nopnl+=1; continue
    if not b: nob+=1; continue
    p=float(p); u=r['units']
    grp='fed' if b in FED else 'other'
    g[grp][0]+=u; g[grp][1]+=p; g[grp][2]+=1
    gm[(grp,b,r['trade_symbol'])][0]+=u; gm[(grp,b,r['trade_symbol'])][1]+=p; gm[(grp,b,r['trade_symbol'])][2]+=1
    # 4-hour block since reset 13:00
    import datetime
    t=datetime.datetime.fromisoformat(r['timestamp'].replace('Z','+00:00'))
    h=int((t-datetime.datetime(2026,11,22,13,tzinfo=datetime.timezone.utc)).total_seconds()//14400)
    gh[(grp,h)][0]+=u; gh[(grp,h)][1]+=p
print('no route',nob,'no pnl',nopnl)
for k,v in g.items(): print(k,'units',v[0],'profit',round(v[1]),'sales',v[2],'per unit',round(v[1]/v[0]))
print('--- by block (4h from reset)')
for k in sorted(gh): u,p=gh[k]; print(k,u,round(p),round(p/u) if u else 0)
print('--- top markets')
for k,v in sorted(gm.items(),key=lambda x:-x[1][1])[:22]: print(k,v[0],round(v[1]),round(v[1]/v[0]))
