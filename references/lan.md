# The documented LAN API — measured behavior

The documented Govee LAN API (`scan` on 4001, replies on 4002, commands on
4003) looks simple; its failure modes are not. Everything below was measured
against physical hardware (Psychodeli reference room, 2026-08) and is what
`scripts/lan.mjs` already encodes — this page carries the numbers and the
methods so the facts can be re-verified on new hardware, not just trusted.
The per-LED `razer` channel has its own page: [lan-razer.md](lan-razer.md).

## `colorwc` queues — it does not drop

The lamp buffers whole-device colour commands without bound. Measured by
making the **red channel a packet sequence number**, so `devStatus` readback
reports exactly which packet the lamp is displaying:

| Send rate | Lag 900 ms after burst ends | Verdict |
|---|---|---|
| 5 Hz | 0 packets | keeps up |
| 10 Hz | 1 packet (~100 ms) | keeps up |
| 20 Hz | **30 packets (~1.5 s behind)** | queue grows without bound |

Drain rate is **~10–12 commands/s**. Newest-wins is *not* the behavior: a 4 s
burst at 20 Hz needed 3.6 s to catch up **after sending stopped**. An
unthrottled send loop doesn't look coarse — it puts the room progressively
behind, potentially minutes. Hence a hard ~8 Hz ceiling plus change deadbands:
the cheapest packet is the one never sent.

Contrast with `razer` on the same socket: 40 Hz sustained, 400 frames, no
backlog (H608B). The ceiling is a property of the *command*, not the hardware.

**The stop-test method** (how "no queue" is proven): stream a travelling hue
sweep, count down, stop dead *without* sending a black frame. The last frame
stays lit, so the only thing that can still move is backlog. Judge by motion
halting, not by the lamp going dark — an off-instant is easy to mis-time; a
sweep that keeps travelling is unmistakable.

## `devStatus` lies while you are sending

Replies queue too. Polling `devStatus` during or shortly after a send burst
returns **stale replies that read as failed writes** — this produced one
false "restore failed" diagnosis before it was understood. To read real
state: stop sending, wait out the drain (~6 s), then poll. State capture is
therefore slow by construction and must never run inside a send loop.

## Multicast discovery is intermittent — per device

The documented multicast scan to `239.255.255.250:4001` returned nothing on
the reference LAN while the byte-identical payload sent **unicast** answered
immediately; forty minutes later multicast worked. Intermittent is worse than
broken: a multicast-only implementation works on one machine and fails on
another, and intermittency is **per device**, so returning early after the
first multicast hit silently treats "found a lamp" as "found every lamp" —
a real bug, caught while hunting for a second lamp. Scan multicast first
(fast, one packet), then **always** sweep unicast; never stop early.

## One process owns the reply port

UDP 4002 is where every device replies. Two listeners silently steal each
other's replies — measurements taken with a second controller running are
invalid, and port sharing does not fix it. Fail loudly when 4002 is taken
(`scripts/lan.mjs` does; so does the verification harness).
