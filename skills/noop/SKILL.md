# noop

M0 placeholder skill. Does not trade.

For every tick the host sends, this skill replies with a `noop` message
carrying the matching `tick_id`. Used to verify the python-host stdio
loop, the in-flight gate, the timeout policy, and the heartbeat `ticks`
table — see plan §9 M1 verification.

Disable this skill (set `enabled: false` in `runtime.yaml`) once
`funding-arb` is the active skill.
