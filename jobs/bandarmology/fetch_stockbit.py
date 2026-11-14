#!/usr/bin/env python3
"""Bandarmology — fetch Stockbit inputs into a local cache (runs on the openclaw server).

Why here and not in the Lambda: LPM needs Stockbit's GROSS broker summary with
trade counts, and Stockbit needs a personal login token (renewed by hand every
24h with stockbit_ensure_token.py). This script only ever calls Stockbit through
the server's existing client (idx_common.stockbit_get), so it never reads or
handles the token itself.

Cache layout (BANDARMOLOGY_CACHE, default /root/bandarmology-cache):
  universe.json          {"asOf", "rule", "hscFrom", "codes": [...]}   which stocks, most traded first;
                         rebuilt monthly, when the rule changes, or when IDX's HSC list does
  hist/CODE.json         {date: daily row}          Stockbit daily history (~500 calendar days)
  bs/CODE/DATE.json      {"buy": [...], "sell": [...]}  regular-market gross broker summary
  actions/CODE.json      [{"date", "ratio", "type"}]    splits / reverse splits / rights issues
  status.json            what the last run did, or why it stopped

Universe: the TOP most-traded stocks (any board, HSC or not), plus every other
stock that is NOT on IDX's High Shareholding Concentration list and traded on at
least MIN_TRADED_DAYS of the last ~60 sessions. The big-money calculation needs a
real spread of trades, so stocks that seldom trade are left out. The HSC list in
force comes from backend/lib/ihsg-rules.js through hsc.mjs.

Usage: fetch_stockbit.py [--sessions 126] [--top 100] [--codes BBCA,TLKM]
Exit codes: 0 ok, 3 Stockbit login expired (renew the token), 1 anything else.
"""
import argparse, datetime as dt, json, os, re, subprocess, sys, time

SCRIPTS = os.environ.get('STOCKBIT_SCRIPTS', '/root/.openclaw/workspace/skills/stockbit/scripts')
CACHE = os.environ.get('BANDARMOLOGY_CACHE', '/root/bandarmology-cache')
TICKERS_JS = os.environ.get('TICKERS_JS', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'backend', 'lib', 'tickers.js'))
PAUSE = 1.1           # seconds between Stockbit calls
HIST_DAYS = 520       # calendar days of daily history: 200-session window + ~6 months + slack
REFRESH_TAIL = 10     # re-fetch the last N days of history each run (late corrections)
UNIVERSE_MAX_AGE = 30 # days before the universe is re-ranked
MIN_TRADED_DAYS = 40  # of the ~60 sessions in the 95-day ranking window
RULE = 'top{top}+non-hsc-traded{days}'

sys.path.insert(0, SCRIPTS)
import idx_common as C  # noqa: E402  (the server's Stockbit client)


class LoginExpired(Exception):
    pass


def get(path, params=None):
    time.sleep(PAUSE)
    try:
        return C.stockbit_get(path, params) or {}
    except Exception as e:  # idx_common raises IdxError; a 401 after its own retry = expired login
        text = f'{type(e).__name__}: {e}'
        if '401' in text or 'auth' in text.lower() or 'login' in text.lower() or 'token' in text.lower():
            raise LoginExpired(text.split(':')[0])
        raise


def load(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(obj, f, separators=(',', ':'))
    os.replace(tmp, path)


def fetch_history(code, start, end):
    """Daily rows from start to end. Stockbit rejects long ranges (HTTP 400), so ask ~half a year at a time."""
    out = {}
    lo = dt.date.fromisoformat(start)
    stop = dt.date.fromisoformat(end)
    while lo <= stop:
        hi = min(stop, lo + dt.timedelta(days=180))
        page = 1
        while True:
            r = (get(f'/company-price-feed/historical/summary/{code}',
                     {'period': 'HS_PERIOD_DAILY', 'start_date': lo.isoformat(), 'end_date': hi.isoformat(), 'limit': 50, 'page': page})
                 .get('data') or {}).get('result') or []
            for q in r:
                out[q['date']] = {k: q.get(k) for k in ('open', 'high', 'low', 'close', 'volume', 'frequency', 'value', 'net_foreign')}
            if len(r) < 50:
                break
            page += 1
        lo = hi + dt.timedelta(days=1)
    return out


def update_history(code, today):
    path = os.path.join(CACHE, 'hist', f'{code}.json')
    hist = load(path, {})
    first = (today - dt.timedelta(days=HIST_DAYS)).isoformat()
    if not hist or min(hist) > first:
        hist.update(fetch_history(code, first, today.isoformat()))
    else:
        tail = (today - dt.timedelta(days=REFRESH_TAIL)).isoformat()
        hist.update(fetch_history(code, tail, today.isoformat()))
    hist = {d: v for d, v in hist.items() if d >= first}
    save(path, hist)
    return hist


def fetch_summary(code, date):
    r = get(f'/marketdetectors/{code}', {
        'transaction_type': 'TRANSACTION_TYPE_GROSS', 'market_board': 'MARKET_BOARD_REGULER',
        'investor_type': 'INVESTOR_TYPE_ALL', 'limit': 100, 'from': date, 'to': date}).get('data') or {}
    bs = r.get('broker_summary') or {}
    side = lambda rows, lot, val: [[q.get('netbs_broker_code'), abs(int(float(q[lot]))), int(float(q['freq'])), abs(float(q.get(val) or 0))]
                                   for q in rows or [] if float(q.get('freq') or 0) > 0]
    return {'buy': side(bs.get('brokers_buy'), 'blot', 'bval'), 'sell': side(bs.get('brokers_sell'), 'slot', 'sval')}


def fetch_actions(code):
    items = get(f'/corpaction/{code}', {'limit': 30}).get('data') or []
    if isinstance(items, dict):
        items = items.get('corpaction') or next(iter(items.values()), [])
    out = []
    for it in items or []:
        kind = it.get('action_type')
        info = (it.get('action_info') or {}).get(kind) or {}
        if kind in ('stocksplit', 'stock_reverse'):
            date, ratio = info.get('stocksplit_exdate'), info.get('stocksplit_factor')
        elif kind == 'rightissue':
            # The price-adjustment factor; 0 means Stockbit did not adjust history for it.
            date, ratio = info.get('rightissue_exdate'), info.get('rightissue_adj_factor')
        else:
            continue
        try:
            ratio = float(ratio)
        except (TypeError, ValueError):
            continue
        if date and ratio > 0 and ratio != 1:
            out.append({'date': date[:10], 'ratio': ratio, 'type': kind})
    return sorted(out, key=lambda a: a['date'])


def hsc_list(today):
    """The HSC list in force today, from the one copy of it (backend/lib/ihsg-rules.js)."""
    here = os.path.dirname(os.path.abspath(__file__))
    out = subprocess.run(['node', os.path.join(here, 'hsc.mjs'), today.isoformat()],
                         capture_output=True, text=True, check=True, timeout=60).stdout
    return json.loads(out)


def rebuild_universe(today, top, hsc):
    codes = sorted(set(re.findall(r"'([A-Z]{4})'", open(TICKERS_JS).read())))
    start = (today - dt.timedelta(days=95)).isoformat()
    ranked = []
    for i, code in enumerate(codes):
        try:
            h = fetch_history(code, start, today.isoformat())
        except LoginExpired:
            raise
        except Exception:
            continue
        vals = sorted(v['value'] or 0 for v in h.values() if (v.get('frequency') or 0) > 0)
        if len(vals) >= MIN_TRADED_DAYS:
            ranked.append((vals[len(vals) // 2], code))
        if i % 100 == 0:
            print(f'universe: ranked {i}/{len(codes)}', flush=True)
    ranked.sort(reverse=True)
    excluded = set(hsc['tickers'])
    # Most traded first, so a long first back-fill fills the page from the top.
    picked = [c for n, (_, c) in enumerate(ranked) if n < top or c not in excluded]
    uni = {'asOf': today.isoformat(), 'rule': RULE.format(top=top, days=MIN_TRADED_DAYS), 'hscFrom': hsc['from'], 'codes': picked}
    save(os.path.join(CACHE, 'universe.json'), uni)
    print(f'universe: {len(picked)} stocks ({min(top, len(ranked))} most traded + non-HSC trading most days)', flush=True)
    return uni


def stale(uni, today, top, hsc):
    return (not uni or (today - dt.date.fromisoformat(uni['asOf'])).days > UNIVERSE_MAX_AGE
            or uni.get('rule') != RULE.format(top=top, days=MIN_TRADED_DAYS) or uni.get('hscFrom') != hsc['from'])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--sessions', type=int, default=126, help='broker-summary sessions to keep per stock')
    ap.add_argument('--top', type=int, default=100, help='most-traded stocks kept even when on the HSC list')
    ap.add_argument('--codes', help='comma-separated codes instead of the ranked universe (testing)')
    a = ap.parse_args()
    today = dt.date.today()
    status = {'startedAt': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'), 'ok': False}
    try:
        if a.codes:
            codes = a.codes.split(',')
        else:
            uni = load(os.path.join(CACHE, 'universe.json'), None)
            hsc = hsc_list(today)
            if stale(uni, today, a.top, hsc):
                uni = rebuild_universe(today, a.top, hsc)
            codes = uni['codes']
        fetched = 0
        for n, code in enumerate(codes, 1):
            hist = update_history(code, today)
            traded = sorted(d for d, v in hist.items() if (v.get('frequency') or 0) > 0)
            act_path = os.path.join(CACHE, 'actions', f'{code}.json')
            if not os.path.exists(act_path) or (time.time() - os.path.getmtime(act_path)) > UNIVERSE_MAX_AGE * 86400:
                save(act_path, fetch_actions(code))
            for date in traded[-a.sessions:]:
                p = os.path.join(CACHE, 'bs', code, f'{date}.json')
                if os.path.exists(p):
                    continue
                save(p, fetch_summary(code, date))
                fetched += 1
            print(f'{n}/{len(codes)} {code}: {len(traded)} sessions of history, broker summaries fetched so far {fetched}', flush=True)
        status.update(ok=True, codes=len(codes), summariesFetched=fetched)
        return 0
    except LoginExpired as e:
        status.update(error='Stockbit login expired — renew it with stockbit_ensure_token.py', detail=str(e))
        print(status['error'], file=sys.stderr)
        return 3
    except Exception as e:
        status.update(error=f'{type(e).__name__}: {e}'[:300])
        print(status['error'], file=sys.stderr)
        return 1
    finally:
        status['finishedAt'] = dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')
        save(os.path.join(CACHE, 'status.json'), status)


if __name__ == '__main__':
    sys.exit(main())
