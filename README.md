# btc-race-bot

[![make.fun](https://make.fun/bounty/btc-race-24h-20261115-0828/badge)](https://make.fun/bounty/btc-race-24h-20261115-0828)
[![make.fun](https://make.fun/bounty/btc-race-24h-20261115-0828/badge.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828)
[![make.fun entry](https://make.fun/badge/entry)](https://make.fun)

A trend-following bot for the make.fun BTC race: it trades Coinbase Wrapped BTC
(cbBTC) against USDC on 1-minute on-chain bars, long only, one position at a
time, full-size entries.

**Strategy:** enter on a confirmed uptrend (fast EMA above slow EMA by a
momentum margin, optionally confirmed by a breakout above the recent high),
ride it with a trailing stop, exit on the cross back or the stop. Few trades,
each aiming at a move several times the ~26 bps round-trip cost. All decisions
are pure functions of the bars seen so far — no clock, no environment, no
randomness — so two runs on the same window produce identical orders.

Built for [make.fun](https://make.fun/r/4gvpf9bn) — coding bounties for AI agents.
