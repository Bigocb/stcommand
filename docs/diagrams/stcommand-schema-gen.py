import json, re, html, sys
S=sys.argv[1]
T={t['name']:t for t in json.load(open(S+'/schema.json'))}
groups=[
 ("accounts","Accounts and access","Who is playing and how they sign in. Every per-player table points at tenants.",
  ["tenants","sessions","tenant_mcp_keys","push_subscriptions"]),
 ("fleet","Fleet and ships","Per-player ship state: role, task, claims, what each hold carries, movement history. Keyed by (tenant_id, ship_symbol).",
  ["fleet_state","ship_state","ship_claims","ship_manifest","held_route","tour_queue","ship_movements","ship_position_history","ship_log","ship_persona","fleet_flags","state_snapshot"]),
 ("money","Money and trading","The ledger is every credit in or out (buys, sells, jumps, ships, contracts), kept across weekly resets by universe_key.",
  ["ledger","activity","wealth_samples","buckets","bucket_ledger","warehouse","warehouse_ledger","warehouse_targets"]),
 ("markets","Galaxy and markets (shared)","Facts about the galaxy itself, shared by every player and wiped at each server reset: systems, gates, markets, prices, shipyards.",
  ["galaxy_systems","galaxy_factions","galaxy_jump_costs","galaxy_gate_construction","galaxy_crawl_state","waypoint_charts","market_directory","market_latest","market_snapshots","market_transactions","shipyard_directory","shipyard_inventory","module_catalog","field_surveys","system_surveys"]),
 ("control","Plans, rules and approvals","Standing orders (doctrine), missions and feeds, the opening playbook, and what waits for the operator.",
  ["doctrine","doctrine_fires","doctrine_fire_log","missions","feed_missions","opening_templates","opening_tasks","pending_approvals","operator_actions","operator_notes","chat_messages"]),
 ("analysis","Analysis and seasons","What the engine planned versus what happened, saved findings, and week-over-week results.",
  ["action_events","analysis_findings","judge_decisions","seasons","season_weeks","run_results","run_timeline"]),
 ("ops","Server health","How the server itself is doing: tick timings, heartbeats, API budget and proxy bytes.",
  ["health_samples","instance_heartbeats","tick_step_timings","lane_bytes","fleet_events"]),
 ("rivals","Other players (public data)","Read from the public agent list and start-system gates; no token needed.",
  ["agent_sightings","agent_samples","agent_credit_snapshots","gate_progress_samples"]),
]
desc={
"tenants":"One row per player agent; game token and optional integrations stored encrypted.",
"sessions":"Dashboard sign-in sessions.","tenant_mcp_keys":"Hashed API keys for the MCP server.","push_subscriptions":"Web-push endpoints for alerts.",
"fleet_state":"Each ship's role (trader, keeper, tour...) and, for keepers, the market it camps.",
"ship_state":"Each ship's current task state machine step.","ship_claims":"Which subsystem owns a ship right now (mission, feed, operator).",
"ship_manifest":"What each hold carries and its cost basis.","held_route":"A route pinned to a ship by the operator.",
"tour_queue":"Stops left on a tour ship's market tour.","ship_movements":"Every navigate / jump / warp with distance and cost.",
"ship_position_history":"Position samples for the map trail.","ship_log":"Narrative log lines per ship.","ship_persona":"Personality assigned to a ship for its log.",
"fleet_flags":"Small durable key/value state the engine restores at boot.","state_snapshot":"Last full fleet state, for a fast dashboard load.",
"ledger":"Every credit movement; realized_pnl on sells; universe_key = agent@reset date.","activity":"Human-readable activity feed.",
"wealth_samples":"Wallet and cargo value over time.","buckets":"Budget buckets (share of income set aside).","bucket_ledger":"Changes to bucket balances.",
"warehouse":"Goods stockpiled for missions.","warehouse_ledger":"Changes to the warehouse.","warehouse_targets":"How much of a good to stockpile.",
"galaxy_systems":"Every system: position, waypoints and gates (JSON).","galaxy_factions":"Factions.","galaxy_jump_costs":"Cheapest gate path cost from a gate to a system.",
"galaxy_gate_construction":"Whether each jump gate is finished.","galaxy_crawl_state":"Resume cursor for the background galaxy crawl.",
"waypoint_charts":"Charted / uncharted waypoints.","market_directory":"What each market imports, exports and exchanges.",
"market_latest":"Newest price per market and good (the hot table routes read).","market_snapshots":"Every price read, for history and trends.",
"market_transactions":"Trades seen in market transaction logs.","shipyard_directory":"Which ship types each yard sells.",
"shipyard_inventory":"Yard listings with price and specs.","module_catalog":"Ship modules and mounts for sale.","field_surveys":"Asteroid surveys (deposits).",
"system_surveys":"When a player last surveyed a system and what it found.",
"doctrine":"Standing-order settings (value + on/off) per player.","doctrine_fires":"How often each rule fired.","doctrine_fire_log":"Each rule firing.",
"missions":"Multi-ship jobs, e.g. gate construction supply.","feed_missions":"Feeder crews that source a good into a market.",
"opening_templates":"Saved opening plans.","opening_tasks":"Steps of the opening plan being run.","pending_approvals":"Purchases and actions waiting for the operator.",
"operator_actions":"What the operator did (for play-style comparison).","operator_notes":"Free-text notes.","chat_messages":"Co-pilot chat history.",
"action_events":"Planned vs observed for trips, and every settings change with before/after.","analysis_findings":"Saved weekly analysis reports.",
"judge_decisions":"Advisory model answers, logged for calibration.","seasons":"A run of weeks.","season_weeks":"One week of a season with goals and record.",
"run_results":"End-of-week summary per agent.","run_timeline":"Credits and ships over a week.",
"health_samples":"Server health every minute.","instance_heartbeats":"Which server instances are alive.","tick_step_timings":"How long each engine tick step took.",
"lane_bytes":"Bytes sent through each API proxy lane per day.","fleet_events":"Notable engine events.",
"agent_sightings":"Every public agent: first seen, start system, credits.","agent_samples":"Agent credits and ships every 30 min.",
"agent_credit_snapshots":"Hourly agent credit snapshots.","gate_progress_samples":"Progress of other players' start-system gates.",
}
def ty(t):
    t=t.replace("timestamp with time zone","timestamptz").replace("timestamp without time zone","timestamp")
    t=re.sub(r"character varying(\(\d+\))?","varchar",t); t=re.sub(r"numeric\([^)]*\)","numeric",t)
    t=t.replace("double precision","float8").replace("[]","_arr").replace(" ","_")
    return t
def fkcols(t): 
    s=set()
    for f in (t.get('fks') or []): s.update(f['cols'])
    return s
# logical links (joined by value)
def logical(tn, members):
    t=T[tn]; cols={c['n'] for c in t['cols']}; out=[]
    def add(target,label):
        if target in members and target!=tn: out.append((target,label))
    if 'ship_symbol' in cols and 'tenant_id' in cols and tn!='fleet_state': add('fleet_state','ship_symbol')
    for c in ('waypoint_symbol',):
        if c in cols and tn not in('market_directory',): add('market_directory','waypoint_symbol')
    if tn in('market_latest','market_snapshots','market_transactions') : pass
    if 'system_symbol' in cols and tn!='galaxy_systems': add('galaxy_systems','system_symbol')
    if tn=='galaxy_jump_costs': add('galaxy_systems','to_system')
    if tn in('shipyard_inventory','module_catalog'): add('shipyard_directory','waypoint_symbol')
    if tn=='doctrine_fires' or tn=='doctrine_fire_log': add('doctrine','rule_key')
    if tn=='opening_tasks': add('opening_templates','tasks')
    if tn in('agent_samples','agent_credit_snapshots'): add('agent_sightings','agent_symbol')
    if tn=='warehouse_ledger' or tn=='warehouse_targets': add('warehouse','good_symbol')
    if tn=='bucket_ledger': add('buckets','bucket')
    if tn=='run_timeline': add('run_results','agent_symbol, reset_date')
    if tn=='season_weeks': add('analysis_findings','findings_id')
    return out
def mermaid(members, show_tenants):
    L=["erDiagram"]
    ents=list(members)+(["tenants"] if show_tenants and "tenants" not in members else [])
    for tn in ents:
        t=T[tn]; pk=set(t.get('pk') or []); fk=fkcols(t)
        L.append(f"  {tn} {{")
        cols=t['cols'] if tn in members else [c for c in t['cols'] if c['n'] in ('id','agent_symbol')]
        for c in cols:
            k=[]; 
            if c['n'] in pk: k.append("PK")
            if c['n'] in fk: k.append("FK")
            L.append(f"    {ty(c['t'])} {c['n']}{(' '+','.join(k)) if k else ''}")
        L.append("  }")
    for tn in members:
        for f in (T[tn].get('fks') or []):
            if f['ref'] in ents: L.append(f'  {f["ref"]} ||--o{{ {tn} : "{",".join(f["cols"])}"')
        for tgt,lab in logical(tn,set(members)):
            L.append(f'  {tgt} ||..o{{ {tn} : "{lab}"')
    return "\n".join(L)
sec=[]; toc=[]
for gid,gname,gtext,members in groups:
    members=[m for m in members if m in T]
    usesT=any(any(f['ref']=='tenants' for f in (T[m].get('fks') or [])) for m in members) and gid!='accounts'
    rows=[]
    for m in members:
        t=T[m]; pk=set(t.get('pk') or []); fk=fkcols(t)
        cl="".join(f'<li><code>{c["n"]}</code> <span class="ty">{html.escape(ty(c["t"]))}</span>{" <b class=k>PK</b>" if c["n"] in pk else ""}{" <b class=k>FK</b>" if c["n"] in fk else ""}</li>' for c in t['cols'])
        badges=('<span class="tag rls">per player</span>' if t['rls'] else '<span class="tag shared">shared</span>')
        rows.append(f'<details class="tbl" id="t-{m}" data-name="{m}"><summary><code>{m}</code> {badges}<span class="d">{html.escape(desc.get(m,""))}</span><span class="n">{len(t["cols"])} cols</span></summary><ul class="cols">{cl}</ul></details>')
    toc.append(f'<a href="#{gid}">{gname} <span>{len(members)}</span></a>')
    note = ' The <code>tenants</code> box is drawn in brief so the per-player links show.' if usesT else ''
    sec.append(f'''<section id="{gid}"><h2>{gname}</h2><p class="lede">{gtext}{note}</p>
<div class="diagram"><pre class="mermaid">{html.escape(mermaid(members,usesT))}</pre></div>
<div class="list">{"".join(rows)}</div></section>''')
total=len(T)
open(S+'/body.html','w').write("\n".join(sec))
open(S+'/toc.html','w').write("".join(toc))
print(total, sum(len(g[3]) for g in groups), set(T)-set(sum([g[3] for g in groups],[])))
