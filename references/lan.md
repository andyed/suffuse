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

Contrast with `razer` on the same socket: 60 Hz sustained, 480 frames, no
backlog (H608B, 2026-08-23; H61D3, 2026-09-05). The ceiling is a property of
the *command*, not the hardware. Razer rates are per SKU: the H612B and H16C0
are stop-tested clean at 40 Hz and not yet probed at 60, and the H6056 is held at 40 as
the lower figure (repeated camera stop-tests on 2026-11-11 found no difference between 40
and 60 Hz, and an erratic settle time at both; see [device-evidence.md](device-evidence.md)), so
`RAZER_PROFILES.maxHz` holds each SKU at its own verified rate under the
60 Hz roof (`RAZER_MAX_HZ`), and `razerMinFrameGapMs()` gives the gap a
sender must keep. A frame due sooner is dropped, never queued.

**Gate on a schedule, not on time since the last send.** A sender that drops a frame when
less than the gap has passed since its last send loses about 40% of its frames once its
renderer ticks at the fixture's own rate, because every late tick makes the next one look
early. Measured 2026-11-11 on two native transports: 18.5 Hz delivered from a 30 Hz loop at a
30 Hz cap, 35.7 from 60 at 60. Giving each fixture a schedule (next slot = this slot + gap)
and letting a frame arrive a quarter gap early delivered 30.0 and 59.7–60.0, with no two
frames closer than three quarters of the gap. `razerMinFrameGapMs()` is the gap; how a sender
keeps it is the sender's choice, and this is the choice that works.

**Run a stop-test more than once.** On the H6056 a single run per rate ranked 60 Hz as
slower than 40; twenty-six more runs, across two transports, did not. A fixture whose settle time scatters needs
repeats before one rate is called worse than another.

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

## `devStatus` replies carry no device identity — filter by sender address

All devices answer to the one shared reply port (:4002), and the devStatus
payload names no device. Found by a cold-room agent run (2026-08-18):
sequential polls of two fixtures cross-attributed replies, which matters
beyond diagnostics because the pre-write capture uses this read — a receipt
could record the WRONG device's state as its restore point. `lanDevStatus`
now drops any reply whose `rinfo.address` is not the polled device. The
sender address is the only identity this channel has.

## One `devStatus` ask is not enough

A UDP reply on Wi-Fi can be late or lost outright. Measured on a Windows box
with six LAN lamps (psychodeli-webgl-port, 2026-10-17): a capture that asked
once and waited 900 ms came up with 2, and on another start 5, of the six
lamps "offline". The same lamps had answered the discovery scan seconds
before, and a second attempt always captured them. A longer single window
does nothing for a lost packet.

`lanDevStatusRead` therefore asks up to three times, 900 ms apart, and
accepts a late reply to an earlier ask: nothing but `devStatus` goes to the
lamp while it is read, so its state cannot have moved between asks. The read
resolves the moment a reply lands, so a prompt lamp costs tens of
milliseconds, and the worst case (2.7 s) is inside the old single 3 s window.
The `lan paint` receipt's capture event records `asksSent`, and
`answeredOnAsk` when a lamp needed more than one ask. A lamp that answered
discovery but none of three asks points at the host before the lamp; on
Windows, see the firewall section below.

## White-temperature mode reports RGB as black — never replay it

A device in CCT mode (the H608B at 3600 K in the same cold-room run) reports
`color: {0,0,0}` alongside `colorTemInKelvin`. A restore that replays the
captured RGB verbatim sends the lamp to BLACK. `lanRestoreOperations` prefers
Kelvin when present and treats black-RGB-with-no-Kelvin as unknown rather
than replayable state. Related observation from the same run, unconfirmed
mechanism: LAN `brightness` visibly landed on the H612B but H6047/H608B kept
reporting their prior value across multiple distinct requests — either those
SKUs ignore the LAN brightness command in CCT mode or devStatus reports a
different channel; the mute-channel rule applies (only eyes can promote
either reading to fact).

Follow-up, 2026-11-11, which favours a third reading — the commands were dropped.
On six lamps (H608B, H612B, H16C0, H61D3, H610A, H6056) `colorwc` and `brightness`
sent 0.3 s apart and then read back with `devStatus` matched on every lamp, in RGB
and in Kelvin mode, over dozens of writes; a lamp that did not match was resent and
then did. The same commands sent back to back did not: after a colour, power,
brightness burst, 1 of 5 lamps reported what was sent. So `devStatus` does report
LAN brightness on the H608B, and a value that "kept its prior" is more likely a
command the lamp never took than one it ignored. The enable frame is lost the same
way; see the evidence table in [lan-razer.md](lan-razer.md).

## Multicast discovery is intermittent — per device

The documented multicast scan to `239.255.255.250:4001` returned nothing on
the reference LAN while the byte-identical payload sent **unicast** answered
immediately; forty minutes later multicast worked. Intermittent is worse than
broken: a multicast-only implementation works on one machine and fails on
another, and intermittency is **per device**, so returning early after the
first multicast hit silently treats "found a lamp" as "found every lamp" —
a real bug, caught while hunting for a second lamp. Scan multicast first
(fast, one packet), then **always** sweep unicast; never stop early.

## Windows Firewall drops `devStatus` replies for a program without an Allow rule

`devStatus` replies come from the lamp's ephemeral port to :4002, so to the
host's firewall they are unsolicited inbound UDP. Windows gives a program
path it has not seen before inbound **Block** rules the moment its firewall
prompt appears, and flips them to Allow only when the user clicks Allow.
Until then discovery still works (Windows lets unicast replies to a multicast
scan through for about 3 s), but no state read does. Measured on a Windows box
(psychodeli-webgl-port, 2026-10-17): 6 of 6 LAN lamps discovered, 0 of 36
`devStatus` asks answered while blocked.

This applies to Suffuse itself: the program the rule names is the `node`
executable that runs the CLI or MCP server, so a new Node install or version
manager path starts out blocked. The signature is **every lamp found, none
captured**, which reads like a room of broken lamps and is the host instead.
The firewall event log dates the rule:
`Microsoft-Windows-Windows Firewall With Advanced Security/Firewall`, events
2097/2099, where Action 2 is block and 3 is allow. Fix it with an inbound
Allow rule for that `node` path (or by answering the prompt), then read
again.

## One process owns the reply port

UDP 4002 is where every device replies. Two listeners silently steal each
other's replies — measurements taken with a second controller running are
invalid, and port sharing does not fix it. Fail loudly when 4002 is taken
(`scripts/lan.mjs` does; so does the verification harness).

The same rule holds inside one process. Two reads that each bind first
either collide (the second fails and blames "another controller" for its own
sibling) or, with `reuseAddr`, split the lamps' replies so a capture reads a
live lamp as silent (psychodeli-webgl-port, 2026-10-17). `acquireReplySocket`
gives concurrent callers in a process one shared bind; each attaches its own
listener, and every reader already filters by command and sender address. The
last caller out closes the socket. Another process on the port still fails
loudly.
