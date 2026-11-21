import json,re,html,sys,collections,os
S=sys.argv[1]
F={f['path']:f for f in json.load(open(S+'/files.json'))}
def E(n): return 'src/engine/'+n
rules=[
 ("boot","Start-up and command line","Where the server starts, reads its settings and launches one fleet per player.",lambda p:p.startswith('src/cli/') or p.startswith('src/auth/') or p in(E('tenantRegistry.ts'),E('buildInfo.ts'))),
 ("api","Game API client","Every call to SpaceTraders goes through here: auth, the shared rate limiter, proxy lanes and the call log.",lambda p:p.startswith('src/core/') or any(p==E(x) for x in['apiLanes.ts','lanePool.ts','laneBytes.ts','crawlerProxy.ts','shipSnapshots.ts'])),
 ("db","Database layer","Postgres pool, migrations and Store, the single class every engine module reads and writes through.",lambda p:p.startswith('src/db/')),
 ("core","Fleet engine core","FleetManager (fleet.ts) runs each player's tick: it owns the ships, wires every subsystem together and saves state.",lambda p:p in[E(x) for x in['fleet.ts','scheduler.ts','intent.ts','shipRegistry.ts','shipBook.ts','shipProxy.ts','shipRows.ts','state.ts','registry.ts','market.ts','persistedTimers.ts','fleetMemory.ts','changeTracker.ts','staleCache.ts','reminders.ts','transit.ts','overdueTransit.ts','suspendedRepair.ts','universe.ts','liveFeed.ts','liveDiff.ts','liveViews.ts','tripHistory.ts']]),
 ("agents","Ship agents","One agent per ship, by role: trader, keeper and tour (agent.ts), scout, siphoner, miner. Each decides its own next step.",lambda p:p in[E(x) for x in['agent.ts','agentStep.ts','trader.ts','scout.ts','siphoner.ts','flightMode.ts','loadout.ts','loadoutGa.ts','survey.ts','surveyTour.ts','surveyTourControl.ts','miningFields.ts','traderRecord.ts','traderStates.ts','traderEligibility.ts','idleTraders.ts','shipLotPolicy.ts','tourPriority.ts','warpTour.ts']]),
 ("routes","Routes and dispatch","Builds every buy-here/sell-there route from market prices, prices our own impact, and gives the best ones to the best-placed ships.",lambda p:p in[E(x) for x in['dispatcher.ts','matching.ts','dispatchExplain.ts','chain.ts','circuit.ts','lotImpact.ts','fillFit.ts','buyGuard.ts','priceSanity.ts','marketCrash.ts','thinMarket.ts','sinkPreflight.ts','lotGuard.ts','lossAllowance.ts','floorRedirect.ts','positioningCost.ts','shipSpeed.ts','shipReach.ts','haulLimit.ts','jumpGraph.ts','routeBlocks.ts','routeEconomics.ts','routeFit.ts','routeHeat.ts','routePrefilter.ts','routeReach.ts','routeReuse.ts','routeRounds.ts','routeStatus.ts','routeTag.ts','runsLeft.ts','tradeBudget.ts','tripBudget.ts','tripScale.ts','tripSize.ts','tripSpacing.ts','transactionLimit.ts','unflownRoutes.ts','supplyChain.ts','jumpCashGuard.ts','cargoValue.ts']]),
 ("keepers","Keepers","Probes parked on markets to keep prices fresh: which markets get one, buying and delivering them, top-up, triage and loops.",lambda p:(p.startswith('src/engine/') and os.path.basename(p).startswith('keeper')) or p in[E('idleSystems.ts'),E('marketDirectory.ts')]),
 ("expand","Exploration and fresh systems","Finding systems, the scouted / staged / live queue, tours that price them, and when to release the next one.",lambda p:p.startswith('src/engine/systems/') or p in[E(x) for x in['systemQueue.ts','systemRelease.ts','queueTours.ts','stagedScoutProbe.ts','listedFirstTour.ts','remoteSurvey.ts','arrivalSurvey.ts','galaxy.ts','galaxyCrawler.ts','galaxyVersion.ts','gateCheckQueue.ts','jumpRejection.ts','chartCheck.ts','chartProbe.ts','chartReward.ts','explorerReport.ts','systemWorth.ts','surveyCoverage.ts','queuePrune.ts','pricedShare.ts','systemClassifier.ts']]),
 ("missions","Missions, contracts and feeds","Longer jobs: gate construction supply, contracts, feeder crews, the warehouse, and the scripted opening at reset.",lambda p:p.startswith('src/engine/') and any(os.path.basename(p).startswith(x) for x in['mission','contract','feed','opening','gateSnapshot'])),
 ("rules","Doctrine and approvals","The standing-order settings the engine reads, and the operator approval gate for purchases and risky actions.",lambda p:any(p==E(x) for x in['doctrine.ts','doctrineGroups.ts','approvals.ts','approvalsView.ts','approvedSale.ts','floorSaleApproval.ts','buyAdvice.ts','blockedGoods.ts','yardScan.ts','shipyardNearest.ts'])),
 ("money","Money, analysis and seasons","Profit and pace from the ledger, economy alerts, week-over-week, and the analysis engine that checks estimates against results.",lambda p:p.startswith('src/engine/analysis/') or any(p==E(x) for x in['metrics.ts','pace.ts','paceSplit.ts','profitCurve.ts','economyHealth.ts','growth.ts','worthRate.ts','weekCompare.ts','tradeTempo.ts','deadhead.ts','actionEvents.ts','season.ts','seasonClose.ts','hourlySnapshot.ts','runTimeline.ts','marketSpread.ts','marketChanges.ts','rivalActivity.ts','agentWatch.ts','agentWatcher.ts','startScore.ts','startScout.ts'])),
 ("reset","Weekly reset","Detecting the weekly universe reset, winding down before it, and recovering after.",lambda p:any(p==E(x) for x in['resetWatcher.ts','resetWatcherLive.ts','resetWindDown.ts','windDownScrap.ts'])),
 ("assist","Co-pilot, alerts and crew log","The chat co-pilot, the advisory decision model, push and Discord alerts, triage, and the ships' narrative log.",lambda p:p.startswith('src/engine/notify/') or any(p==E(x) for x in['agentChat.ts','copilotRouter.ts','copilotRouterLive.ts','judge.ts','judgeLive.ts','jevClient.ts','attention.ts','attentionFeed.ts','triage.ts','discord.ts','crewLog.ts','narrative.ts','personas.ts','shipLedgerEvent.ts'])),
 ("health","Server health","Health board, stall alerts, what happens after a restart.",lambda p:any(p==E(x) for x in['serverHealth.ts','healthRecorder.ts','stallAlerts.ts','bootWatch.ts'])),
 ("web","Web server and screens","Express routes behind the Deck (desktop) and Tower (phone) dashboards, the admin page and the public galaxy map.",lambda p:p.startswith('src/http/')),
 ("mcp","MCP server","The tools an AI agent (like this one) uses to read and command the fleet.",lambda p:p.startswith('src/mcp/')),
 ("ops","Ops investigation tools","Read-only investigation tools shared by MCP and HTTP: logs, P&L, queue, keeper coverage and more.",lambda p:p.startswith('src/ops/')),
]
area={}
for p in F:
    for gid,_,_,fn in rules:
        if fn(p): area[p]=gid; break
    else: area[p]='core'
meta={g[0]:(g[1],g[2]) for g in rules}
files_by=collections.defaultdict(list)
for p,a in area.items(): files_by[a].append(p)
edges=collections.Counter()
for p,f in F.items():
    for i in f['imports']:
        if i in area and area[i]!=area[p]: edges[(area[p],area[i])]+=1
lines={a:sum(F[p]['lines'] for p in ps) for a,ps in files_by.items()}
imported_by=collections.defaultdict(set)
for p,f in F.items():
    for i in f['imports']: imported_by[i].add(p)
order=[g[0] for g in rules]
json.dump({'edges':[[a,b,n] for (a,b),n in edges.most_common()],'lines':lines,'counts':{a:len(v) for a,v in files_by.items()}},open(S+'/areas.json','w'))
# overview mermaid: strongest edges
def label(a): return meta[a][0].replace('"',"'")
ov=["flowchart LR"]
for a in order: ov.append(f'  {a}["{label(a)}<br/><small>{len(files_by[a])} files · {lines[a]:,} lines</small>"]')
kept=[(a,b,n) for (a,b),n in edges.most_common() if n>=3]
for a,b,n in kept: ov.append(f'  {a} -->|{n}| {b}')
overview="\n".join(ov)
secs=[];toc=[]
for a in order:
    ps=sorted(files_by[a],key=lambda p:-F[p]['lines'])
    outs=sorted([(b,n) for (x,b),n in edges.items() if x==a],key=lambda t:-t[1])
    ins=sorted([(x,n) for (x,b),n in edges.items() if b==a],key=lambda t:-t[1])
    rows=[]
    for p in ps:
        f=F[p]; name=p.replace('src/','')
        h=html.escape(f['head'][:220]) if f['head'] else '<span class="none">No header comment.</span>'
        imp=[i.replace('src/','') for i in f['imports'] if i in F]
        by=sorted(x.replace('src/','') for x in imported_by.get(p,()))
        rows.append(f'<details class="file" data-name="{html.escape(name.lower())}"><summary><code>{html.escape(name)}</code><span class="ln">{f["lines"]:,}</span><span class="h">{h}</span></summary><div class="io"><div><b>Uses ({len(imp)})</b><p>{", ".join(f"<code>{html.escape(x)}</code>" for x in imp) or "nothing local"}</p></div><div><b>Used by ({len(by)})</b><p>{", ".join(f"<code>{html.escape(x)}</code>" for x in by[:40]) or "nothing (entry point or tool)"}{" …" if len(by)>40 else ""}</p></div></div></details>')
    chips=lambda L:" ".join(f'<a class="chip" href="#{b}">{html.escape(meta[b][0])} <span>{n}</span></a>' for b,n in L) or '<span class="none">none</span>'
    toc.append(f'<a href="#{a}">{html.escape(meta[a][0])}</a>')
    secs.append(f'<section id="{a}"><div class="sh"><h2>{html.escape(meta[a][0])}</h2><span class="stat">{len(ps)} files · {lines[a]:,} lines</span></div><p class="lede">{html.escape(meta[a][1])}</p><div class="deps"><div><b>Depends on</b> {chips(outs)}</div><div><b>Used by</b> {chips(ins)}</div></div><div class="files">{"".join(rows)}</div></section>')
json.dump({'overview':overview,'sections':"\n".join(secs),'toc':"".join(toc),'nfiles':len(F),'nlines':sum(f['lines'] for f in F.values())},open(S+'/parts.json','w'))
print(len(F), {a:len(v) for a,v in files_by.items()})
print(kept[:40])
