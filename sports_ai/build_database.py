#!/usr/bin/env python3
"""Normalize downloaded football, tennis and NBA results into SQLite."""
import csv, json, sqlite3, zipfile
from pathlib import Path
from datetime import datetime, timezone
ROOT=Path(__file__).resolve().parents[1]
RAW=ROOT/'data'/'history'/'raw'
OUT=ROOT/'data'/'history'/'ash_sports_history.sqlite'

def main():
    OUT.parent.mkdir(parents=True,exist_ok=True)
    if OUT.exists(): OUT.unlink()
    db=sqlite3.connect(OUT)
    db.execute('PRAGMA journal_mode=DELETE')
    db.execute('''CREATE TABLE matches(id INTEGER PRIMARY KEY, sport TEXT NOT NULL, competition TEXT, season TEXT, match_date TEXT, participant_a TEXT NOT NULL, participant_b TEXT NOT NULL, score_a REAL, score_b REAL, winner TEXT, source TEXT NOT NULL, raw_json TEXT)''')
    db.execute('CREATE INDEX idx_matches_sport_date ON matches(sport, match_date)')
    db.execute('CREATE INDEX idx_matches_participants ON matches(participant_a, participant_b)')
    count={'football':0,'tennis':0,'basketball':0}
    def add(sport,competition,season,date,a,b,sa,sb,winner,source,raw=None):
        if not a or not b: return
        db.execute('INSERT INTO matches(sport,competition,season,match_date,participant_a,participant_b,score_a,score_b,winner,source,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)',(sport,competition,season,date,str(a),str(b),sa,sb,winner,source,json.dumps(raw,ensure_ascii=False) if raw is not None else None))
        count[sport]+=1
    for p in sorted((RAW/'football').glob('*/*.json')):
        try:
            obj=json.loads(p.read_text(encoding='utf-8'))
            competition=obj.get('name',p.parent.name)
            season=p.stem
            for m in obj.get('matches',[]):
                sc=(m.get('score') or {}).get('ft')
                if not sc or len(sc)<2 or sc[0] is None or sc[1] is None: continue
                a,b=m.get('team1'),m.get('team2')
                winner=a if sc[0]>sc[1] else b if sc[1]>sc[0] else 'draw'
                add('football',competition,season,m.get('date'),a,b,float(sc[0]),float(sc[1]),winner,str(p.relative_to(ROOT)),m)
        except (OSError,ValueError,TypeError): pass
    for p in sorted((RAW/'tennis').glob('*/*.csv')):
        try:
            with p.open(encoding='utf-8-sig',newline='') as f:
                for row in csv.DictReader(f):
                    winner=row.get('winner_name') or row.get('Winner') or row.get('winner')
                    loser=row.get('loser_name') or row.get('Loser') or row.get('loser')
                    if not winner or not loser: continue
                    date=row.get('tourney_date') or row.get('Date') or row.get('date')
                    date=str(date) if date else p.stem[-4:]
                    add('tennis',row.get('tourney_name') or row.get('Tournament') or p.parent.name,p.stem[-4:],date,winner,loser,1.0,0.0,winner,str(p.relative_to(ROOT)),row)
        except (OSError,UnicodeError,csv.Error): pass
    for zpath in sorted((RAW/'basketball').glob('*.zip')):
        try:
            with zipfile.ZipFile(zpath) as z:
                for name in z.namelist():
                    if not name.lower().endswith('.csv') or not any(k in name.lower() for k in ('game','match')): continue
                    with z.open(name) as f:
                        import io
                        reader=csv.DictReader(io.TextIOWrapper(f,encoding='utf-8-sig',errors='replace'))
                        for row in reader:
                            low={str(k).lower().strip():v for k,v in row.items() if k is not None}
                            a=next((low[k] for k in ('home_team','team_home','hometeam','team1','home') if low.get(k)),None)
                            b=next((low[k] for k in ('away_team','team_away','awayteam','team2','away') if low.get(k)),None)
                            sa=next((low[k] for k in ('home_score','score_home','pts_home','team1_score') if low.get(k)),None)
                            sb=next((low[k] for k in ('away_score','score_away','pts_away','team2_score') if low.get(k)),None)
                            date=next((low[k] for k in ('game_date','date','game_day') if low.get(k)),None)
                            try: sa,sb=float(sa),float(sb)
                            except (TypeError,ValueError): continue
                            if not a or not b: continue
                            winner=a if sa>sb else b if sb>sa else 'draw'
                            add('basketball',low.get('league','NBA'),str(date or '')[:4],date,a,b,sa,sb,winner,zpath.name,low)
        except (OSError,zipfile.BadZipFile): pass
    db.commit()
    total=db.execute('SELECT COUNT(*) FROM matches').fetchone()[0]
    by_sport=dict(db.execute('SELECT sport, COUNT(*) FROM matches GROUP BY sport').fetchall())
    db.execute('CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    metadata={'built_at_utc':datetime.now(timezone.utc).isoformat(),'total_matches':str(total),'counts_by_sport':json.dumps(by_sport),'warning':'Coverage depends on upstream datasets. Not all global matches or historical odds are included.'}
    db.executemany('INSERT INTO metadata VALUES(?,?)',metadata.items())
    db.commit(); db.close()
    print(json.dumps({'database':str(OUT.relative_to(ROOT)),'total_matches':total,'counts_by_sport':by_sport}))
    if total==0: raise SystemExit('No normalized matches were found; inspect the manifest and source schemas.')
if __name__=='__main__': main()
